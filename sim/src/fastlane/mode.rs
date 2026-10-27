// ============================================================================
// FAST LANE MODE: which fast-lane mode we are in, and who sends real trades.
//
// Plain English:
//   Two switches in .env decide what the fast lane may do:
//     FASTLANE=off|practice|live   (default off)
//       off       nothing new runs (today's behaviour exactly)
//       practice  everything runs, including signing with a THROWAWAY key,
//                 but nothing is ever broadcast; "would send" is logged
//       live      real trades may go out (only if RUST_SENDER=on too)
//     RUST_SENDER=on|off           (default off)
//       The trade contract allows ONE executor wallet, and Rust uses the
//       same wallet as the Node bot. Two programs sending from one wallet
//       would fight over the nonce, so only one sends at a time:
//         on  -> Rust is the sender; the Node bot never broadcasts
//         off -> the Node bot is the sender; Rust never broadcasts
//   Rust broadcasts a real trade only when ALL of these hold:
//     FASTLANE=live AND RUST_SENDER=on AND the kill switch is off.
//   That is `may_broadcast()`. Anything we can't read clearly counts as the
//   safe choice: an unknown FASTLANE value is "off", an unknown RUST_SENDER
//   value is "off".
// ============================================================================

/// FASTLANE setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Nothing new runs.
    Off,
    /// Full pipeline, throwaway key, never broadcasts.
    Practice,
    /// Real sends allowed (still needs RUST_SENDER=on and no kill switch).
    Live,
}

impl Mode {
    /// Short name for logs and the send records ("off" / "practice" / "live").
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Practice => "practice",
            Mode::Live => "live",
        }
    }
    /// Same as `as_str` (the gun's older name for it).
    pub fn name(self) -> &'static str {
        self.as_str()
    }
    /// Parse a FASTLANE value (unknown = Off). The ONE parser every fast
    /// lane part uses (ahead, scan, gun, safety): see `parse_mode`.
    pub fn parse(raw: Option<&str>) -> Mode {
        parse_mode(raw).0
    }
    /// FASTLANE of this process (read every call: cheap, and tests can set it).
    pub fn from_env() -> Mode {
        Mode::parse(std::env::var("FASTLANE").ok().as_deref())
    }
}

/// Both switches, read once at start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FastlaneMode {
    pub mode: Mode,
    /// RUST_SENDER=on: Rust is the one sender (Node never broadcasts).
    pub rust_sender: bool,
    /// The FASTLANE value was set but not understood (it was treated as off).
    /// Kept so the start-up log can say so loudly.
    pub fastlane_unrecognised: bool,
}

/// Parse FASTLANE. Unset or empty = off. Unknown = off (and flagged).
pub fn parse_mode(raw: Option<&str>) -> (Mode, bool) {
    let v = raw.map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
    match v.as_str() {
        "" | "off" | "0" | "false" | "no" => (Mode::Off, false),
        "practice" | "shadow" | "dry" => (Mode::Practice, false),
        "live" => (Mode::Live, false),
        _ => (Mode::Off, true),
    }
}

/// Parse RUST_SENDER (on / true / 1 / yes, any case = on; anything else off).
/// Same rule as the Node side (src/execution/fastlaneBridge.ts rustSenderOn).
pub fn parse_on(raw: Option<&str>) -> bool {
    matches!(raw.map(|s| s.trim().to_ascii_lowercase()).as_deref(), Some("on" | "true" | "1" | "yes"))
}

impl FastlaneMode {
    /// Read from any key -> value lookup (tests pass a map; the program
    /// passes the real environment via `from_env`).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> FastlaneMode {
        let (mode, bad) = parse_mode(get("FASTLANE").as_deref());
        FastlaneMode { mode, rust_sender: parse_on(get("RUST_SENDER").as_deref()), fastlane_unrecognised: bad }
    }

    pub fn from_env() -> FastlaneMode {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Does the fast lane run at all?
    pub fn enabled(&self) -> bool {
        self.mode != Mode::Off
    }

    /// May Rust broadcast a REAL transaction right now? `killed` = the kill
    /// switch (data/KILL or KILL_SWITCH=on), checked by the caller fresh.
    pub fn may_broadcast(&self, killed: bool) -> bool {
        self.mode == Mode::Live && self.rust_sender && !killed
    }

    /// One line for the start-up log (no secrets in here).
    pub fn describe(&self) -> String {
        let who = if self.rust_sender { "RUST_SENDER=on: Rust is the only sender" } else { "RUST_SENDER=off: the Node bot is the sender" };
        let extra = if self.fastlane_unrecognised { " (FASTLANE value not understood: treated as off)" } else { "" };
        format!("FASTLANE={}{}; {}", self.mode.as_str(), extra, who)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn fm(pairs: &[(&str, &str)]) -> FastlaneMode {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        FastlaneMode::from_lookup(|k| m.get(k).cloned())
    }

    #[test]
    fn defaults_are_off() {
        let m = fm(&[]);
        assert_eq!(m.mode, Mode::Off);
        assert!(!m.rust_sender);
        assert!(!m.enabled());
        assert!(!m.may_broadcast(false));
    }

    #[test]
    fn parses_modes() {
        assert_eq!(fm(&[("FASTLANE", "practice")]).mode, Mode::Practice);
        assert_eq!(fm(&[("FASTLANE", " LIVE ")]).mode, Mode::Live);
        assert_eq!(fm(&[("FASTLANE", "off")]).mode, Mode::Off);
        let bad = fm(&[("FASTLANE", "liev")]);
        assert_eq!(bad.mode, Mode::Off);
        assert!(bad.fastlane_unrecognised);
    }

    #[test]
    fn rust_sender_values() {
        for v in ["on", "ON", "true", "1", "yes"] {
            assert!(fm(&[("RUST_SENDER", v)]).rust_sender, "{v}");
        }
        for v in ["off", "0", "", "maybe", "no"] {
            assert!(!fm(&[("RUST_SENDER", v)]).rust_sender, "{v}");
        }
    }

    #[test]
    fn broadcast_needs_live_and_rust_sender_and_no_kill() {
        assert!(fm(&[("FASTLANE", "live"), ("RUST_SENDER", "on")]).may_broadcast(false));
        assert!(!fm(&[("FASTLANE", "live"), ("RUST_SENDER", "on")]).may_broadcast(true), "kill switch");
        assert!(!fm(&[("FASTLANE", "live"), ("RUST_SENDER", "off")]).may_broadcast(false), "node is sender");
        assert!(!fm(&[("FASTLANE", "practice"), ("RUST_SENDER", "on")]).may_broadcast(false), "practice never sends");
        assert!(!fm(&[("FASTLANE", "off"), ("RUST_SENDER", "on")]).may_broadcast(false));
    }
}
