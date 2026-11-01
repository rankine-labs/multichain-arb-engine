// ============================================================================
// MEMORY ALLOCATOR CHOICE (Nov 1): ARBSIM_ALLOC = mimalloc [default] | system
//
// Plain English:
//   Live Nov 1, arbsim grew past pm2's line again and again (35 kills),
//   also with seeing-ahead OFF. The status `memory` breakdown showed WHERE:
//   what the program really holds stayed flat (~900-1,000 MB "in use" for
//   half an hour), while the process kept growing ~3 MB a minute. The
//   difference was memory the program had already given back, still held
//   by the allocator (glibc's malloc): 160 -> 295 MB "freed but held", and
//   it kept coming back after every malloc_trim.
//
//   Why glibc does that here: arbsim runs ~37 threads that all make and
//   drop millions of small blocks (copy 2's versions, the bot's 2-3 MB
//   route table every ~3 s parsed into JSON trees, checks, the keeper).
//   With MALLOC_ARENA_MAX=2 they share two big heaps; a page with one
//   long-lived block left on it can never be handed back, so the heaps keep
//   their high-water mark and slowly grow (fragmentation). malloc_trim can
//   only hand back pages that are completely empty, and it holds the heap's
//   lock while it walks it.
//
//   mimalloc (Microsoft's allocator, used by many Rust servers) keeps small
//   blocks of one size together per thread page and hands empty pages back
//   to the system by itself shortly after they empty ("purge"), without a
//   global lock. Measured offline (tests/alloc_frag.rs: the bot's route
//   table through check::entry, copy-2-style versions, check-like workers,
//   10 minutes each, MALLOC_ARENA_MAX=2): holding the same ~650 MB, glibc
//   ran at 986 MB (1.51 x what it held), mimalloc at 856 MB on average
//   (1.31 x), and not growing.
//
//   The choice is made ONCE, at the program's first allocation, from the
//   environment (read without allocating), and never changes afterwards, so
//   every block is always freed by the allocator that made it.
//     ARBSIM_ALLOC=system   glibc malloc, exactly as before (escape hatch)
//     anything else / unset mimalloc
//   Status `memory.allocator` says which one runs; with mimalloc the
//   `memory.malloc` figures come from mimalloc (committed / peak), and
//   "trim" asks mimalloc to hand back what it can (mi_collect).
// ============================================================================
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicIsize, AtomicU8, AtomicUsize, Ordering};

use mimalloc::MiMalloc;

const UNSET: u8 = 0;
const SYSTEM: u8 = 1;
const MIMALLOC: u8 = 2;

static MODE: AtomicU8 = AtomicU8::new(UNSET);

/// Which allocator ARBSIM_ALLOC asks for. Reads the environment with
/// libc::getenv (no allocation: this runs inside the very first malloc).
fn from_env() -> u8 {
    // SAFETY: getenv with a NUL-terminated name; the result is only read
    // (compared byte by byte up to its NUL), never kept.
    unsafe {
        let p = libc::getenv(c"ARBSIM_ALLOC".as_ptr());
        if p.is_null() {
            return MIMALLOC;
        }
        let v = std::ffi::CStr::from_ptr(p).to_bytes();
        if v.eq_ignore_ascii_case(b"system") || v.eq_ignore_ascii_case(b"glibc") || v.eq_ignore_ascii_case(b"malloc") {
            SYSTEM
        } else {
            MIMALLOC
        }
    }
}

#[inline]
fn mode() -> u8 {
    let m = MODE.load(Ordering::Relaxed);
    if m != UNSET {
        return m;
    }
    // First allocation: decide. Two threads racing here read the same
    // environment and so pick the same value; the first store wins anyway.
    let want = from_env();
    match MODE.compare_exchange(UNSET, want, Ordering::Relaxed, Ordering::Relaxed) {
        Ok(_) => want,
        Err(cur) => cur,
    }
}

/// The program's allocator (main.rs `#[global_allocator]`; also the test
/// binaries that measure it).
pub struct Chosen;

// ---------------------------------------------------------------------------
// Bytes held (status `memory.malloc.inUseMb`, both allocators): every
// allocation adds its size, every free takes it off. One counter per
// thread slot (64 slots, each on its own cache line), so threads do not
// fight over one number; status adds them up.
// ---------------------------------------------------------------------------
#[repr(align(64))]
struct Slot(AtomicIsize);

const SLOTS: usize = 64;
static HELD: [Slot; SLOTS] = [const { Slot(AtomicIsize::new(0)) }; SLOTS];
static NEXT_SLOT: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    // const init and no destructor: safe to use inside the allocator.
    static MY_SLOT: Cell<usize> = const { Cell::new(usize::MAX) };
}

#[inline]
fn note(delta: isize) {
    let i = MY_SLOT
        .try_with(|c| {
            let mut i = c.get();
            if i == usize::MAX {
                i = NEXT_SLOT.fetch_add(1, Ordering::Relaxed) % SLOTS;
                c.set(i);
            }
            i
        })
        // A thread being torn down: any slot will do (the sum is what counts).
        .unwrap_or(0);
    HELD[i].0.fetch_add(delta, Ordering::Relaxed);
}

/// Bytes the program holds right now (all threads), through `Chosen`.
/// 0 in a binary that does not use `Chosen`.
pub fn held_bytes() -> u64 {
    HELD.iter().map(|s| s.0.load(Ordering::Relaxed)).sum::<isize>().max(0) as u64
}

// SAFETY: every call goes to exactly one of two correct allocators, and the
// choice never changes after the first call, so a block is always freed /
// grown by the allocator that made it.
unsafe impl GlobalAlloc for Chosen {
    #[inline]
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = if mode() == SYSTEM { System.alloc(l) } else { MiMalloc.alloc(l) };
        if !p.is_null() {
            note(l.size() as isize);
        }
        p
    }
    #[inline]
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = if mode() == SYSTEM { System.alloc_zeroed(l) } else { MiMalloc.alloc_zeroed(l) };
        if !p.is_null() {
            note(l.size() as isize);
        }
        p
    }
    #[inline]
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if mode() == SYSTEM { System.dealloc(p, l) } else { MiMalloc.dealloc(p, l) }
        note(-(l.size() as isize));
    }
    #[inline]
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = if mode() == SYSTEM { System.realloc(p, l, new) } else { MiMalloc.realloc(p, l, new) };
        if !q.is_null() {
            note(new as isize - l.size() as isize);
        }
        q
    }
}

/// True when mimalloc runs. Only `Chosen` itself makes the choice (at its
/// first allocation): in a binary that does not use `Chosen` as its global
/// allocator (the library's unit tests, other tools) this stays false, so
/// the figures and the trim below then speak about glibc, which runs there.
pub fn is_mimalloc() -> bool {
    MODE.load(Ordering::Relaxed) == MIMALLOC
}

/// "mimalloc" or "system" (status `memory.allocator`).
pub fn name() -> &'static str {
    if is_mimalloc() { "mimalloc" } else { "system" }
}

/// With mimalloc: (bytes the program holds, process size as mimalloc sees
/// it). None when glibc runs (memguard reads glibc's own figures then).
pub fn mimalloc_figures() -> Option<(u64, u64)> {
    if !is_mimalloc() {
        return None;
    }
    let (mut elapsed, mut user, mut sys, mut rss, mut peak_rss, mut commit, mut peak_commit, mut faults) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    // SAFETY: mi_process_info only writes the eight numbers we pass.
    unsafe {
        libmimalloc_sys::mi_process_info(&mut elapsed, &mut user, &mut sys, &mut rss, &mut peak_rss, &mut commit, &mut peak_commit, &mut faults);
    }
    Some((held_bytes(), rss as u64))
}

/// Ask mimalloc to hand back every page it can right now (the thread's own
/// and the abandoned ones). No-op with glibc (memguard::trim_now does
/// malloc_trim then).
pub fn mimalloc_collect() {
    if is_mimalloc() {
        // SAFETY: plain call into mimalloc.
        unsafe { libmimalloc_sys::mi_collect(true) }
    }
}
