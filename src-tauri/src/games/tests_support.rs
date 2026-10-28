//! For the tests: temporary directories and the shared fixtures in desktop/test/games, copied
//! with `{FIXTURES}` replaced as its README says (step 1).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::indexes::Roots;

/// A directory removed when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        // The real path (no symlinked /tmp, no Windows short names), so what the index resolves
        // is what the cases name.
        let base = plain(fs::canonicalize(std::env::temp_dir()).unwrap());
        let dir = base.join(format!("strafe-games-{tag}-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Without Windows' `\\?\` prefix, which canonicalize adds.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("test").join("games")
}

/// `{FIXTURES}` as the fixtures spell it: forward slashes, no trailing slash.
pub fn placeholder(dir: &Path) -> String {
    dir.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string()
}

/// test/games copied to a fresh directory, `{FIXTURES}` replaced by its path in every file.
pub fn copy_fixtures() -> TempDir {
    let tmp = TempDir::new("fixtures");
    let value = placeholder(tmp.path());
    fn walk(from: &Path, to: &Path, value: &str) {
        for ent in fs::read_dir(from).unwrap() {
            let ent = ent.unwrap();
            let a = ent.path();
            let b = to.join(ent.file_name());
            if ent.file_type().unwrap().is_dir() {
                fs::create_dir_all(&b).unwrap();
                walk(&a, &b, value);
            } else {
                fs::write(&b, fs::read_to_string(&a).unwrap().replace("{FIXTURES}", value)).unwrap();
            }
        }
    }
    walk(&fixtures_dir(), tmp.path(), &value);
    tmp
}

/// The launcher roots the README names, in a copy: Steam at `steam`, Epic's manifests at `epic`.
pub fn fixture_roots(dir: &Path) -> Roots {
    Roots { steam: vec![dir.join("steam")], epic: vec![dir.join("epic")] }
}
