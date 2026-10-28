# Game detection fixtures (both shells)

Synthetic launcher files and process snapshots that the Electron shell (`electron/test/games.test.js`,
`npm --prefix electron test`) and the Tauri shell (`cargo test --manifest-path src-tauri/Cargo.toml --lib games`)
both run, so the two recognise games the same way from the same `../../games.json`. Everything here is
made up: no real process list, account, library or install path belongs in this directory.

Owned by the Electron side; the Rust side reads these files and never edits them. A change of rule goes
in both shells and here, together.

## Running them

1. Copy this directory to a fresh temporary directory, replacing every `{FIXTURES}` in every file with
   that directory's absolute path (forward slashes, no trailing slash).
2. Build the launcher indexes from the copy, with exactly these roots and nothing from the real machine:

   | Launcher | Root (in the copy) | Shell |
   |---|---|---|
   | Steam | `{FIXTURES}/steam` (its `steamapps/libraryfolders.vdf` adds `{FIXTURES}/steam-library2`) | both |
   | Heroic | `{FIXTURES}/heroic` | node |
   | Lutris | `{FIXTURES}/lutris` (the `games/*.yml` files) | node |
   | Epic | `{FIXTURES}/epic` (the `*.item` manifests themselves) | rust |

3. Run every case of `cases.json` whose `shells` names your shell, `{FIXTURES}` replaced there too.

## A case

```jsonc
{
  "name": "...",                       // unique
  "os": "linux" | "win32" | "darwin",  // which OS's rules the matcher applies
  "shells": ["node", "rust"],          // who runs it
  "self_pid": 4000,                    // optional: Strafe's own pid; it and its descendants are skipped
  "user": [{ "id", "path", "name" }],  // optional: games the person added (activity.json `user`)
  "hidden": ["<key>"],                 // optional: activity.json `hidden`
  "renames": { "<key>": "<name>" },    // optional: activity.json `renames`
  "processes": [{ "pid", "ppid", "start_ms", "exe", "cmdline": [], "environ": {} }],
  "expect": { "key", "name", "started_at" } | null
}
```

`processes` + `expect` is one scan from a fresh start. A case with `scans: [{ processes, expect }, ...]`
instead is several scans in a row against the same state (selection, hysteresis, the two-miss end), each
`expect` checked after its scan. `expect` is what the shell would share after that scan, with its key
(`games_get_state().current`), renames applied: `null` when nothing is.

A snapshot holds more than the scanner may read. A runner passes `cmdline` to the matcher only for Java,
Wine and Steam's reaper (a program at `.../ubuntu12_32/reaper` or `.../ubuntu12_64/reaper`, Steam's own
runtime folder - never any program merely called reaper), and `environ` only for Wine, and from `environ` only `SteamAppId`,
`SteamGameId`, `HEROIC_APP_NAME`, `HEROIC_APP_RUNNER`, `LUTRIS_GAME_UUID`, `GAME_NAME`, `WINEPREFIX`
and `STEAM_COMPAT_DATA_PATH` (critique #16), so a case cannot pass on data the real scanner never sees.
`start_ms` is the process's start in Unix ms; a session's `started_at` is the earliest of its
processes'.

## Keys

`user:<id>`, `steam:<appid>`, `epic:<AppName>`, `heroic:<runner>:<app_name>`, `lutris:<slug>`,
`curated:<id>` - never a path.

## Which shell runs what

- Both: curated rules (incl. Minecraft's Java rule), the Steam index, user-added games, launchers and
  helpers, Strafe's own processes, selection (most recent, hidden, renamed, ties, hysteresis) and the
  two-miss end.
- Node only (Linux): Steam's reaper, Wine (path translation and launcher tags), Heroic, Lutris.
- Rust only (Windows): Epic's `.item` manifests.
