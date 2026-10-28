// A game's name as Strafe will share it: one rule for every name the shell sends, whether it
// came from a launcher's files, games.json or the person typing a rename. The same rule as the
// server's (equinox internal/modules/auth: SanitizeActivityName) and the web client's
// (src/lib/activity.ts), counted in code points as both of those count.

/** Longest name, in code points. The server refuses anything longer. */
const NAME_MAX = 128;

// Never allowed anywhere: control characters, the line and paragraph separators and the bidi
// embeddings, overrides and isolates. Joiners (U+200D) and variation selectors (U+FE0F) stay:
// emoji sequences need them.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
// Something that renders on its own: not a space, an invisible format character, a lone
// combining mark, or one of the letters that draw as nothing (Hangul fillers, blank braille).
const VISIBLE = /[^\s\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0\u2800]/u;

function tidy(raw) {
  return raw.replace(FORBIDDEN, '').replace(/\s+/gu, ' ').trim();
}

/**
 * A name from a launcher or games.json, made shareable: forbidden characters removed,
 * whitespace collapsed and trimmed, cut to NAME_MAX code points. Null when nothing visible
 * is left.
 */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const s = tidy(raw);
  if (!s || !VISIBLE.test(s)) return null;
  const points = [...s];
  return points.length > NAME_MAX ? points.slice(0, NAME_MAX).join('').trim() : s;
}

/** A name the person typed: the cleaned name, or null when it is empty, invisible or longer
 * than NAME_MAX (refused rather than cut, so what they see is what is shared). */
function validName(raw) {
  if (typeof raw !== 'string') return null;
  const s = tidy(raw);
  if (!s || !VISIBLE.test(s) || [...s].length > NAME_MAX) return null;
  return s;
}

module.exports = { NAME_MAX, cleanName, validName };
