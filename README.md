# Strafe Desktop

Strafe as a native app for Windows, macOS and Linux: the web client
([StrafeChat/web.strafe.chat](https://github.com/StrafeChat/web.strafe.chat), pulled in as the
`web/` submodule) inside a native shell. One build works with every Strafe instance: the
sign-in page asks which one, and the account switcher in the user menu holds accounts from any
number of them.

What the app adds over a browser tab: its own title bar, a tray icon (closing the window keeps
you reachable), system notifications with a taskbar badge for unread mentions, launch at
start-up, links opening in your browser, "Playing Strafe" on your Discord profile, and in-app
updates. Voice and video work on all three platforms, end-to-end encrypted like everywhere
else in Strafe.

Downloads are at [strafe.chat/download](https://strafe.chat/download), which lists the files of
the newest [release](https://github.com/StrafeChat/desktop/releases).

## Two shells

The same web client runs in two shells:

- **Windows and macOS: [Tauri 2](https://v2.tauri.app/)** (`src-tauri/`), on the system's own
  webview (WebView2, WKWebView).
- **Linux: [Electron](https://www.electronjs.org/)** (`electron/`), on Chromium.

Linux used to be Tauri too, but Tauri's Linux webview is WebKitGTK, and WebKitGTK has no WebRTC
engine that can carry an end-to-end encrypted call: no distribution ships one, the one we
built ourselves failed at the basics (you heard nobody, late joiners were silent, the camera
died), and upstream has since deleted the code it was built on. Chromium has the WebRTC
engine Windows already gets through WebView2, with the insertable streams the call encryption
needs. [docs/linux-voice.md](docs/linux-voice.md) has the measurements. Tauri 3's Chromium
backend may let Linux come back to one shell later.

Everything that runs inside the page is shared, and decides which shell it is in at run time:
`web/src/desktop/native.ts` talks to Tauri through `@tauri-apps/api`, or to Electron through
`window.strafeDesktop`, the bridge `electron/preload.js` exposes. Its contract is
`web/src/desktop/electronBridge.ts`. Both shells keep the same files (`accounts.json`,
`prefs.json`) in the same place, `~/.config/chat.strafe.desktop` on Linux, and read the same
signed update feed.

## Layout

| Path | What |
| --- | --- |
| `src-tauri/` | The Tauri shell (Windows, macOS): window, tray, preferences, the account file, plugins. |
| `electron/` | The Electron shell (Linux): the same features in a main process (`main.js`, `src/`) and the bridge to the page (`preload.js`). `electron-builder.yml` and `build/` package it. |
| `web/` | The web client, as a git submodule. The code that runs inside the app lives there under `src/desktop/` and `src/components/desktop/`, gated on `isDesktop()`. |
| `branding/` | The turtle, the icon generator and the 1024 px master every icon derives from. |
| `scripts/linux-update-feed.mjs` | Adds the Linux bundles to a release's update feed (see Releasing). |
| `.github/workflows/release.yml` | Builds, signs and drafts a release for every platform on a `v*` tag. |
| `docs/linux-voice.md` | Why Linux is on Electron: what broke on WebKitGTK, and how calls are tested. |

## Building

```bash
git clone --recursive https://github.com/StrafeChat/desktop.git
cd desktop
npm ci && npm run setup     # the Tauri CLI, then the web client's dependencies
```

**Windows and macOS (Tauri):**

```bash
npm run dev                 # the app against the web client's Vite dev server on :3000

# A release build signs its update artifacts, so it needs the private key (see Releasing);
# without it `tauri build` stops before bundling.
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/strafe-desktop.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run build               # every bundle for this OS
```

Output lands in `src-tauri/target/release/bundle/`: `nsis/Strafe_<version>_x64-setup.exe`
(plus `msi/`) on Windows, `dmg/` and `macos/` on macOS. Build dependencies: macOS Xcode's
command line tools; Windows the Visual Studio C++ build tools and WebView2 (preinstalled on
Windows 10+); both the Rust toolchain from [rustup](https://rustup.rs) and Node 22 or newer.

**Linux (Electron):**

```bash
npm run setup:linux         # the web client's dependencies and Electron
npm run linux:dev           # the app against the web client's dev server on :3000
                            # (start it with `npm --prefix web run dev`)
npm --prefix web run build && npm run linux   # the app on the built client, as it ships
npm run linux:build         # the AppImage, deb and rpm
```

Output lands in `electron/dist/`: `Strafe_<version>_amd64.AppImage`, `Strafe_<version>_amd64.deb`
and `Strafe-<version>-1.x86_64.rpm`, named exactly as the Tauri bundles were.
`npm --prefix electron run build:appimage` (or `build:deb`, `build:rpm`, `build:dir` for just
the unpacked app) builds one. Needs only Node 22 or newer; electron-builder fetches its own
packaging tools, except `rpmbuild` for the rpm (the `rpm` package on Debian and Ubuntu,
`rpm-tools` on Arch). Local builds are unsigned; the release workflow signs. The Tauri shell
still builds on Linux, for working on the Rust side, with WebKitGTK and the tray library
installed (`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` on Debian and
Ubuntu), but it cannot make calls and no release ships it.

Unit tests for the Electron shell, and for the update feed script: `npm --prefix electron test`.

To pick up newer web client code: `git -C web pull origin dev`, then commit the new submodule
pointer here. A release carries whatever commit the submodule points at.

## Releasing

The version lives in two places, `package.json` and `src-tauri/Cargo.toml`. Nothing else
holds it: `tauri.conf.json` reads `package.json`, and the Electron build scripts pass it to
electron-builder. To release, bump both, make sure `web/` points at the commit to ship, commit,
and push a tag `v<version>`. The workflow builds Windows and macOS (both chips) on Tauri and
the Linux AppImage, deb and rpm on Electron, signs everything, and opens a **draft** release;
publish it once an installer has been tried, and every app checks in within a few hours.

Installed copies of both shells look for updates at
`https://github.com/StrafeChat/desktop/releases/latest/download/latest.json`. tauri-action
writes it for Windows and macOS; `scripts/linux-update-feed.mjs` then adds the Linux entries
(`linux-x86_64-appimage`, `-deb`, `-rpm`, and `linux-x86_64` for the AppImage), and refuses
unless each bundle's signature verifies against the public key and names that file and
version. Its release notes (`notes`) are the workflow's `releaseBody`, and they are what the
update prompt shows.

Updates are signed with a minisign key. The public half is `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`, and the Electron shell carries the same key in
`electron/src/updateKey.js` (its tests fail if the two differ); the private half is the
repository secret `TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty
if the key has none). The Linux bundles are signed with
`npx tauri signer sign --app-version <version> <file>`, which is what `tauri build` does for
the others. Keep the key safe: a lost private key means a new public key, and apps installed
with the old one stop updating until reinstalled. Generate a pair with
`npx tauri signer generate -w ~/.tauri/strafe-desktop.key`.

## Moving from the Tauri Linux app

Linux installs from v1.3.2 and older run the Tauri shell. Their updater finds the Electron
bundles in the same `latest.json`, signed with the same key, and installs them like any other
update: an AppImage is replaced in place, and a deb or rpm is upgraded in place (the packages
are both named `strafe`), after the system asks for the password through pkexec. From then on
the Electron shell updates itself from the same feed.

The saved accounts (with their sessions) and Settings -> Desktop carry over: both shells keep
`accounts.json` and `prefs.json` in the same directory. What the page itself stored does not,
because Chromium cannot read WebKit's storage - and that includes the encryption keys, which
live in the page's IndexedDB. So on first start each Linux account becomes a new device and
restores its encrypted history once, from its recovery code: the same flow as "Reset
encryption". Say so at the top of that release's notes (the workflow's `releaseBody`, so the
update prompt shows it too).

## Discord activity

While the window is open, Discord (if it is running on the same computer) shows "Playing
Strafe" on the person's profile: "Securely chatting with other Strafers!", the instance they are
signed in to beneath it (its federation domain, or the host it was reached at), "in a voice
call" with the call's timer during calls, and a "Get Strafe" button for anyone who looks. Discord
learns nothing else - never a space or a room. A Strafe hidden in the tray is not shown as
playing, and the toggle under Settings -> Desktop turns the whole thing off (`discordPresence`
in `prefs.json`).

The name comes from a Discord *application* called **Strafe**, whose Application ID is
`DISCORD_APP_ID` in `src-tauri/src/discord.rs` and `electron/src/discord.js` (public, not a
secret). A fork of the Tauri shell with its own application can export `STRAFE_DISCORD_APP_ID`
when building, which wins over the constant; an empty value turns the feature off in that
build, and Settings says so. The art beside the activity is `branding/icon-1024.png` fetched
from this repository, so nothing has to be uploaded to the application. Both shells talk to
Discord over its local IPC socket (`discord-ipc-0` in `$XDG_RUNTIME_DIR`,
`\\.\pipe\discord-ipc-0` on Windows; Flatpak and Snap Discord are found too), retry every 20 s
while Discord is not running, and log a line if Discord refuses the application ID.

## Icons

The app icon is the turtle in `branding/strafe-turtle.png` on a background in the app's own
theme. `npm run icons` rebuilds `branding/icon-1024.png`, the web client's icons in
`web/public/icons/` (commit those in the web repository), the desktop set in
`src-tauri/icons/` (.icns, .ico and every PNG size) and the Linux app's copies in
`electron/build/icons/`. Needs Python 3 with Pillow.

## Known limits

- **The AppImage may run without Chromium's sandbox.** Chromium's sandbox needs unprivileged
  user namespaces or a setuid helper. The deb and rpm provide both (an AppArmor profile where
  the system restricts namespaces, as Ubuntu does from 23.10), but an AppImage can have neither:
  on such a system it starts without the sandbox and prints a warning, rather than not at
  all. Use the deb or rpm there.
- Passkeys cannot be used as a second factor in the app (WebAuthn binds to the page's
  origin, which is not the instance's domain); TOTP and recovery codes work.
- A hosted captcha (Turnstile, Friendly) must allow the host `tauri.localhost` in its site
  settings for the sign-up form to show it; the default ALTCHA needs nothing.
- Instances must run an equinox and nebula that admit the app's webview origins
  (`tauri://localhost`, `http(s)://tauri.localhost`); both do since October 2026. The Linux
  app serves the client as `tauri://localhost` too, so it needs nothing more.

## License

AGPL-3.0, like the rest of Strafe. See `LICENSE`.
