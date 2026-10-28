// From matched processes to the one game to share (research-detection-sources §13):
//
// - A session is every matched process with the same key. It starts at the earliest start of
//   any of them, ever (so a game's own pre-launcher counts, and turning sharing on mid-game
//   gives the real start).
// - It ends after MISSES_TO_END scans in a row without any of them (a launcher handing over to
//   the game must not end it), or at the first such scan when Steam's reaper was among them
//   (the reaper outlives everything Steam started for that game).
// - Hidden sessions never count. Of the rest the most recently started wins (then the more
//   authoritative source, then the name), and the choice sticks until that session ends, is
//   hidden, or a session that started after it appears - never a flip on alt-tab.

const MISSES_TO_END = 2;

function better(a, b) {
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  if (a.rank !== b.rank) return a.rank < b.rank;
  if (a.name !== b.name) return a.name < b.name;
  return a.key < b.key;
}

function best(list) {
  let out = null;
  for (const s of list) if (!out || better(s, out)) out = s;
  return out;
}

class Tracker {
  constructor() {
    /** key -> { key, name, source, rank, startedAt, misses, reaper } */
    this.sessions = new Map();
    this.currentKey = null;
  }

  reset() {
    this.sessions.clear();
    this.currentKey = null;
  }

  /**
   * One scan's matches ({ key, name, source, rank, start_ms, reaper? } per process): sessions
   * start, continue or end, and the choice is made again. Returns the chosen session or null.
   * @param {Set<string>} hidden
   */
  update(matches, hidden = new Set()) {
    const seen = new Map();
    for (const m of matches) {
      const g = seen.get(m.key);
      if (!g) {
        seen.set(m.key, { key: m.key, name: m.name, source: m.source, rank: m.rank, start: m.start_ms || 0, reaper: !!m.reaper });
        continue;
      }
      if (m.rank < g.rank) g.rank = m.rank;
      if (m.start_ms && (!g.start || m.start_ms < g.start)) g.start = m.start_ms;
      if (m.reaper) g.reaper = true;
    }
    for (const [key, s] of this.sessions) {
      const g = seen.get(key);
      if (g) {
        s.misses = 0;
        s.name = g.name;
        s.rank = g.rank;
        s.reaper = g.reaper;
        if (g.start && (!s.startedAt || g.start < s.startedAt)) s.startedAt = g.start;
        continue;
      }
      s.misses += 1;
      if (s.reaper || s.misses >= MISSES_TO_END) this.sessions.delete(key);
    }
    const fresh = [];
    for (const [key, g] of seen) {
      if (this.sessions.has(key)) continue;
      const s = { key, name: g.name, source: g.source, rank: g.rank, startedAt: g.start, misses: 0, reaper: g.reaper };
      this.sessions.set(key, s);
      fresh.push(s);
    }

    const visible = (s) => !hidden.has(s.key);
    const cur = this.currentKey ? this.sessions.get(this.currentKey) : undefined;
    let pick;
    if (cur && visible(cur)) {
      // Hysteresis: only a game started after this one takes over.
      pick = best(fresh.filter((s) => visible(s) && s.startedAt > cur.startedAt)) || cur;
    } else {
      pick = best([...this.sessions.values()].filter(visible));
    }
    this.currentKey = pick ? pick.key : null;
    return pick || null;
  }

  /** The choice again after a hide or unhide, with no scan: the current one stays unless it
   * is now hidden (an unhidden game is not a new one). */
  reselect(hidden = new Set()) {
    const cur = this.currentKey ? this.sessions.get(this.currentKey) : undefined;
    const pick = cur && !hidden.has(cur.key) ? cur : best([...this.sessions.values()].filter((s) => !hidden.has(s.key)));
    this.currentKey = pick ? pick.key : null;
    return pick || null;
  }

  /** Drop one session at once (a user-added game removed). */
  forget(key) {
    this.sessions.delete(key);
    if (this.currentKey === key) this.currentKey = null;
  }

  running() {
    return [...this.sessions.values()];
  }
}

module.exports = { MISSES_TO_END, Tracker };
