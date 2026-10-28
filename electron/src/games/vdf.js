// Steam's text KeyValues ("VDF"): libraryfolders.vdf and appmanifest_<appid>.acf.
//
//   "key"  "value"
//   "key"  { ...nested... }
//
// Strings are double-quoted with backslash escapes (\\ \" \n \t); a few files leave a token
// unquoted. `//` starts a comment, and `[$WIN32]`-style conditions after a token are skipped.
// Keys are case-insensitive to Steam, so read them through get().

/** The parsed file as nested plain objects (a later duplicate key wins). Never throws: a broken
 * file gives what could be read up to the break. */
function parseVdf(text) {
  const s = String(text);
  let i = 0;

  function skipSpace() {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      return;
    }
  }

  /** The next token: { str } for a string, { open } / { close } for braces, null at the end. */
  function token() {
    skipSpace();
    if (i >= s.length) return null;
    const c = s[i];
    if (c === '{') {
      i++;
      return { open: true };
    }
    if (c === '}') {
      i++;
      return { close: true };
    }
    if (c === '[') {
      // A platform condition: not data.
      while (i < s.length && s[i] !== ']') i++;
      i++;
      return token();
    }
    if (c === '"') {
      i++;
      let out = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          out += s[i++];
        }
      }
      i++;
      return { str: out };
    }
    let out = '';
    while (i < s.length && !/[\s{}"]/.test(s[i])) out += s[i++];
    return { str: out };
  }

  /** Past the rest of a block whose `{` was just read, without building it. */
  function skipBlock() {
    let open = 1;
    while (open > 0) {
      const t = token();
      if (!t) return;
      if (t.open) open++;
      else if (t.close) open--;
    }
  }

  function object(depth) {
    const obj = Object.create(null);
    for (;;) {
      const k = token();
      if (!k || k.close) return obj;
      if (k.open) {
        // A brace with no key: read past it.
        skipBlock();
        continue;
      }
      const v = token();
      if (!v || v.close) return obj;
      if (!v.open) obj[k.str] = v.str;
      else if (depth >= 16) skipBlock();
      else obj[k.str] = object(depth + 1);
    }
  }

  return object(0);
}

/** A key of a parsed VDF object, case-insensitively. */
function get(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

/** The library paths in a libraryfolders.vdf (old files put the path straight under the
 * number; newer ones in a "path" key). */
function libraryPaths(text) {
  const root = get(parseVdf(text), 'libraryfolders');
  if (!root || typeof root !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(root)) {
    if (!/^\d+$/.test(k)) continue;
    const p = typeof v === 'string' ? v : get(v, 'path');
    if (typeof p === 'string' && p) out.push(p);
  }
  return out;
}

/** { appid, name, installdir } of an appmanifest, or null when it lacks one of them. */
function appManifest(text) {
  const st = get(parseVdf(text), 'AppState');
  if (!st || typeof st !== 'object') return null;
  const appid = get(st, 'appid');
  const name = get(st, 'name');
  const installdir = get(st, 'installdir');
  if (typeof appid !== 'string' || !/^\d+$/.test(appid)) return null;
  if (typeof name !== 'string' || typeof installdir !== 'string' || !installdir) return null;
  return { appid, name, installdir };
}

module.exports = { parseVdf, get, libraryPaths, appManifest };
