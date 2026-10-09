# Strafe Desktop

Strafe as a native app for Windows, macOS and Linux: the web client
([StrafeChat/web.strafe.chat](https://github.com/StrafeChat/web.strafe.chat), pulled in as the
`web/` submodule) inside a [Tauri 2](https://v2.tauri.app/) shell. One build works with every
Strafe instance: the sign-in page asks which one, and the account switcher in the user menu
holds accounts from any number of them.

What the app adds over a browser tab: its own title bar, a tray icon (closing the window keeps
you reachable), system notifications with a taskbar badge for unread mentions, launch at
start-up, links opening in your browser, "Playing Strafe" on your Discord profile, and in-app
updates. Voice and video work on all three platforms.

Downloads are at [strafe.chat/download](https://strafe.chat/download), which lists the files of
the newest [release](https://github.com/StrafeChat/desktop/releases).

## Layout

| Path | What |
| --- | --- |
| `src-tauri/` | The Rust shell: window, tray, preferences, the account file, plugins. |
| `web/` | The web client, as a git submodule. The code that runs inside the webview lives there under `src/desktop/` and `src/components/desktop/`, gated on `isDesktop()`. |
| `branding/` | The turtle, the icon generator and the 1024 px master every icon derives from. |
| `.github/workflows/release.yml` | Builds, signs and drafts a release for every platform on a `v*` tag. |

## Building

```bash
git clone --recursive https://github.com/StrafeChat/desktop.git
cd desktop
npm ci && npm run setup     # the Tauri CLI, then the web client's dependencies
npm run dev                 # the app against the web client's Vite dev server on :3000

# A release build signs its update artifacts, so it needs the private key (see Releasing);
# without it `tauri build` stops before bundling.
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/strafe-desktop.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run build                        # every bundle for this OS
npm run build -- --bundles appimage  # Linux: just the AppImage
```

Output lands in `src-tauri/target/release/bundle/`: `appimage/Strafe_<version>_amd64.AppImage`
(plus `deb/` and `rpm/`) on Linux, `nsis/Strafe_<version>_x64-setup.exe` (plus `msi/`) on
Windows, `dmg/` and `macos/` on macOS. An installer is built on the OS it is for; the release
workflow builds all of them at once.

Build dependencies: Linux needs WebKitGTK and the tray library - Debian/Ubuntu
`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`, Arch/CachyOS
`webkit2gtk-4.1 libayatana-appindicator librsvg patchelf` (plus `base-devel`); macOS Xcode's
command line tools; Windows the Visual Studio C++ build tools and WebView2 (preinstalled on
Windows 10+). The Rust toolchain comes from [rustup](https://rustup.rs); Node 22 or newer.

To pick up newer web client code: `git -C web pull origin dev`, then commit the new submodule
pointer here. A release carries whatever commit the submodule points at.

## Releasing

Installed copies look for updates at
`https://github.com/StrafeChat/desktop/releases/latest/download/latest.json`, which the
release workflow produces: bump `version` in `package.json`, make sure `web/` points at the
commit to ship, commit, and push a tag `v<version>`. The workflow builds Windows, macOS (both
chips) and Linux installers, signs them, and opens a **draft** release; publish it once an
installer has been tried, and every app checks in within a few hours.

Updates are signed with a minisign key. The public half is `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`; the private half is the repository secret
`TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if the key has
none). Keep it safe: a lost private key means a new public key, and apps installed with the
old one stop updating until reinstalled. Generate a pair with
`npx tauri signer generate -w ~/.tauri/strafe-desktop.key`.

## Discord activity

While the window is open, Discord (if it is running on the same computer) shows "Playing
Strafe" on the person's profile: "Securely chatting with other Strafers!", the instance they are
signed in to beneath it (its federation domain, or the host it was reached at), "in a voice
call" with the call's timer during calls, and a "Get Strafe" button for anyone who looks. Discord
learns nothing else - never a space or a room. A Strafe hidden in the tray is not shown as
playing, and the toggle under Settings -> Desktop turns the whole thing off (`discordPresence`
in `prefs.json`).

The name comes from a Discord *application* called **Strafe**, whose Application ID is
`DISCORD_APP_ID` in `src-tauri/src/discord.rs` (public, not a secret). A fork with its own
application can export `STRAFE_DISCORD_APP_ID` when building, which wins over the constant; an
empty value turns the feature off in that build, and Settings says so. The art
beside the activity is `branding/icon-1024.png` fetched from this repository, so nothing has to
be uploaded to the application. The code talks to Discord over its local IPC socket
(`discord-ipc-0` in `$XDG_RUNTIME_DIR`, `\\.\pipe\discord-ipc-0` on Windows; Flatpak and
Snap Discord are found too), retries every 20 s while Discord is not running, and logs a line
if Discord refuses the application ID.

## Icons

The app icon is the turtle in `branding/strafe-turtle.png` on a background in the app's own
theme. `npm run icons` rebuilds `branding/icon-1024.png`, the web client's icons in
`web/public/icons/` (commit those in the web repository) and the desktop set in
`src-tauri/icons/` (.icns, .ico and every PNG size). Needs Python 3 with Pillow.

## Known limits

- **The Linux build carries its own web engine.** No distribution ships a WebKitGTK with
  WebRTC compiled in, and below GStreamer 1.24 the engine cannot label the media it sends,
  so a stock AppImage could not make a call. `scripts/build-webrtc-stack.sh` builds the
  engine the release uses - WebKitGTK with `ENABLE_WEB_RTC=ON`, GStreamer 1.26 and a libnice
  without gupnp (Ubuntu's drags in libsoup2, which aborts a process that already has
  libsoup3) - plus the two patches in `patches/`: WebKit names the synchronisation source of
  each track it sends, which is how an SFU ties arriving media to a published track, and
  webrtcbin's assertion about a transceiver changing media line becomes a warning, since an
  SFU that reorders its offer when someone joins otherwise kills the web process. The result
  is published as the pre-release `webrtc-stack-<version>` and laid over /usr by the release
  workflow. Rebuild it when the runner's WebKitGTK version changes; the workflow fails loudly
  if the two disagree.
- **Switching to a build with an older WebKitGTK breaks the encryption store** (Linux). The
  AppImage bundles the WebKitGTK of the machine that built it, and WebKit's IndexedDB files
  carry a metadata version a newer engine bumps and an older one refuses - so a profile last
  used by, say, a locally built AppImage on a rolling distribution (2.52) cannot be opened by
  the CI build (2.50 from the Ubuntu 22.04 runner): the E2EE engine fails to start and WebKit's
  database server crashes on the attempt. The app notices and offers "Reset encryption": the
  shell leaves a `wipe-indexeddb` marker in its config dir, relaunches, and deletes
  `<data dir>/databases/indexeddb/v1/tauri_localhost_0` before the webview exists; the client
  revokes the old device, provisions a fresh one and asks for the recovery code. Every account
  on that device goes through the same restore. Upgrading the engine never has this problem.
- Passkeys cannot be used as a second factor in the app (WebAuthn binds to the page's
  origin, which is not the instance's domain); TOTP and recovery codes work.
- A hosted captcha (Turnstile, Friendly) must allow the host `tauri.localhost` in its site
  settings for the sign-up form to show it; the default ALTCHA needs nothing.
- Instances must run an equinox and nebula that admit the app's webview origins
  (`tauri://localhost`, `http(s)://tauri.localhost`); both do since October 2026.

## License

AGPL-3.0, like the rest of Strafe. See `LICENSE`.
