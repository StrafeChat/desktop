#!/usr/bin/env bash
# Build WebKitGTK with WebRTC for the Linux AppImage.
#
# No distribution ships a WebKitGTK with WebRTC compiled in (ENABLE_WEB_RTC defaults to off),
# and the AppImage bundles the libwebkit2gtk of the machine that builds it, so a stock build
# cannot make a call. This builds the exact WebKitGTK version Ubuntu 22.04 ships (what the
# release runner has), with the same layout and flags Ubuntu's packaging uses, plus WebRTC -
# inside an ubuntu:22.04 container so the result runs on the runner and on any glibc >= 2.35.
# The release workflow overlays the resulting tarball onto /usr before `tauri build`, and the
# bundler picks it up like the stock one (the GTK linuxdeploy plugin patches /usr paths
# inside libwebkit to be AppDir-relative; the processes live in
# usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/ either way).
#
#   scripts/build-webkitgtk-webrtc.sh [version]      # default 2.50.4, ~2-3 h on 16 cores
#
# Output: dist/webkitgtk-<version>-webrtc-ubuntu22.04-x86_64.tar.xz, to be uploaded as an
# asset of the pre-release `webkitgtk-webrtc-<version>` (pre-release so neither the updater's
# releases/latest nor the download page ever picks it). Needs docker and ~30 GB of disk.
set -euo pipefail

VERSION="${1:-2.50.4}"
JOBS="${JOBS:-8}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.webkitgtk-build}"
NAME="wkbuild-$VERSION"
TARBALL="webkitgtk-$VERSION-webrtc-ubuntu22.04-x86_64.tar.xz"

mkdir -p "$WORK" "$HERE/dist"
if [ ! -f "$WORK/webkitgtk-$VERSION.tar.xz" ]; then
  curl -fL -o "$WORK/webkitgtk-$VERSION.tar.xz" "https://webkitgtk.org/releases/webkitgtk-$VERSION.tar.xz"
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -v "$WORK:/work" -w /work ubuntu:22.04 sleep infinity >/dev/null

docker exec -e DEBIAN_FRONTEND=noninteractive "$NAME" bash -euo pipefail -c '
  sed -i "s/^deb \(.*\)$/deb \1\ndeb-src \1/" /etc/apt/sources.list
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates xz-utils ninja-build ccache cmake \
    pkg-config build-essential gcc-12 g++-12 gperf ruby python3 unifdef >/dev/null
  apt-get build-dep -y -qq webkit2gtk >/dev/null
  # Ubuntu builds without WebRTC, so its build-deps lack what the WebRTC check wants:
  # OpenSSL 3 headers, GStreamer webrtc/nice/srtp.
  apt-get install -y -qq --no-install-recommends libssl-dev libnice-dev \
    libgstreamer-plugins-bad1.0-dev libsrtp2-dev gstreamer1.0-plugins-bad gstreamer1.0-nice >/dev/null
'

docker exec "$NAME" bash -euo pipefail -c "
  cd /work
  [ -d webkitgtk-$VERSION ] || tar -xJf webkitgtk-$VERSION.tar.xz
  mkdir -p webkitgtk-$VERSION/build && cd webkitgtk-$VERSION/build
  # Ubuntu's debian/rules, minus docs/introspection (not needed by the Rust bindings), plus
  # WebRTC. Ubuntu blanks CMAKE_*_FLAGS_RELEASE and gets -O2 back from dpkg-buildflags; set
  # them explicitly or the result is an -O0 build with assertions on.
  cmake -G Ninja .. -DPORT=GTK -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib/x86_64-linux-gnu \
    -DCMAKE_INSTALL_LIBEXECDIR=lib/x86_64-linux-gnu -DCMAKE_INSTALL_SYSCONFDIR=/etc \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_C_COMPILER=gcc-12 -DCMAKE_CXX_COMPILER=g++-12 \
    -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
    -DCMAKE_C_FLAGS_RELEASE='-O2 -DNDEBUG' -DCMAKE_CXX_FLAGS_RELEASE='-O2 -DNDEBUG' \
    -DUSE_SOUP2=OFF -DUSE_GTK4=OFF \
    -DENABLE_WEB_RTC=ON -DUSE_GSTREAMER_WEBRTC=ON -DENABLE_MEDIA_STREAM=ON \
    -DENABLE_DOCUMENTATION=OFF -DENABLE_INTROSPECTION=OFF -DENABLE_MINIBROWSER=ON \
    -DUSE_LIBBACKTRACE=OFF -DDEBUG_FISSION=OFF -DENABLE_BUBBLEWRAP_SANDBOX=ON \
    -DUSE_AVIF=OFF -DUSE_GSTREAMER_TRANSCODER=OFF -DUSE_JPEGXL=OFF -DENABLE_SPEECH_SYNTHESIS=OFF \
    -DUSE_SYSPROF_CAPTURE=OFF
  grep -q '^ENABLE_WEB_RTC:BOOL=ON' CMakeCache.txt
  ninja -j$JOBS
  rm -rf /work/stage && DESTDIR=/work/stage ninja install >/dev/null
  cd /work/stage
  # Only what replaces Ubuntu's runtime: the two libraries and the process/bundle directory.
  # Headers and .pc files are already there in the same version from libwebkit2gtk-4.1-dev.
  strip --strip-unneeded usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.*.* usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0.*.* \
    usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess \
    usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so
  tar -cJf /work/$TARBALL usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so* usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so* usr/lib/x86_64-linux-gnu/webkit2gtk-4.1
"
cp "$WORK/$TARBALL" "$HERE/dist/$TARBALL"
sha256sum "$HERE/dist/$TARBALL"
echo "Upload: gh release create webkitgtk-webrtc-$VERSION --prerelease --title 'WebKitGTK $VERSION with WebRTC (AppImage build input)' dist/$TARBALL"
