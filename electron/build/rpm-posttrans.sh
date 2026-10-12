#!/bin/sh
# rpm %posttrans (electron-builder.yml): put the command back on PATH after an upgrade from
# the Tauri build. That package owned /usr/bin/strafe-desktop as a plain file. rpm runs this
# package's %post (which links /usr/bin/strafe-desktop to /opt/Strafe) before it deletes the
# old package's leftover files, so the link goes with them. %posttrans runs after that.
if [ ! -e /usr/bin/strafe-desktop ]; then
  if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --install /usr/bin/strafe-desktop strafe-desktop /opt/Strafe/strafe-desktop 100 \
      || ln -sf /opt/Strafe/strafe-desktop /usr/bin/strafe-desktop
  else
    ln -sf /opt/Strafe/strafe-desktop /usr/bin/strafe-desktop
  fi
fi
exit 0
