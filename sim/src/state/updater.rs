// ============================================================================
// UPDATER: the one background thread that keeps our copy current.
//
// Plain English - the loop, in order of priority:
//   1. FEED MESSAGES (the main source of truth). For the next message in
//      sequence order: replay its transactions locally (feed/replay.rs).
//        - Replayed exactly -> publish the new version. No node call.
//        - A transaction needs an item we don't have -> fetch the items
//          AS OF THE BLOCK BEFORE this message (cheap public node first),
//          add them to the copy, replay the message again from the start.
//          The copy is "dirty" (checks at/after this block answer
//          "unknown: dirty") until it succeeds. Measured: dirty_events,
//          dirty_ms_total.
//        - Something we can't replay (BLOCKHASH, a Nitro built-in we don't
//          imitate, a deposit/L1 message, a weird tx) -> ask a paid node for
//          its own list of what the block changed (one debug_trace call) and
//          apply that for the accounts we hold. Never a guess.
//      If the node can't help right now (budget used up, node down, block
//      not there yet), we wait and retry; checks keep answering "dirty",
//      never wrong. After ARBSIM_MAX_FILL_ROUNDS failed rounds, or if a
//      block can't be repaired, the copy RESTARTS (see 4).
//   2. GAPS. Messages arrive out of order sometimes; we wait
//      ARBSIM_GAP_WAIT_MS for the missing ones. Still missing (dropped
//      frames, reconnects) -> repair a small gap block by block from node
//      traces (<= ARBSIM_GAP_TRACE_MAX blocks); a bigger gap restarts.
//   3. FILLS (when no message is waiting): items checks missed / the bot
//      warmed, fetched at the newest block the node has that we still keep,
//      fitted in with reconciliation (state/fill.rs).
//   4. RESTART ("resync"): forget all accounts (code is kept: it never
//      changes for a given hash), start again at the next message, re-queue
//      the warm list. Everything is fetched again lazily.
//   5. VERIFY (optional, budgeted): every ARBSIM_VERIFY_EVERY_N_BLOCKS-th
//      block (but at most once per ARBSIM_VERIFY_MIN_INTERVAL_S), fetch the
//      node's trace and compare it with our replay on what we hold.
//      Match -> replay_match. Mismatch -> replay_mismatch, first 20 logged,
//      the affected accounts are corrected from the node's diff where it
//      tells the exact new value, otherwise forgotten (refetched on demand).
//      Gas-fee receivers (balance-only mismatches) are learned and their
//      ETH balance is never trusted again.
//   6. Upkeep: block header every ARBSIM_HEADER_EVERY_S (base fee, and a
//      cross-check that block = sequenceNumber + ARBSIM_L2_BLOCK_OFFSET),
//      memory cap / idle eviction.
//
// The whole thing is testable with a fake node (NodeApi trait).
// ============================================================================
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use revm::primitives::{Address, B256, U256};
use rustc_hash::FxHashMap;

use super::diff::{compare, merge, parse_block_trace};
use super::fill::{reconcile, rewrite_from, FillQueue};
use super::mirror::{Shared, Stats, Version};
use super::snap::{Fact, Snapshot};
use super::{AccountDiff, MissItem, StateDiff, StatePosition};
use crate::arb::{self, BlockCtx};
use crate::feed::frame::{parse_frame, FeedMessage};
use crate::feed::replay::{message_ctx, replay_message, MsgOutcome, ReplayEnv};
use crate::node::{self, fetch_items, Class, Fetched, ItemErr, NodeErr};

/// Messages the updater thread receives.
pub enum Input {
    /// A raw feed frame (as the bot got it from the websocket).
    Frame(String),
    /// Items to fetch (from a check's miss, or `warm`).
    Fill(Vec<MissItem>),
    Warm(Vec<MissItem>),
    /// Accounts a check used (keeps them from being evicted).
    Touched(Vec<Address>),
    Stop,
}

/// Handle for sending input; bounded so nothing can grow without limit.
#[derive(Clone)]
pub struct UpdaterHandle {
    tx: SyncSender<Input>,
    shared: Arc<Shared>,
}

impl UpdaterHandle {
    /// Forward a feed frame. Never blocks: if the updater is badly behind,
    /// the frame is dropped and counted (the gap logic then repairs it).
    pub fn frame(&self, text: String) {
        Stats::inc(&self.shared.stats.frames);
        {
            let mut p = self.shared.published.write().unwrap();
            p.last_frame = Some(Instant::now());
        }
        if self.tx.try_send(Input::Frame(text)).is_err() {
            Stats::inc(&self.shared.stats.frames_dropped);
        }
    }
    pub fn fill(&self, items: Vec<MissItem>) {
        if !items.is_empty() {
            let _ = self.tx.try_send(Input::Fill(items));
        }
    }
    pub fn warm(&self, items: Vec<MissItem>) {
        if !items.is_empty() {
            let _ = self.tx.try_send(Input::Warm(items));
        }
    }
    pub fn touched(&self, a: Vec<Address>) {
        if !a.is_empty() {
            let _ = self.tx.try_send(Input::Touched(a));
        }
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Input::Stop);
    }
}

/// How far a message got.
enum Step {
    /// Published.
    Done,
    /// Progress (node data added): replay again right away.
    Again,
    /// Can't finish now; try again later (node busy / block not there yet).
    Retry(String),
    /// Can't be repaired: restart the copy.
    Restart(String),
}

/// The updater's own (private) state.
pub struct Updater {
    sh: Arc<Shared>,
    rx: Receiver<Input>,
    env: ReplayEnv,
    fills: Arc<FillQueue>,
    /// Messages received, not yet replayed (by seq), capped.
    pending: BTreeMap<u64, FeedMessage>,
    /// Next seq to replay (None = start at the first one that arrives).
    next_seq: Option<u64>,
    /// Message that is waiting for node data, and how many rounds it took.
    rounds: usize,
    /// When we first saw the next message missing (gap detection).
    gap_since: Option<Instant>,
    /// Base fee to use for replay (from the newest header we fetched).
    basefee: u64,
    last_header: Option<Instant>,
    last_verify: Option<Instant>,
    last_evict: Instant,
    /// When each account was last used (seconds since start).
    last_used: FxHashMap<Address, u64>,
    mismatch_logged: u64,
    retry_after: Option<Instant>,
    last_retry_reason: String,
}

/// Start the updater thread. Returns the handle to feed it.
pub fn spawn(sh: Arc<Shared>, fills: Arc<FillQueue>) -> UpdaterHandle {
    // Room for ~a few seconds of feed at full speed; overflow is dropped
    // and counted (bounded memory).
    let (tx, rx) = std::sync::mpsc::sync_channel(4096);
    let mut u = Updater::new(sh.clone(), rx, fills);
    std::thread::Builder::new().name("arbsim-updater".into()).spawn(move || u.run()).expect("updater thread");
    UpdaterHandle { tx, shared: sh }
}

/// For tests: an updater driven by hand (no thread).
pub fn manual(sh: Arc<Shared>, fills: Arc<FillQueue>) -> (Updater, UpdaterHandle) {
    let (tx, rx) = std::sync::mpsc::sync_channel(4096);
    (Updater::new(sh.clone(), rx, fills), UpdaterHandle { tx, shared: sh })
}

impl Updater {
    fn new(sh: Arc<Shared>, rx: Receiver<Input>, fills: Arc<FillQueue>) -> Self {
        Updater {
            sh,
            rx,
            env: ReplayEnv::default(),
            fills,
            pending: BTreeMap::new(),
            next_seq: None,
            rounds: 0,
            gap_since: None,
            basefee: 0,
            last_header: None,
            last_verify: None,
            last_evict: Instant::now(),
            last_used: FxHashMap::default(),
            mismatch_logged: 0,
            retry_after: None,
            last_retry_reason: String::new(),
        }
    }

    fn now_s(&self) -> u64 {
        self.sh.started.elapsed().as_secs()
    }

    /// Main loop (runs until Stop).
    pub fn run(&mut self) {
        loop {
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(i) => self.input(i),
                Err(RecvTimeoutError::Timeout) => {}
            }
            // Drain whatever else is waiting (cheap), then do work.
            while let Ok(i) = self.rx.try_recv() {
                if matches!(i, Input::Stop) {
                    return;
                }
                self.input(i);
            }
            self.work();
        }
    }

    /// Take everything waiting in the input queue, then work (tests drive
    /// the updater with this instead of the thread).
    pub fn pump(&mut self) {
        while let Ok(i) = self.rx.try_recv() {
            self.input(i);
        }
        self.work();
    }

    /// Handle one input.
    pub fn input(&mut self, i: Input) {
        match i {
            Input::Frame(t) => self.on_frame(&t),
            Input::Fill(items) => {
                Stats::add(&self.sh.stats.miss_items_queued, items.len() as u64);
                self.fills.push(items);
            }
            Input::Warm(items) => {
                Stats::add(&self.sh.stats.warm_items, items.len() as u64);
                for it in &items {
                    if let MissItem::Account(a) | MissItem::Slot(a, _) = it {
                        self.last_used.insert(*a, self.now_s());
                    }
                }
                self.fills.warm(items);
            }
            Input::Touched(a) => {
                let now = self.now_s();
                for x in a {
                    self.last_used.insert(x, now);
                }
            }
            Input::Stop => {}
        }
    }

    fn on_frame(&mut self, text: &str) {
        let msgs = match parse_frame(text) {
            Ok(m) => m,
            Err(_) => {
                Stats::inc(&self.sh.stats.frames_bad);
                return;
            }
        };
        for m in msgs {
            Stats::inc(&self.sh.stats.msgs_received);
            let head = self.next_seq.map(|n| n.saturating_sub(1));
            if self.next_seq.is_some_and(|n| m.seq < n) || self.pending.contains_key(&m.seq) {
                Stats::inc(&self.sh.stats.msgs_duplicate);
                continue;
            }
            let _ = head;
            if self.pending.len() >= self.sh.cfg.max_pending {
                // Hopelessly behind: drop the newest; the gap logic restarts.
                Stats::inc(&self.sh.stats.frames_dropped);
                continue;
            }
            {
                let mut p = self.sh.published.write().unwrap();
                p.received_seq = Some(p.received_seq.map_or(m.seq, |r| r.max(m.seq)));
            }
            self.pending.insert(m.seq, m);
        }
    }

    /// Do as much work as is ready right now.
    pub fn work(&mut self) {
        self.upkeep_header();
        // 1 + 2: messages.
        let mut budget_steps = 64; // don't starve the input queue
        while budget_steps > 0 {
            budget_steps -= 1;
            if self.retry_after.is_some_and(|t| Instant::now() < t) {
                break;
            }
            let Some(seq) = self.next_ready() else { break };
            let msg = self.pending.get(&seq).cloned().unwrap();
            match self.process(&msg) {
                Step::Done => {
                    self.pending.remove(&seq);
                    self.next_seq = Some(seq + 1);
                    self.rounds = 0;
                    self.retry_after = None;
                    self.clean_dirty();
                    self.maybe_verify();
                }
                Step::Again => {
                    // Fetched what it needed: replay again now (still a round,
                    // so a message that keeps needing more can't loop forever).
                    self.rounds += 1;
                    self.mark_dirty();
                    if self.rounds >= self.sh.cfg.max_fill_rounds {
                        self.restart(&format!("block for seq {seq} still needs more items after {} rounds", self.rounds));
                        break;
                    }
                }
                Step::Retry(why) => {
                    self.rounds += 1;
                    self.mark_dirty();
                    if self.rounds >= self.sh.cfg.max_fill_rounds {
                        self.restart(&format!("block for seq {seq} still incomplete after {} rounds ({why})", self.rounds));
                    } else {
                        // Back off a little (node busy / not caught up).
                        let ms = (100u64 << self.rounds.min(5)).min(3000);
                        self.retry_after = Some(Instant::now() + Duration::from_millis(ms));
                        if why != self.last_retry_reason {
                            eprintln!("[arbsim] seq {seq}: waiting for node ({why})");
                            self.last_retry_reason = why;
                        }
                    }
                    break;
                }
                Step::Restart(why) => {
                    self.restart(&why);
                    break;
                }
            }
        }
        // 3: fills, only when no message is waiting to be replayed.
        if self.next_ready().is_none() && !self.fills.is_empty() {
            self.do_fills();
        }
        // 6: memory.
        if self.last_evict.elapsed() > Duration::from_secs(30) {
            self.last_evict = Instant::now();
            self.evict();
        }
    }

    /// The next message to replay, if it's here; handles gaps.
    fn next_ready(&mut self) -> Option<u64> {
        let (&first, _) = self.pending.iter().next()?;
        let next = match self.next_seq {
            None => {
                // Very first message: start the copy right before it.
                self.start_at(first);
                first
            }
            Some(n) => n,
        };
        if first == next {
            self.gap_since = None;
            return Some(next);
        }
        // `next` is missing. Wait a little (out-of-order delivery).
        let since = *self.gap_since.get_or_insert_with(Instant::now);
        if since.elapsed() < Duration::from_millis(self.sh.cfg.gap_wait_ms) {
            return None;
        }
        let missing = first - next;
        Stats::inc(&self.sh.stats.gaps);
        self.mark_dirty();
        if missing <= self.sh.cfg.gap_trace_max && self.sh.node.is_some() {
            match self.repair_gap(next, first) {
                Ok(()) => {
                    self.gap_since = None;
                    return Some(first);
                }
                Err(e) => {
                    self.retry_after = Some(Instant::now() + Duration::from_millis(500));
                    if self.rounds >= self.sh.cfg.max_fill_rounds {
                        self.restart(&format!("feed gap {next}..{} not repairable: {e}", first - 1));
                    }
                    self.rounds += 1;
                    return None;
                }
            }
        }
        self.restart(&format!("feed gap of {missing} message(s) ({next}..{})", first - 1));
        None
    }

    /// Start (or restart) the copy so that `seq` is the next message.
    fn start_at(&mut self, seq: u64) {
        let codes = self.sh.head().map(|h| h.snap.codes.clone()).unwrap_or_default();
        let block = self.block_of(seq).saturating_sub(1);
        let snap = Snapshot {
            accounts: Default::default(),
            codes,
            pos: StatePosition { base_block: block, after_seq: seq.checked_sub(1) },
            volatile: self.sh.volatile.clone(),
        };
        let v = Version {
            seq: seq.saturating_sub(1),
            block,
            snap: Arc::new(snap),
            ctx: None,
            txs: vec![],
            diff: Arc::new(StateDiff::default()),
            restart: true,
            block_hash: None,
            applied: Instant::now(),
        };
        {
            let mut p = self.sh.published.write().unwrap();
            p.versions.clear();
            p.versions.push_back(Arc::new(v));
            p.stalled = None;
        }
        self.sh.epoch.fetch_add(1, Ordering::Relaxed);
        self.next_seq = Some(seq);
        self.rounds = 0;
        self.fills.requeue_warm();
        self.sh.notify();
    }

    fn restart(&mut self, why: &str) {
        Stats::inc(&self.sh.stats.restarts);
        eprintln!("[arbsim] restarting the copy: {why}");
        // Start again at the newest message we have (older ones are useless
        // to a fresh copy: everything is re-fetched at the block before it).
        let start = self.pending.keys().next_back().copied().or(self.next_seq).unwrap_or(0);
        self.pending.retain(|s, _| *s >= start);
        self.start_at(start);
        self.clean_dirty();
    }

    fn block_of(&self, seq: u64) -> u64 {
        arb::l2_block_for_seq(seq, self.sh.cfg.l2_offset)
    }

    fn mark_dirty(&self) {
        if self.sh.dirty_since_ms.load(Ordering::Relaxed) == 0 {
            self.sh.dirty_since_ms.store(self.sh.now_ms(), Ordering::Relaxed);
            Stats::inc(&self.sh.stats.dirty_events);
        }
    }

    fn clean_dirty(&self) {
        let since = self.sh.dirty_since_ms.swap(0, Ordering::Relaxed);
        if since > 0 {
            Stats::add(&self.sh.stats.dirty_ms_total, self.sh.now_ms().saturating_sub(since));
        }
    }

    /// Replay one message, fetching what it needs. Publishes on success.
    fn process(&mut self, msg: &FeedMessage) -> Step {
        let Some(prev) = self.sh.head() else { return Step::Restart("no base version".into()) };
        let block = self.block_of(msg.seq);
        let ctx = message_ctx(msg, prev.ctx.as_ref(), block, self.basefee);
        let pos = StatePosition { base_block: block, after_seq: Some(msg.seq) };
        match replay_message(&prev.snap, msg, &ctx, &self.env, pos) {
            MsgOutcome::Done { snap, txs, diff, touched, failed } => {
                Stats::inc(&self.sh.stats.msgs_replayed);
                Stats::add(&self.sh.stats.txs_replayed, txs.len() as u64);
                Stats::add(&self.sh.stats.txs_reverted, failed as u64);
                let now = self.now_s();
                for a in touched {
                    self.last_used.entry(a).or_insert(now);
                }
                self.publish(Version {
                    seq: msg.seq,
                    block,
                    snap,
                    ctx: Some(ctx),
                    txs,
                    diff: Arc::new(diff),
                    restart: false,
                    block_hash: msg.block_hash,
                    applied: Instant::now(),
                });
                Step::Done
            }
            MsgOutcome::NeedItems(items) => {
                Stats::inc(&self.sh.stats.need_item_rounds);
                // State BEFORE this message = end of the previous block.
                self.fetch_into_head(prev.block, &items, Class::Critical)
            }
            MsgOutcome::NeedTrace(why) => {
                Stats::inc(&self.sh.stats.need_trace);
                self.sh.note_trace_reason(&why);
                self.apply_trace(msg.seq, block, Some(ctx), msg.block_hash, &why)
            }
        }
    }

    /// Fetch items as of `block` and write them into the head version.
    fn fetch_into_head(&mut self, block: u64, items: &[MissItem], class: Class) -> Step {
        let Some(node) = self.sh.node.clone() else { return Step::Restart("needs node data but no node is configured".into()) };
        let (facts, unavailable, failed) = match fetch_facts(&*node, class, block, items) {
            Ok(x) => x,
            Err(NodeErr::Budget(e)) => return Step::Retry(format!("node budget: {e}")),
            Err(e) => return Step::Retry(e.to_string()),
        };
        if unavailable > 0 && facts.is_empty() {
            return Step::Retry(format!("node doesn't have block {block} yet"));
        }
        if failed > 0 && facts.is_empty() {
            return Step::Restart(format!("node refused {failed} item(s) at block {block}"));
        }
        Stats::add(&self.sh.stats.items_fetched, facts.len() as u64);
        {
            let mut p = self.sh.published.write().unwrap();
            if let Some(h) = p.versions.back().cloned() {
                if h.block == block {
                    let mut s = (*h.snap).clone();
                    for f in &facts {
                        s.apply_fact(f);
                    }
                    let n = p.versions.len();
                    p.versions[n - 1] = Arc::new(Version { snap: Arc::new(s), ..(*h).clone() });
                }
            }
        }
        if unavailable > 0 {
            Step::Retry(format!("{unavailable} item(s) not available yet at block {block}"))
        } else {
            Step::Again
        }
    }

    /// Use the node's own diff for block `block` (seq `seq`).
    fn apply_trace(&mut self, seq: u64, block: u64, ctx: Option<BlockCtx>, hash: Option<B256>, why: &str) -> Step {
        let Some(node) = self.sh.node.clone() else { return Step::Restart(format!("can't replay ({why}) and no node configured")) };
        let trace = match node::trace_block_diff(&*node, Class::Critical, block) {
            Ok(Some(t)) => t,
            Ok(None) => return Step::Retry(format!("node doesn't have block {block} yet")),
            Err(NodeErr::Budget(e)) => return Step::Retry(format!("node budget: {e}")),
            Err(e) => return Step::Retry(format!("trace: {e}")),
        };
        let per_tx = match parse_block_trace(&trace) {
            Ok(t) => t,
            Err(e) => return Step::Restart(format!("unreadable trace for block {block}: {e}")),
        };
        let mut merged = StateDiff::default();
        for t in &per_tx {
            merge(&mut merged, &t.diff);
        }
        let Some(prev) = self.sh.head() else { return Step::Restart("no base version".into()) };
        let mut s = (*prev.snap).clone();
        apply_node_diff(&mut s, &merged);
        s.pos = StatePosition { base_block: block, after_seq: Some(seq) };
        Stats::inc(&self.sh.stats.msgs_traced);
        self.publish(Version {
            seq,
            block,
            snap: Arc::new(s),
            ctx,
            txs: vec![], // per-tx states aren't rebuilt from a trace
            diff: Arc::new(merged),
            restart: false,
            block_hash: hash,
            applied: Instant::now(),
        });
        Step::Done
    }

    /// Repair missing blocks [from, to) from node traces, one by one.
    fn repair_gap(&mut self, from: u64, to: u64) -> Result<(), String> {
        for seq in from..to {
            if self.next_seq != Some(seq) {
                continue;
            }
            let block = self.block_of(seq);
            match self.apply_trace(seq, block, None, None, "feed gap") {
                Step::Done => {
                    Stats::inc(&self.sh.stats.gap_blocks);
                    self.next_seq = Some(seq + 1);
                }
                Step::Again => return Err("unexpected".into()),
                Step::Retry(w) | Step::Restart(w) => return Err(w),
            }
        }
        Ok(())
    }

    fn publish(&mut self, v: Version) {
        {
            let mut p = self.sh.published.write().unwrap();
            p.versions.push_back(Arc::new(v));
            while p.versions.len() > self.sh.cfg.history {
                p.versions.pop_front();
            }
        }
        self.sh.notify();
    }

    /// Fetch queued fill items at the newest block the node has that we keep.
    fn do_fills(&mut self) {
        let Some(node) = self.sh.node.clone() else {
            let _ = self.fills.take(usize::MAX);
            return;
        };
        let items = self.fills.take(100);
        if items.is_empty() {
            return;
        }
        // Skip items the head already knows exactly (filled meanwhile).
        let head = match self.sh.head() {
            Some(h) => h,
            None => return,
        };
        let items: Vec<MissItem> = items.into_iter().filter(|m| needs_fetch(&head.snap, m)).collect();
        if items.is_empty() {
            return;
        }
        let tip = self.sh.node_tip.load(Ordering::Relaxed);
        let k = if tip > 0 { head.block.min(tip) } else { head.block.saturating_sub(1) };
        let epoch = self.sh.epoch.load(Ordering::Relaxed);
        let fetched = match fetch_items(&*node, Class::Fill, k, &items) {
            Ok(r) => r,
            Err(_) => {
                Stats::add(&self.sh.stats.fill_failed, items.len() as u64);
                return;
            }
        };
        let mut good = Vec::new();
        let mut later = Vec::new();
        for (it, r) in fetched {
            match r {
                Ok(f) => good.push(f),
                Err(ItemErr::BlockUnavailable) => later.push(it),
                Err(_) => Stats::inc(&self.sh.stats.fill_failed),
            }
        }
        if !later.is_empty() {
            self.fills.push(later);
        }
        if good.is_empty() || self.sh.epoch.load(Ordering::Relaxed) != epoch {
            return;
        }
        Stats::inc(&self.sh.stats.fills);
        Stats::add(&self.sh.stats.fill_items, good.len() as u64);
        let r = {
            let mut p = self.sh.published.write().unwrap();
            reconcile(&mut p.versions, k, &good)
        };
        Stats::add(&self.sh.stats.fill_dropped_conflict, r.too_old as u64);
        if r.too_old > 0 {
            // Ask again later (at a block we keep).
            let again: Vec<MissItem> = good.iter().map(fetched_item).collect();
            self.fills.push(again);
        }
        self.sh.notify();
    }

    /// Header refresh: base fee + block-number cross-check.
    fn upkeep_header(&mut self) {
        let Some(node) = self.sh.node.clone() else { return };
        let every = Duration::from_secs(self.sh.cfg.header_every_s.max(1));
        if self.last_header.is_some_and(|t| t.elapsed() < every) {
            return;
        }
        self.last_header = Some(Instant::now());
        let tip = match node::block_number(&*node, Class::Header) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[arbsim] header refresh failed: {e}");
                return;
            }
        };
        self.sh.node_tip.store(tip, Ordering::Relaxed);
        let h = match node::get_header(&*node, Class::Header, tip) {
            Ok(Some(h)) => h,
            _ => return,
        };
        // The replay may use the base fee only while it's stable (Robinhood
        // sits at its minimum almost always). Changing -> txs that read
        // BASEFEE / GASPRICE get the node's trace instead.
        self.env.basefee_known = h.base_fee > 0 && h.base_fee == self.basefee;
        self.basefee = h.base_fee;
        // Cross-check: does block = seq + offset hold for what we've seen?
        let p = self.sh.published.read().unwrap();
        if let Some(v) = p.versions.iter().find(|v| v.block == h.number) {
            if let Some(bh) = v.block_hash {
                if bh != h.hash {
                    Stats::inc(&self.sh.stats.block_offset_mismatch);
                    eprintln!(
                        "[arbsim] WARNING: feed seq {} maps to block {} but its hash differs from the node's: check ARBSIM_L2_BLOCK_OFFSET",
                        v.seq, h.number
                    );
                }
            }
            if let Some(c) = &v.ctx {
                if c.timestamp.abs_diff(h.timestamp) > 2 {
                    Stats::inc(&self.sh.stats.block_offset_mismatch);
                    eprintln!(
                        "[arbsim] WARNING: block {} timestamp {} (node) vs {} (feed seq {}): check ARBSIM_L2_BLOCK_OFFSET",
                        h.number, h.timestamp, c.timestamp, v.seq
                    );
                }
            }
        }
    }

    /// Optional sampled comparison of our replay with the node's trace.
    fn maybe_verify(&mut self) {
        let every = self.sh.cfg.verify_every;
        if every == 0 || self.sh.node.is_none() {
            return;
        }
        let Some(head) = self.sh.head() else { return };
        if head.seq % every != 0 || head.txs.is_empty() {
            return;
        }
        if self.last_verify.is_some_and(|t| t.elapsed() < Duration::from_secs(self.sh.cfg.verify_min_interval_s)) {
            Stats::inc(&self.sh.stats.verify_skipped);
            return;
        }
        self.last_verify = Some(Instant::now());
        self.verify_block(head.block);
    }

    /// Compare block `block` (already replayed) with the node's own diff.
    pub fn verify_block(&mut self, block: u64) {
        let Some(node) = self.sh.node.clone() else { return };
        let (before, ours, senders) = {
            let p = self.sh.published.read().unwrap();
            let Some(i) = p.versions.iter().position(|v| v.block == block) else { return };
            if i == 0 {
                return;
            }
            let v = &p.versions[i];
            let senders: HashSet<Address> = HashSet::new();
            (p.versions[i - 1].snap.clone(), v.diff.clone(), senders)
        };
        let trace = match node::trace_block_diff(&*node, Class::Verify, block) {
            Ok(Some(t)) => t,
            Ok(None) | Err(_) => {
                Stats::inc(&self.sh.stats.verify_skipped);
                return;
            }
        };
        let Ok(per_tx) = parse_block_trace(&trace) else {
            Stats::inc(&self.sh.stats.verify_skipped);
            return;
        };
        let mut node_diff = StateDiff::default();
        for t in &per_tx {
            merge(&mut node_diff, &t.diff);
        }
        let mut skip_bal: HashSet<Address> = senders;
        for (a, d) in &ours.accounts {
            if d.balance_inexact {
                skip_bal.insert(*a);
            }
        }
        let skip_acct: HashSet<Address> = HashSet::new();
        let (n, mm) = compare(&*before, &ours, &node_diff, &skip_bal, &skip_acct);
        Stats::add(&self.sh.stats.verify_items, n as u64);
        if mm.is_empty() {
            Stats::inc(&self.sh.stats.replay_match);
            return;
        }
        Stats::inc(&self.sh.stats.replay_mismatch);
        Stats::add(&self.sh.stats.verify_item_mismatches, mm.len() as u64);
        for m in &mm {
            if self.mismatch_logged < 20 {
                self.mismatch_logged += 1;
                eprintln!(
                    "[arbsim] replay mismatch #{} block {block}: {} {} ours={} node={}",
                    self.mismatch_logged,
                    m.account,
                    m.slot.map(|s| format!("slot {s:#x}")).unwrap_or_else(|| "basics".into()),
                    m.ours,
                    m.node
                );
            }
        }
        // Correct: balance-only differences -> that account's ETH balance is
        // never trusted again (a fee receiver). Everything else: forget the
        // account in all versions from this block on (refetched on demand).
        let mut forget: Vec<Address> = Vec::new();
        for m in &mm {
            if m.balance_only {
                if self.sh.volatile.add_balance(m.account) {
                    eprintln!("[arbsim] {} looks like a gas-fee receiver: its ETH balance is no longer trusted", m.account);
                }
            } else if !forget.contains(&m.account) {
                forget.push(m.account);
            }
        }
        if !forget.is_empty() {
            let mut p = self.sh.published.write().unwrap();
            rewrite_from(&mut p.versions, block, |s| {
                for a in &forget {
                    s.apply_fact(&Fact::Forget(*a));
                }
            });
        }
        self.sh.notify();
    }

    /// Memory cap + drop accounts unused for ARBSIM_IDLE_EVICT_S.
    fn evict(&mut self) {
        let Some(head) = self.sh.head() else { return };
        let (acc, slots, _) = head.snap.counts();
        let now = self.now_s();
        let idle = self.sh.cfg.idle_evict_s;
        let warm = self.fills.warm_accounts();
        let has_idle = head.snap.accounts.keys().any(|a| !warm.contains(a) && now.saturating_sub(*self.last_used.get(a).unwrap_or(&0)) > idle && now > idle);
        if acc <= self.sh.cfg.max_accounts && slots <= self.sh.cfg.max_slots && !has_idle {
            return;
        }
        let last_used = self.last_used.clone();
        let age = move |a: &Address| now.saturating_sub(*last_used.get(a).unwrap_or(&0));
        let max_acc = self.sh.cfg.max_accounts;
        let max_slots = self.sh.cfg.max_slots;
        let mut dropped_set: Vec<Address> = Vec::new();
        {
            let mut p = self.sh.published.write().unwrap();
            let Some(h) = p.versions.back().cloned() else { return };
            let mut s = (*h.snap).clone();
            // Idle ones first.
            let idle_list: Vec<Address> = s.accounts.keys().filter(|a| !warm.contains(*a) && age(a) > idle && now > idle).copied().collect();
            for a in &idle_list {
                s.accounts.remove(a);
            }
            dropped_set.extend(idle_list);
            let before: HashSet<Address> = s.accounts.keys().copied().collect();
            s.evict(max_acc, max_slots, &age, |a| warm.contains(a));
            dropped_set.extend(before.into_iter().filter(|a| !s.accounts.contains_key(a)));
            let n = p.versions.len();
            p.versions[n - 1] = Arc::new(Version { snap: Arc::new(s), ..(*h).clone() });
            // Older versions keep their data until they age out (bounded by history).
        }
        Stats::add(&self.sh.stats.evicted_accounts, dropped_set.len() as u64);
        for a in dropped_set {
            self.last_used.remove(&a);
        }
    }
}

/// Does the snapshot lack this item (or know it only approximately)?
fn needs_fetch(s: &Snapshot, m: &MissItem) -> bool {
    use crate::state::{Lookup, StateRead};
    let v = crate::state::snap::View::new(Arc::new(s.clone()));
    match m {
        MissItem::Account(a) => matches!(v.account(*a), Lookup::Missing),
        MissItem::Slot(a, sl) => matches!(v.storage(*a, *sl), Lookup::Missing),
        MissItem::Code(_) => false,
    }
}

fn fetched_item(f: &Fetched) -> MissItem {
    match f {
        Fetched::Slot(a, s, _) => MissItem::Slot(*a, *s),
        Fetched::Account(a, _) => MissItem::Account(*a),
    }
}

/// Fetch items at `block` and turn them into facts. Code-by-hash items are
/// turned into account fetches by the caller (an account miss covers code).
/// Returns (facts, items not available yet, items refused).
pub fn fetch_facts(node: &dyn node::NodeApi, class: Class, block: u64, items: &[MissItem]) -> Result<(Vec<Fact>, usize, usize), NodeErr> {
    let r = fetch_items(node, class, block, items)?;
    let (mut facts, mut unavailable, mut failed) = (Vec::new(), 0, 0);
    for (_, res) in r {
        match res {
            Ok(Fetched::Slot(a, s, v)) => facts.push(Fact::Slot(a, s, v)),
            Ok(Fetched::Account(a, acc)) => {
                let (info, code) = super::fill::account_info(acc.as_ref());
                facts.push(Fact::Basics { addr: a, info, code });
            }
            Err(ItemErr::BlockUnavailable) => unavailable += 1,
            Err(ItemErr::Unsupported) => {}
            Err(ItemErr::Other(_)) => failed += 1,
        }
    }
    Ok((facts, unavailable, failed))
}

/// Apply the node's diff for a block to our copy, for what we HOLD only:
///   - accounts we hold: basics and every changed slot are taken over
///     (exact values), cleared storage cleared;
///   - accounts we don't hold: only newly CREATED contracts are added when
///     the diff gives their full state (created in this block = complete).
/// Code bodies in the diff are always kept (cheap, never stale).
pub fn apply_node_diff(s: &mut Snapshot, d: &StateDiff) {
    for (a, ad) in &d.accounts {
        if let (Some(Some(i)), Some(c)) = (&ad.info, &ad.code) {
            s.put_code(i.code_hash, c.clone());
        }
        if s.holds(a) || ad.storage_cleared {
            let mut exact = ad.clone();
            exact.balance_inexact = false;
            if s.holds(a) && ad.info.is_some() {
                // The node's basics are exact: a fresh exact balance.
                if let Some(acct) = s.accounts.get_mut(a) {
                    acct.balance_exact = true;
                }
            }
            s.apply_account_diff(*a, &exact);
        }
    }
}

/// Values for `apply_node_diff` testing / pinned views: one account diff.
pub fn account_diff_slots(slots: &[(U256, U256)]) -> AccountDiff {
    AccountDiff { storage: slots.iter().copied().collect(), ..Default::default() }
}
