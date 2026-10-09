# Strafe Desktop

Strafe as a native app for Windows, macOS and Linux: the web client
([StrafeChat/web.strafe.chat](https://github.com/StrafeChat/web.strafe.chat), pulled in as the
`web/` submodule) inside a [Tauri 2](https://v2.tauri.app/) shell. One build works with every
Strafe instance: the sign-in page asks which one, and the account switcher in the user menu
holds accounts from any number of them.

What the app adds over a browser tab: its own title bar, a tray icon (closing the window keeps
you reachable), system notifications with a taskbar badge for unread mentions, launch at
start-up, links opening in your browser, and in-app updates.

Downloads are on the [releases page](https://github.com/StrafeChat/desktop/releases).

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

## Icons

The app icon is the turtle in `branding/strafe-turtle.png` on a background in the app's own
theme. `npm run icons` rebuilds `branding/icon-1024.png`, the web client's icons in
`web/public/icons/` (commit those in the web repository) and the desktop set in
`src-tauri/icons/` (.icns, .ico and every PNG size). Needs Python 3 with Pillow.

## Known limits

- **Voice and video do not work in the Linux app.** The webview there is WebKitGTK, and the
  builds distributions ship leave WebRTC out entirely; the AppImage bundles the WebKitGTK of
  the machine it was built on, so it carries the same gap. The app says so when a call is
  attempted; use the web client in a browser for calls on Linux. Windows (WebView2) and
  macOS (WebKit with WebRTC) are unaffected. The shell already switches WebRTC on in the
  WebKitGTK settings, so a WebKitGTK built with `ENABLE_WEB_RTC=ON` would work.
- Passkeys cannot be used as a second factor in the app (WebAuthn binds to the page's
  origin, which is not the instance's domain); TOTP and recovery codes work.
- A hosted captcha (Turnstile, Friendly) must allow the host `tauri.localhost` in its site
  settings for the sign-up form to show it; the default ALTCHA needs nothing.
- Instances must run an equinox and nebula that admit the app's webview origins
  (`tauri://localhost`, `http(s)://tauri.localhost`); both do since October 2026.

## License

AGPL-3.0, like the rest of Strafe. See `LICENSE`.
