abi <abi/4.0>,
include <tunables/global>

# electron-builder's default profile (Ubuntu 24.04 and later restrict unprivileged user
# namespaces to programs with a profile allowing them, and Chromium's sandbox needs one),
# attached to the binary as well as the executable: the executable is the launcher from
# build/afterPack.js, and it is strafe-desktop.bin that asks for the namespace.
profile "${executable}" "/opt/${sanitizedProductName}/${executable}{,.bin}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}
