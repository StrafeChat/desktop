//! A game's name as Strafe will share it: one rule for every name the shell sends, whether it
//! came from a launcher's files, games.json or the person typing a rename. The same rule as the
//! Electron shell's (electron/src/games/text.js), the server's (equinox internal/modules/auth:
//! SanitizeActivityName) and the web client's, counted in code points as all of them count.

use super::unicode::INVISIBLE;

/// Longest name, in code points. The server refuses anything longer.
pub const NAME_MAX: usize = 128;

/// Never allowed anywhere: control characters, the line and paragraph separators and the bidi
/// embeddings, overrides and isolates. Joiners (U+200D) and variation selectors (U+FE0F) stay:
/// emoji sequences need them.
fn forbidden(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// JavaScript's `\s`, which the Electron shell collapses and trims by: Unicode's White_Space
/// plus U+FEFF (U+0085, the one White_Space character JavaScript leaves out, is a control
/// character and gone before this is asked).
pub(super) fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

/// One of the letters that draw as nothing (the Hangul fillers, the blank braille pattern).
fn blank_filler(c: char) -> bool {
    matches!(c, '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}' | '\u{2800}')
}

fn invisible(c: char) -> bool {
    let cp = c as u32;
    INVISIBLE
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Something that renders on its own: not a space, an invisible format character, a lone
/// combining mark, or a filler.
fn visible(c: char) -> bool {
    !is_space(c) && !invisible(c) && !blank_filler(c)
}

/// Forbidden characters out, runs of whitespace as one space, the ends trimmed.
fn tidy(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut space = false;
    for c in raw.chars().filter(|&c| !forbidden(c)) {
        if is_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}

fn trim_js(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// A name from a launcher or games.json, made shareable: forbidden characters removed,
/// whitespace collapsed and trimmed, cut to NAME_MAX code points. None when nothing visible
/// is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let s = tidy(raw);
    if s.is_empty() || !s.chars().any(visible) {
        return None;
    }
    if s.chars().count() > NAME_MAX {
        let cut: String = s.chars().take(NAME_MAX).collect();
        return Some(trim_js(&cut).to_string());
    }
    Some(s)
}

/// A name the person typed: the cleaned name, or None when it is empty, invisible or longer
/// than NAME_MAX (refused rather than cut, so what they see is what is shared).
pub fn valid_name(raw: &str) -> Option<String> {
    let s = tidy(raw);
    if s.is_empty() || !s.chars().any(visible) || s.chars().count() > NAME_MAX {
        return None;
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cp(n: u32) -> char {
        char::from_u32(n).unwrap()
    }

    #[test]
    fn games_text_one_rule_with_the_server() {
        // The same cases as the Electron shell's text test.
        assert_eq!(clean_name(&format!("  A{}B{}  C\t\n", cp(0x202e), cp(0x2028))).as_deref(), Some("AB C"));
        let family = format!("{}{}{}{}{}", cp(0x1f468), cp(0x200d), cp(0x1f469), cp(0x200d), cp(0x1f467));
        assert_eq!(clean_name(&format!("Team {family}")), Some(format!("Team {family}")));
        assert_eq!(clean_name(&cp(0x3164).to_string()), None);
        assert_eq!(clean_name(&format!("{}{}", cp(0x200b), cp(0xfe0f))), None);
        // Counted in code points, so 128 astral emoji fit.
        let emoji: String = std::iter::repeat_n(cp(0x1f3ae), 128).collect();
        assert_eq!(valid_name(&emoji), Some(emoji.clone()));
        assert_eq!(valid_name(&format!("{emoji}{}", cp(0x1f3ae))), None);
        assert_eq!(clean_name(&"x".repeat(200)).map(|s| s.chars().count()), Some(128));
        assert_eq!(valid_name(&"x".repeat(129)), None);
        assert_eq!(valid_name(" ok ").as_deref(), Some("ok"));
    }

    #[test]
    fn games_text_marks_fillers_and_spaces() {
        // A lone combining mark, a soft hyphen or a zero-width space is not a name.
        assert_eq!(clean_name("\u{0301}"), None);
        assert_eq!(clean_name("\u{00AD}\u{200B}"), None);
        assert_eq!(clean_name("\u{2800}\u{3000}\u{115F}"), None);
        // ...but beside a letter they stay.
        assert_eq!(clean_name("e\u{0301}").as_deref(), Some("e\u{0301}"));
        // U+FEFF counts as a space, as JavaScript's \s has it.
        assert_eq!(clean_name("\u{FEFF}A\u{FEFF}\u{FEFF}B\u{FEFF}").as_deref(), Some("A B"));
        // Trademark signs and stray spaces from a Steam manifest.
        assert_eq!(clean_name("Second Library Game\u{2122} ").as_deref(), Some("Second Library Game\u{2122}"));
        // A cut lands on a space: trimmed.
        let long = format!("{} tail", "y".repeat(127));
        assert_eq!(clean_name(&long), Some("y".repeat(127)));
        assert_eq!(clean_name(""), None);
        assert_eq!(valid_name("\t \n"), None);
    }
}
