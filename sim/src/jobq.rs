// ============================================================================
// JOB QUEUE WITH A FAST LANE (trigger-entry speed, Oct 23).
//
// Plain English:
//   The sidecar has a few worker threads (ARBSIM_WORKERS, default 2). Every
//   question waits in a line until a worker is free. Before this, the line
//   was first-come-first-served: a trigger-entry question (a fresh feed
//   transaction that may be a money-making chance RIGHT NOW) could sit behind
//   ordinary checks from the older paths (gap scans, re-checks, warm-ups).
//
//   Now there are two lines:
//     fast lane    trigger-entry work: `trig_entry`, `trig_discover`, and a
//                  `call` the bot marks `"prio": true` (its entry checks)
//     normal lane  everything else
//   A free worker takes from the fast lane first, BUT after `burst` fast
//   jobs in a row it must take one normal job (if any is waiting), so the
//   older paths are never starved: at worst they get every (burst+1)-th turn.
//   burst = 0 turns the fast lane off (one plain first-come line, as before).
//
//   The total number of waiting jobs is capped (same as before: 256); a
//   question that finds the line full is answered "busy" at once.
//
//   Note on worker count: more workers than the machine has CPU cores do not
//   make anything faster (they only take turns on the same cores), so the
//   default stays 2 on the 2-CPU server. The fast lane is what lets an entry
//   question skip the line instead.
// ============================================================================
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};

struct Lanes<T> {
    fast: VecDeque<T>,
    normal: VecDeque<T>,
    /// Fast jobs handed out in a row (reset when a normal job is handed out).
    streak: usize,
    closed: bool,
}

/// A bounded two-lane job queue (see the file header).
pub struct JobQueue<T> {
    lanes: Mutex<Lanes<T>>,
    ready: Condvar,
    cap: usize,
    burst: usize,
}

impl<T> JobQueue<T> {
    /// `cap`: most jobs waiting in total; `burst`: most fast jobs in a row
    /// while normal ones wait (0 = no fast lane, first come first served).
    pub fn new(cap: usize, burst: usize) -> Self {
        JobQueue { lanes: Mutex::new(Lanes { fast: VecDeque::new(), normal: VecDeque::new(), streak: 0, closed: false }), ready: Condvar::new(), cap: cap.max(1), burst }
    }

    /// Add a job. Err(job) = the line is full (or closed): answer "busy".
    pub fn push(&self, job: T, fast: bool) -> Result<(), T> {
        let mut l = self.lanes.lock().unwrap_or_else(|e| e.into_inner());
        if l.closed || l.fast.len() + l.normal.len() >= self.cap {
            return Err(job);
        }
        // No fast lane: everything in one line, in arrival order.
        if fast && self.burst > 0 {
            l.fast.push_back(job);
        } else {
            l.normal.push_back(job);
        }
        drop(l);
        self.ready.notify_one();
        Ok(())
    }

    /// Next job for a worker (waits until there is one). None = closed and empty.
    pub fn pop(&self) -> Option<T> {
        let mut l = self.lanes.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(j) = Self::take(&mut l, self.burst) {
                return Some(j);
            }
            if l.closed {
                return None;
            }
            l = self.ready.wait(l).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Next job if one is waiting right now (tests).
    pub fn try_pop(&self) -> Option<T> {
        let mut l = self.lanes.lock().unwrap_or_else(|e| e.into_inner());
        Self::take(&mut l, self.burst)
    }

    /// The fast lane wins unless it already had `burst` turns in a row and a
    /// normal job is waiting.
    fn take(l: &mut Lanes<T>, burst: usize) -> Option<T> {
        let fast_turn = !l.fast.is_empty() && (l.streak < burst || l.normal.is_empty());
        if fast_turn {
            l.streak += 1;
            return l.fast.pop_front();
        }
        let j = l.normal.pop_front();
        if j.is_some() {
            l.streak = 0;
        }
        j
    }

    /// Jobs waiting (fast, normal).
    pub fn len(&self) -> (usize, usize) {
        let l = self.lanes.lock().unwrap_or_else(|e| e.into_inner());
        (l.fast.len(), l.normal.len())
    }

    pub fn is_empty(&self) -> bool {
        let (a, b) = self.len();
        a + b == 0
    }

    /// Stop: waiting workers get None once the line is empty.
    pub fn close(&self) {
        self.lanes.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        self.ready.notify_all();
    }
}

/// Does this question go in the fast lane? Trigger-entry work only:
/// `trig_entry`, `trig_discover`, and a `call` marked `"prio": true`.
pub fn is_fast(req: &serde_json::Value) -> bool {
    match req.get("type").and_then(|t| t.as_str()) {
        Some("trig_entry") | Some("trig_discover") => true,
        Some("call") => req.get("prio").and_then(|p| p.as_bool()).unwrap_or(false),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_jobs_go_first_but_normal_ones_are_not_starved() {
        let q = JobQueue::new(100, 2);
        for i in 0..3 {
            q.push(format!("n{i}"), false).unwrap();
        }
        for i in 0..5 {
            q.push(format!("f{i}"), true).unwrap();
        }
        let order: Vec<String> = std::iter::from_fn(|| q.try_pop()).collect();
        // Two fast, then one normal (the bound), and so on; normal ones in arrival order.
        assert_eq!(order, vec!["f0", "f1", "n0", "f2", "f3", "n1", "f4", "n2"]);
    }

    #[test]
    fn burst_zero_is_plain_first_come_first_served() {
        let q = JobQueue::new(100, 0);
        q.push("n0", false).unwrap();
        q.push("f0", true).unwrap();
        q.push("n1", false).unwrap();
        let order: Vec<&str> = std::iter::from_fn(|| q.try_pop()).collect();
        assert_eq!(order, vec!["n0", "f0", "n1"]);
    }

    #[test]
    fn full_line_refuses_and_fast_lane_alone_keeps_going() {
        let q = JobQueue::new(2, 1);
        q.push(1, true).unwrap();
        q.push(2, true).unwrap();
        assert_eq!(q.push(3, false), Err(3), "cap counts both lanes");
        // No normal job waiting: fast jobs may run back to back.
        assert_eq!(q.try_pop(), Some(1));
        assert_eq!(q.try_pop(), Some(2));
        assert_eq!(q.try_pop(), None);
    }

    #[test]
    fn which_questions_are_fast() {
        use serde_json::json;
        assert!(is_fast(&json!({"type": "trig_entry"})));
        assert!(is_fast(&json!({"type": "trig_discover"})));
        assert!(is_fast(&json!({"type": "call", "prio": true})));
        assert!(!is_fast(&json!({"type": "call"})));
        assert!(!is_fast(&json!({"type": "size_search", "prio": true})));
    }
}
