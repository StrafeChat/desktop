//! From matched processes to the one game to share (research-detection-sources §13). The port
//! of electron/src/games/tracker.js, less Steam's reaper (a Linux-only signal):
//!
//! - A session is every matched process with the same key. It starts at the earliest start of
//!   any of them, ever (so a game's own pre-launcher counts, and turning sharing on mid-game
//!   gives the real start).
//! - It ends after MISSES_TO_END scans in a row without any of them (a launcher handing over
//!   to the game must not end it).
//! - Hidden sessions never count. Of the rest the most recently started wins (then the more
//!   authoritative source, then the name), and the choice sticks until that session ends, is
//!   hidden, or a session that started after it appears - never a flip on alt-tab.

use std::collections::{HashMap, HashSet};

use super::matcher::{Match, Source};

pub const MISSES_TO_END: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub key: String,
    pub name: String,
    pub source: Source,
    pub rank: u8,
    /// Unix ms; 0 while no process of it said when it started.
    pub started_at: u64,
    pub misses: u32,
}

fn better(a: &Session, b: &Session) -> bool {
    if a.started_at != b.started_at {
        return a.started_at > b.started_at;
    }
    if a.rank != b.rank {
        return a.rank < b.rank;
    }
    if a.name != b.name {
        return a.name < b.name;
    }
    a.key < b.key
}

fn best<'a>(list: impl IntoIterator<Item = &'a Session>) -> Option<&'a Session> {
    let mut out: Option<&Session> = None;
    for s in list {
        if out.is_none_or(|o| better(s, o)) {
            out = Some(s);
        }
    }
    out
}

#[derive(Debug, Default)]
pub struct Tracker {
    pub sessions: HashMap<String, Session>,
    pub current_key: Option<String>,
}

impl Tracker {
    pub fn reset(&mut self) {
        self.sessions.clear();
        self.current_key = None;
    }

    /// One scan's matches: sessions start, continue or end, and the choice is made again.
    /// Returns the chosen session.
    pub fn update(&mut self, matches: &[Match], hidden: &HashSet<String>) -> Option<&Session> {
        // Grouped by key, in the order first seen.
        let mut seen: Vec<Session> = Vec::new();
        let mut at: HashMap<&str, usize> = HashMap::new();
        for m in matches {
            let v = &m.verdict;
            match at.get(v.key.as_str()) {
                None => {
                    at.insert(&v.key, seen.len());
                    seen.push(Session { key: v.key.clone(), name: v.name.clone(), source: v.source, rank: v.rank, started_at: m.start_ms, misses: 0 });
                }
                Some(&i) => {
                    let g = &mut seen[i];
                    if v.rank < g.rank {
                        g.rank = v.rank;
                    }
                    if m.start_ms != 0 && (g.started_at == 0 || m.start_ms < g.started_at) {
                        g.started_at = m.start_ms;
                    }
                }
            }
        }

        let seen_by_key: HashMap<&str, &Session> = seen.iter().map(|g| (g.key.as_str(), g)).collect();
        self.sessions.retain(|key, s| match seen_by_key.get(key.as_str()) {
            Some(g) => {
                s.misses = 0;
                s.name = g.name.clone();
                s.rank = g.rank;
                if g.started_at != 0 && (s.started_at == 0 || g.started_at < s.started_at) {
                    s.started_at = g.started_at;
                }
                true
            }
            None => {
                s.misses += 1;
                s.misses < MISSES_TO_END
            }
        });
        let mut fresh = Vec::new();
        for g in &seen {
            if self.sessions.contains_key(&g.key) {
                continue;
            }
            self.sessions.insert(g.key.clone(), g.clone());
            fresh.push(g.key.clone());
        }

        let visible = |s: &Session| !hidden.contains(&s.key);
        let cur = self.current_key.as_ref().and_then(|k| self.sessions.get(k)).filter(|s| visible(s));
        let pick = match cur {
            // Hysteresis: only a game started after this one takes over.
            Some(cur) => {
                let newer = best(fresh.iter().filter_map(|k| self.sessions.get(k)).filter(|s| visible(s) && s.started_at > cur.started_at));
                Some(newer.unwrap_or(cur).key.clone())
            }
            None => best(self.sessions.values().filter(|s| visible(s))).map(|s| s.key.clone()),
        };
        self.current_key = pick;
        self.current()
    }

    /// The choice again after a hide or unhide, with no scan: the current one stays unless it
    /// is now hidden (an unhidden game is not a new one).
    pub fn reselect(&mut self, hidden: &HashSet<String>) -> Option<&Session> {
        let keep = self.current_key.as_ref().filter(|k| self.sessions.contains_key(*k) && !hidden.contains(*k)).cloned();
        self.current_key = keep.or_else(|| best(self.sessions.values().filter(|s| !hidden.contains(&s.key))).map(|s| s.key.clone()));
        self.current()
    }

    /// Drop one session at once (a user-added game removed).
    pub fn forget(&mut self, key: &str) {
        self.sessions.remove(key);
        if self.current_key.as_deref() == Some(key) {
            self.current_key = None;
        }
    }

    pub fn current(&self) -> Option<&Session> {
        self.current_key.as_ref().and_then(|k| self.sessions.get(k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::matcher::Verdict;

    fn m(key: &str, start: u64) -> Match {
        Match { verdict: Verdict { key: key.into(), name: key.into(), source: Source::Curated, rank: 5 }, start_ms: start }
    }

    fn key(s: Option<&Session>) -> Option<&str> {
        s.map(|s| s.key.as_str())
    }

    #[test]
    fn games_tracker_most_recent_wins_and_the_choice_sticks() {
        let none = HashSet::new();
        let mut tr = Tracker::default();
        assert_eq!(key(tr.update(&[m("a", 100)], &none)), Some("a"));
        assert_eq!(key(tr.update(&[m("a", 100), m("b", 50)], &none)), Some("a"), "an older game appearing does not take over");
        assert_eq!(key(tr.update(&[m("a", 100), m("b", 50), m("c", 300)], &none)), Some("c"));
        assert_eq!(key(tr.update(&[m("a", 100), m("b", 50)], &none)), Some("c"), "one miss is not the end");
        assert_eq!(key(tr.update(&[m("a", 100), m("b", 50)], &none)), Some("a"));
        // Hidden: the current one hidden gives the next; unhiding it does not flip back.
        let hide_a: HashSet<String> = ["a".to_string()].into();
        assert_eq!(key(tr.reselect(&hide_a)), Some("b"));
        assert_eq!(key(tr.reselect(&none)), Some("b"));
        // Forgetting the current one.
        let mut f = Tracker::default();
        f.update(&[m("user:x", 1)], &none);
        f.forget("user:x");
        assert_eq!(f.current_key, None);
        assert!(f.reselect(&none).is_none());
    }

    #[test]
    fn games_tracker_two_misses_end_a_session_and_the_start_is_the_earliest() {
        let none = HashSet::new();
        let mut tr = Tracker::default();
        assert_eq!(tr.update(&[m("g", 20), m("g", 10)], &none).map(|s| s.started_at), Some(10));
        assert_eq!(tr.update(&[m("g", 30)], &none).map(|s| s.started_at), Some(10));
        assert!(tr.update(&[], &none).is_some());
        assert!(tr.update(&[], &none).is_none());
        assert!(tr.sessions.is_empty());
        // A start learned later fills in an unknown one.
        let mut u = Tracker::default();
        assert_eq!(u.update(&[m("g", 0)], &none).map(|s| s.started_at), Some(0));
        assert_eq!(u.update(&[m("g", 5)], &none).map(|s| s.started_at), Some(5));
    }

    #[test]
    fn games_tracker_a_hidden_current_game_gives_way_at_once() {
        let mut tr = Tracker::default();
        let none = HashSet::new();
        tr.update(&[m("a", 10), m("b", 20)], &none);
        assert_eq!(tr.current_key.as_deref(), Some("b"));
        let hide_b: HashSet<String> = ["b".to_string()].into();
        assert_eq!(key(tr.update(&[m("a", 10), m("b", 20)], &hide_b)), Some("a"));
        let hide_all: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        assert!(tr.update(&[m("a", 10), m("b", 20)], &hide_all).is_none());
    }
}
