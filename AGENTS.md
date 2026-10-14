# StrafeChat/desktop - AGENTS.md

The desktop app. The workspace `AGENTS.md` (principles, terminology) applies here in full; this
file covers what is particular to this repository. `README.md` has the detail.

## Two shells

- **Windows and macOS run on Tauri 2** (`src-tauri/`), **Linux on Electron** (`electron/`),
  both around the same web client (`web/`, a submodule of StrafeChat/web.strafe.chat).
- Linux is on Chromium because WebKitGTK cannot carry an end-to-end encrypted call
  (`docs/linux-voice.md`). Do not move it back to WebKitGTK until a shell can pass the call
  tests below, and never make a call "work" by letting it run unencrypted.
- A feature that lives in the shell is written twice: Rust in `src-tauri/`, JavaScript in
  `electron/` (main process plus `preload.js`). Keep the two behaving the same - the same
  files in the same config directory (`chat.strafe.desktop`: `accounts.json` owner-only,
  `prefs.json`), the same defaults, the same Settings.

## The bridge contract

- The page reaches the Electron shell only through `window.strafeDesktop`, whose contract is
  `web/src/desktop/electronBridge.ts` and whose implementation is `electron/preload.js`. Change
  both together and ship them in the same release; bump the contract's `version` when a
  member changes meaning. `web/src/desktop/native.ts` is the one place that picks a shell.
- The page stays sandboxed (context isolation, no Node). The preload exposes the contract and
  nothing else.

## Releasing

- The version lives in `package.json` and `src-tauri/Cargo.toml` only. `electron/package.json`'s
  is never shipped: the build scripts pass the root one to electron-builder.
- A `v<version>` tag runs `.github/workflows/release.yml`: Tauri builds Windows and macOS and
  drafts the release with `latest.json`; the `linux` job builds and signs the AppImage, deb and
  rpm; `linux-release` attaches them and adds their entries to `latest.json`.
- macOS bundles are signed ad hoc (`bundle.macOS.signingIdentity: "-"`) until there is an
  Apple Developer ID, and the workflow fails if the app inside a `.dmg` does not pass
  `codesign --verify --strict` or lacks the microphone and camera entitlements. Never ship an
  unsigned Mac bundle: macOS reports it as damaged and offers no way to open it (issue #1).
- Keep the Linux artifact names (`Strafe_<v>_amd64.AppImage`, `Strafe_<v>_amd64.deb`,
  `Strafe-<v>-1.x86_64.rpm`), the package name `strafe` and the executable `strafe-desktop`:
  strafe.chat/download, the feed script, CI and in-place upgrades from older installs all
  depend on them.

## Update feed and signing

- One feed for both shells: `latest.json` on the latest release. Every file it lists is
  minisign-signed with the updater key and bound to its version - `tauri build` does that for
  the Tauri bundles, `tauri signer sign --app-version <v>` for anything else.
- The public key is in two places that must match: `plugins.updater.pubkey` in
  `src-tauri/tauri.conf.json` and `electron/src/updateKey.js` (a test checks). Never relax
  signature checks in either updater, and never ship an entry that does not verify.
- `scripts/linux-update-feed.mjs` refuses a feed whose signatures, file names or versions do
  not line up. Fix the build, not the check.

## Testing

- Unit tests: `npm --prefix electron test` (node:test; name files `*.test.js` or `*.test.mjs`).
- Calls: the harness in `docs/linux-voice.md` ("How this was tested"). Measure what the app
  plays (null sink + `parec`), not whether a track decoded, and prove encryption on the wire
  with hidden subscribers that do not decrypt. A call change on Linux is done when it passes
  there, on a packaged build as well as `npm run linux`.
- Packaging: `npm --prefix electron run build:dir` gives the unpacked app in
  `electron/dist/linux-unpacked/`. Check sandbox changes on a system that restricts user
  namespaces (Ubuntu 24.04), with the AppImage and with the deb.
