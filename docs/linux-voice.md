# Voice and video on Linux

Status: implemented, 2026-10-12. The Linux app runs on Electron (`electron/`), starting with
v1.4.0; Windows and macOS stay on Tauri. The findings that led there are
kept below, and the test harness is how calls are checked on Linux from now on.

## In one paragraph

The Linux app renders the client with WebKitGTK, and since distribution WebKitGTK has no
WebRTC we ship our own build (2.50.4 + GStreamer 1.26 + a 1,760-line patch). Tested in real
calls, that engine fails at the basics: you hear nobody (your output stream is saved as muted
by the system mixer), anyone who joins after you is silent and black, the camera dies after
one frame and can take the call down with it, nobody sees you speaking, and screen share
cannot start. It cannot be fixed forward: upstream WebKit deleted the GStreamer WebRTC backend
our patch modifies, and the engine we bundle has stopped receiving security fixes. A prototype
that runs the same client on Chromium (Electron) passed every scenario that failed, with
encryption verified on the wire, and needed no server change. **Recommendation: ship the
Linux app on Chromium; keep Tauri for Windows and macOS.**

## How this was tested

Two participants in a local LiveKit room (equinox API + stargate, Scylla, `livekit-dev`): the
Linux app under test, and the web client in a browser. Everything is measured, not eyeballed:

- **What the app actually plays**: its audio goes to a null sink; `parec` on the sink's
  monitor gives the RMS the user would hear. (An `AnalyserNode` on the track only proves
  the track decoded. The v1.3.0 check used one, and that is how the mute bug below slipped through.)
- **Whether remote video renders**: window captures 1 s apart, scored by colourful-pixel share
  and frame-to-frame change against a moving synthetic pattern.
- **Speaking**: the other side's `room.activeSpeakers` / `participant.audioLevel` (the SFU's
  verdict, from the RFC 6464 audio-level header).
- **Encryption on the wire**: three hidden subscribers with E2EE *off* (LiveKit tokens with
  `hidden: true`, one pinned to each simulcast layer) must not be able to render anything,
  while the encrypting peer must.
- Synthetic media only: a voice-like test signal through a PipeWire virtual microphone, and
  a canvas camera; no real camera or screen was captured.

The app ran isolated from an installed copy (own XDG dirs, own D-Bus session, the inspector
on `WEBKIT_INSPECTOR_HTTP_SERVER`; the prototype over the DevTools protocol).

## What is broken in v1.3.2

| # | Symptom | Cause | Evidence |
|---|---|---|---|
| 1 | **You hear nobody**, persistently | The client keeps one muted `<audio>` element per remote track (LiveKit `webAudioMix`). WebKit's GStreamer sink maps element mute onto the PulseAudio stream itself, and WirePlumber saves stream mute/volume per `application.name`. So every later Strafe output stream, including the Web Audio output the call plays through, starts muted at 0% | `~/.local/state/wireplumber/stream-properties` had `Output/Audio:application.name:strafe-desktop={"mute":true, "channelVolumes":[0,0]}`; app output RMS 0.0000 while the track decoded at 0.13; unmuting gave 0.16; creating one muted element re-saved `mute:true` |
| 2 | **Anyone who joins after you is silent with a black tile** | Receivers added by renegotiation get no decrypt transform: the decoder is fed ciphertext | 774× `vp8dec: corrupt frame`; decoded audio digital silence; reproduced with the app in the call first, and with a peer leaving and rejoining |
| 3 | **Camera dies after one frame, and can drop you from the call** | `rtpvp8pay` cannot parse an encrypted VP8 frame, errors, and stops the source; LiveKit then sees "connection quality lost while publishing" and forces a full reconnect | `rtpvp8pay2` error + `streaming stopped, reason error`; outbound `framesSent: 1`; one run ended disconnected |
| 4 | **Nobody sees you speaking** | The audio-level header extension is negotiated but never filled in | Your audio arrived at 0.24 peak while the SFU reported `audioLevel 0`, `isSpeaking false` |
| 5 | **Screen share cannot start** | WebKit captures through `pipewiresrc`, which the bundle does not contain | None of the 55 bundled plugins provides it |
| 6 | Picking an output device does nothing | WebKitGTK 2.50 has no `AudioContext.setSinkId` | Source; LiveKit throws and the client swallows it |
| 7 | "Waiting for encryption keys" never clears | Web client race (fixed, see below) | Banner shown while both keys were installed |
| 8 | Voice statistics wrong, errors every tick | Incomplete `getStats` | `stats.forEach` unhandled rejections; inbound audio reports video frame counts |
| 9 | Received video stuck at the lowest layer | No bandwidth estimation (`rtpgccbwe` not bundled) | 320×180 received from a 720p sender |
| 10 | The `.deb` and `.rpm` cannot call at all | They use the distribution's WebKitGTK, which has no WebRTC | Only the AppImage carries our engine |

The patch audit also found the encoded-frame tap fails open (frames with no transform
attached pass through) and taps only the last simulcast encoder. In our run the camera
died before anything got out: the three non-encrypting probes received about 2 MB and
rendered zero frames. Still, by construction this is a plaintext path.

## Why not fix it in place

- **Upstream removed the code.** WebKit commit `317849@main` (2026-07-24) deleted the
  GStreamer WebRTC backend ("un-maintained and provides incomplete WebRTC support"). GTK
  and WPE move to LibWebRTC, expected by default in 2.56 (about March 2027). Even then, encoded
  transforms are off by default on GTK and untested there.
- **No security fixes.** We bundle WebKitGTK 2.50.4. That engine renders every message,
  including content from other instances, yet its advisories since cover hundreds of
  CVEs (WSA-2026-0006 alone: 232). Ubuntu 22.04, our build base, is frozen at 2.50.4.
  GStreamer 1.26.0 predates the DTLS fingerprint validation fix (MR !11953).
- **Each fix is a full cycle:** another patch site, a 2–3 hour engine build, then bundling traps
  like the NSS modules and the presets. Making video work would add four more patch sites
  and two components on top.

## Options considered

| Option | Verdict |
|---|---|
| **Linux shell on Electron** (Chromium 152, stable) | **Recommended.** Same engine WebView2 gives Windows; LiveKit E2EE via insertable streams; PipeWire screen share; Chromium echo cancellation; maintained security backports. A second shell to maintain. |
| Tauri 3 + CEF on Linux | The right end state, not yet. Alpha only, forces Windows/macOS onto Tauri 3 alpha too, and open Linux bugs hit our exact window pattern (hidden main window losing keyboard input, tauri#16251; 100% idle CPU, #16189). Revisit at Tauri 3 stable. |
| Native call engine in Rust (LiveKit Rust SDK) behind the WebKitGTK UI | Feasible (E2EE interop checked on paper: needs HKDF + four non-default options), but ~7–10 weeks, no good way to get decoded video into WebKitGTK, and the UI engine keeps the security problem. |
| Keep patching WebKitGTK | Dead end (above). |
| `tauri-plugin-webrtc` (Rust RTCPeerConnection shim) | Two weeks old, no simulcast receive; would need the same on-the-wire proof before trusting its E2EE. |

## Prototype results (`electron/`, Chromium 152)

Same harness, same client code (no changes for the engine):

| Scenario | v1.3.2 (WebKitGTK) | Prototype (Chromium) |
|---|---|---|
| Join a call already in progress: hear / see | silent (saved mute) / video ok | 0.115 peak / renders |
| Someone joins after you: hear / see | silent / black | 0.123 peak / renders |
| Peer leaves and rejoins: hear / see | silent / black | 0.115 peak / renders |
| Others see you speaking | never | yes (`audioLevel` 0.25) |
| Camera, 3 simulcast layers | dies after 1 frame | 320×180, 640×360, 1280×720 steady, `limit: none` |
| Encrypted on the wire | n/a | peer decrypts (pattern recovered); 3 non-E2EE probes: ~2 MB received, 0 frames rendered |
| Screen share | impossible | 1600×1026, encrypted, received by the peer |
| Switch output device | no-op | audio moved to the chosen device, old one silent |
| Output stream state | saved muted | one unmuted stream (Chromium mixes in-process) |
| CPU in a call (receive 1 video + audio, send audio) | ~18% of a core | 18.4% of a core |

The prototype serves the bundled client as `tauri://localhost`, the origin every instance
already admits for the desktop app. It was checked against a real instance: login and
API calls passed CORS, and the gateway WebSocket opened and streamed events. **No server
or federation change is needed.**

## Plan

Checked items are done; `README.md` describes the result.

1. [x] **Linux shell on Electron** (`electron/`), to parity with the Tauri app:
   - [x] A small desktop-bridge interface in the web client (`src/desktop/*` is the only place
     that imports Tauri: `native.ts`, `accounts.ts`, `updater.ts`, `env.ts`, and
     `DesktopSettingsPage.tsx`), with a Tauri implementation and an Electron one exposed
     through a `contextBridge` preload. The contract is `src/desktop/electronBridge.ts`.
   - [x] Main-process ports of what `src-tauri` does: accounts/prefs files, tray and
     close-to-tray, single instance, window state, autostart, notifications and badge,
     the IndexedDB wipe, and Discord Rich Presence (the same IPC protocol).
   - [x] A source picker for X11 screen share (on Wayland the portal picks).
   - [x] Packaging with electron-builder (`electron/electron-builder.yml`): AppImage, deb and
     rpm, named like the Tauri bundles. The Chromium sandbox stays: the deb and rpm install an
     AppArmor profile allowing user namespaces, and an AppImage tries one at start and only
     runs without the sandbox, with a warning, where the system refuses it
     (`electron/build/afterPack.js`).
   - [x] Release workflow: Linux with Electron and Windows/macOS with Tauri, from one tag,
     into one signed `latest.json` (`scripts/linux-update-feed.mjs` adds the Linux entries).
2. [x] **Moving existing Linux users.** The Tauri updater installs the Electron build from the
   same `latest.json`, minisign-signed with the same key: it replaces an AppImage in place,
   and upgrades a deb or rpm in place through pkexec (the packages keep the name `strafe`).
   The Electron shell's own updater takes over after that, from the same feed. Chromium
   cannot read WebKit's IndexedDB, so each Linux account becomes a new device and restores
   from its recovery code once. That is the same flow as "reset encryption", and should be
   said up front in the release notes.
3. **Then delete** the hand-built engine:
   - [x] `scripts/build-webrtc-stack.sh`, `patches/`, the AppImage overlay steps in
     `release.yml`, and the AppImage bundling settings in `tauri.conf.json`.
   - [ ] The `webrtc-stack-2.50.4` pre-release on GitHub (the repository owner's call).
4. [ ] **Revisit Tauri 3 + CEF** when it is stable. The Rust side would carry over almost
   unchanged, and the Electron shell could go.

### Before it shipped

- The "waiting for encryption keys" race (row 7) is fixed in the web client for every
  platform (`stores/voice.ts`: merge the keyed list instead of overwriting it).
- The optional v1.3.3 of the WebKitGTK app (stop creating muted `<audio>` elements, disable
  camera and screen share) was skipped in favour of shipping the Chromium shell.
- Anyone still on v1.3.2 whose Strafe output is stuck silent can unmute "strafe-desktop" in
  the system mixer. That app mutes it again on its next call.
