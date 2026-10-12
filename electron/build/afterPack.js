// electron-builder afterPack hook (electron-builder.yml), Linux only: flips the Electron
// fuses, then puts a small launcher in front of the executable.
//
// Why the launcher: Chromium sandboxes its renderers with unprivileged user namespaces, or
// failing that with the setuid helper chrome-sandbox, and without either it refuses to start.
// The deb and rpm are covered - their post-install script makes chrome-sandbox setuid where
// user namespaces are off, and installs an AppArmor profile allowing them where AppArmor
// restricts them (Ubuntu 23.10 and later). An AppImage gets neither: it is mounted nosuid, so
// the helper cannot be setuid, and nothing installs a profile for it. On those systems the
// launcher starts the AppImage without the sandbox, and says so, rather than not at all.
// Everywhere else it only hands over to the real binary.
//
// The executable keeps its name (strafe-desktop: the .desktop file, the deb/rpm's link on
// PATH and the AppImage's AppRun all start it by that name) and becomes the launcher; Electron
// itself moves to strafe-desktop.bin beside it.

const fs = require('node:fs/promises');
const path = require('node:path');

// Hardening that costs the app nothing: no running the binary as plain Node
// (ELECTRON_RUN_AS_NODE), no NODE_OPTIONS or --inspect from outside, the app only from its
// own asar, cookies encrypted at rest, and file:// pages without extra privileges.
// electron-builder's own `electronFuses` option would flip these after this hook, on the
// file named after the executable - the launcher by then, and a shell script has no fuses.
// So they are flipped here, on the binary, before it moves. The keys are electron-builder
// 26's names for them.
const FUSES = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
};

/** The launcher. POSIX sh, so it runs wherever the AppImage does. */
function launcher(binName) {
  return `#!/bin/sh
# Starts Strafe. Written by build/afterPack.js in StrafeChat/desktop, which explains it.
self="$(readlink -f "$0")"
dir="$(dirname "$self")"
bin="$dir/${binName}"

# Inside an AppImage, Chromium's sandbox has only user namespaces to work with. Its runtime
# sets APPIMAGE and APPDIR - but everything it starts inherits them, so they only count when
# this script really runs from that mount, and never in a deb or rpm install (which carries
# resources/package-type and keeps its setuid sandbox).
in_appimage=
if [ -n "$APPIMAGE" ] && [ -n "$APPDIR" ] && [ ! -e "$dir/resources/package-type" ]; then
  appdir="$(readlink -f "$APPDIR")"
  case "$self" in
    "$appdir"/*) in_appimage=1 ;;
  esac
fi

# Try a namespace the way Chromium would; if the system refuses, start without the sandbox.
if [ -n "$in_appimage" ] && ! unshare --user --map-root-user --mount true >/dev/null 2>&1; then
  echo "strafe-desktop: this system does not allow unprivileged user namespaces, so Strafe runs without Chromium's sandbox (the .deb or .rpm package keeps it)." >&2
  for arg in "$@"; do
    [ "$arg" = --no-sandbox ] && exec "$bin" "$@"
  done
  exec "$bin" --no-sandbox "$@"
fi
exec "$bin" "$@"
`;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const { appOutDir, packager } = context;
  const executable = path.join(appOutDir, packager.executableName);
  const binName = `${packager.executableName}.bin`;

  await packager.addElectronFuses(context, await packager.generateFuseConfig(FUSES));
  await fs.rename(executable, path.join(appOutDir, binName));
  await fs.writeFile(executable, launcher(binName));
  // Explicitly, not through writeFile's mode: that is filtered by the umask, and the packages
  // install files with the mode they have here.
  await fs.chmod(executable, 0o755);
};

// For the tests.
exports.launcher = launcher;
exports.FUSES = FUSES;
