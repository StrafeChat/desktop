#!/usr/bin/env bash
# Build the web engine the Linux app needs for calls, as one tarball.
#
# Voice on Linux needs three things the distribution does not provide:
#
#   1. WebKitGTK with WebRTC compiled in. ENABLE_WEB_RTC is off in every distribution build,
#      and the AppImage bundles the engine of the machine that builds it, so a stock build
#      cannot make a call at all.
#   2. GStreamer 1.24 or newer. WebKit's WebRTC is GStreamer's, and below 1.24 it refuses to
#      put the media id into outgoing packets, which the SFU needs to recognise the stream.
#      Ubuntu 22.04 (the release runner) has 1.20.
#   3. libnice without gupnp. Ubuntu's links libsoup2, and a process that already has
#      libsoup3 - which WebKit does - aborts the moment both are loaded.
#
# Two small patches ride along (see ../patches): WebKit names the synchronisation source of
# each track it sends, which is how the SFU ties arriving media to a published track; and
# webrtcbin's hard assertion about a transceiver changing media line becomes a warning,
# because an SFU that reorders its offer when someone joins otherwise kills the web process.
#
#   scripts/build-webkitgtk-webrtc.sh [webkit version]     # ~2-3 h on 16 cores
#
# Output: dist/webrtc-stack-<version>-ubuntu22.04-x86_64.tar.xz, uploaded as an asset of the
# pre-release `webrtc-stack-<version>` (a pre-release, so neither the updater's
# releases/latest nor the download page ever sees it). Needs docker and ~40 GB of disk.
set -euo pipefail

WEBKIT_VERSION="${1:-2.50.4}"
GST_VERSION="${GST_VERSION:-1.26.0}"
NICE_VERSION="${NICE_VERSION:-0.1.22}"
JOBS="${JOBS:-8}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.webrtc-stack-build}"
NAME="webrtc-stack-build"
TARBALL="webrtc-stack-$WEBKIT_VERSION-ubuntu22.04-x86_64.tar.xz"

mkdir -p "$WORK" "$HERE/dist"
fetch() { [ -f "$WORK/$2" ] || curl -fL -o "$WORK/$2" "$1"; }
fetch "https://webkitgtk.org/releases/webkitgtk-$WEBKIT_VERSION.tar.xz" "webkitgtk-$WEBKIT_VERSION.tar.xz"
fetch "https://libnice.freedesktop.org/releases/libnice-$NICE_VERSION.tar.gz" "libnice-$NICE_VERSION.tar.gz"
for m in gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad; do
  fetch "https://gstreamer.freedesktop.org/src/$m/$m-$GST_VERSION.tar.xz" "$m-$GST_VERSION.tar.xz"
done
cp -r "$HERE/patches" "$WORK/patches"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -v "$WORK:/work" -w /work ubuntu:22.04 sleep infinity >/dev/null

docker exec -e DEBIAN_FRONTEND=noninteractive "$NAME" bash -euo pipefail -c '
  sed -i "s/^deb \(.*\)$/deb \1\ndeb-src \1/" /etc/apt/sources.list
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils ninja-build ccache cmake \
    pkg-config build-essential gcc-12 g++-12 gperf ruby python3 python3-pip unifdef patch flex bison nasm >/dev/null
  apt-get build-dep -y -qq webkit2gtk >/dev/null
  # Ubuntu builds WebKit without WebRTC, so its build-deps lack what that needs: OpenSSL 3
  # headers, and the libraries GStreamer wants for its webrtc/dtls/srtp plugins.
  apt-get install -y -qq --no-install-recommends libssl-dev libsrtp2-dev libgnutls28-dev \
    libopus-dev libvpx-dev libpulse-dev libasound2-dev libogg-dev libvorbis-dev \
    libx11-dev libxext-dev libegl1-mesa-dev libgl1-mesa-dev libgles2-mesa-dev libwayland-dev wayland-protocols libxkbcommon-dev >/dev/null
  pip3 install -q --upgrade meson >/dev/null
'

# --- GStreamer and libnice, into their own prefix ----------------------------------------
docker exec "$NAME" bash -euo pipefail -c "
  export PKG_CONFIG_PATH=/work/stack/usr/lib/x86_64-linux-gnu/pkgconfig
  export LD_LIBRARY_PATH=/work/stack/usr/lib/x86_64-linux-gnu
  P=/work/stack/usr
  cd /work

  build() { # module, extra meson args
    local m=\$1; shift
    rm -rf \$m-$GST_VERSION && tar -xJf \$m-$GST_VERSION.tar.xz && cd \$m-$GST_VERSION
    meson setup build --prefix=\$P --libdir=lib/x86_64-linux-gnu -Dbuildtype=release \
      -Dtests=disabled -Dexamples=disabled -Ddoc=disabled \"\$@\"
    ninja -C build && ninja -C build install
    cd /work
  }

  build gstreamer -Dintrospection=disabled
  build gst-plugins-base -Dintrospection=disabled -Dauto_features=disabled \
    -Dapp=enabled -Daudioconvert=enabled -Daudioresample=enabled -Daudiotestsrc=enabled \
    -Dplayback=enabled -Dtypefind=enabled -Dvolume=enabled -Dvideoconvertscale=enabled \
    -Dvideotestsrc=enabled -Dvideorate=enabled -Dopus=enabled -Dgl=enabled

  # libnice before gst-plugins-bad: its webrtc plugin needs a newer one than Ubuntu has, and
  # gupnp is what drags in libsoup2 (see the header of this script).
  rm -rf libnice-$NICE_VERSION && tar -xzf libnice-$NICE_VERSION.tar.gz && cd libnice-$NICE_VERSION
  meson setup build --prefix=\$P --libdir=lib/x86_64-linux-gnu -Dbuildtype=release \
    -Dgupnp=disabled -Dgstreamer=enabled -Dexamples=disabled -Dtests=disabled -Dintrospection=disabled
  ninja -C build && ninja -C build install
  cd /work

  rm -rf gst-plugins-bad-$GST_VERSION && tar -xJf gst-plugins-bad-$GST_VERSION.tar.xz
  patch -p1 -d gst-plugins-bad-$GST_VERSION < /work/patches/gst-plugins-bad-webrtcbin-mline.patch
  cd gst-plugins-bad-$GST_VERSION
  meson setup build --prefix=\$P --libdir=lib/x86_64-linux-gnu -Dbuildtype=release \
    -Dtests=disabled -Dexamples=disabled -Ddoc=disabled -Dintrospection=disabled -Dauto_features=disabled \
    -Dwebrtc=enabled -Ddtls=enabled -Dsrtp=enabled -Dsctp=enabled
  ninja -C build && ninja -C build install
  cd /work

  build gst-plugins-good -Dauto_features=disabled \
    -Dautodetect=enabled -Drtp=enabled -Drtpmanager=enabled -Dpulse=enabled -Daudioparsers=enabled \
    -Dvpx=enabled -Dvideofilter=enabled -Dinterleave=enabled -Daudiofx=enabled -Dlevel=enabled \
    -Dequalizer=enabled -Ddeinterlace=enabled
"

# --- WebKitGTK ----------------------------------------------------------------------------
docker exec "$NAME" bash -euo pipefail -c "
  export PKG_CONFIG_PATH=/work/stack/usr/lib/x86_64-linux-gnu/pkgconfig
  export LD_LIBRARY_PATH=/work/stack/usr/lib/x86_64-linux-gnu
  cd /work
  rm -rf webkitgtk-$WEBKIT_VERSION && tar -xJf webkitgtk-$WEBKIT_VERSION.tar.xz
  patch -p1 -d webkitgtk-$WEBKIT_VERSION < /work/patches/webkitgtk-announce-ssrc.patch
  mkdir -p webkitgtk-$WEBKIT_VERSION/build && cd webkitgtk-$WEBKIT_VERSION/build
  # Ubuntu's own flags (debian/rules), minus docs and introspection, plus WebRTC. Ubuntu
  # blanks CMAKE_*_FLAGS_RELEASE and gets -O2 back from dpkg-buildflags; set it explicitly
  # or this is an -O0 build with assertions on.
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
  DESTDIR=/work/stack ninja install >/dev/null
"

# --- one tarball, laid over /usr on the build machine -------------------------------------
docker exec "$NAME" bash -euo pipefail -c "
  cd /work/stack
  L=usr/lib/x86_64-linux-gnu
  strip --strip-unneeded \$L/libwebkit2gtk-4.1.so.0.*.* \$L/libjavascriptcoregtk-4.1.so.0.*.* \
    \$L/webkit2gtk-4.1/WebKitWebProcess \$L/webkit2gtk-4.1/WebKitNetworkProcess \
    \$L/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so 2>/dev/null || true
  find \$L -name 'libgst*.so*' -o -name 'libnice.so*' | xargs -r strip --strip-unneeded 2>/dev/null || true
  tar -cJf /work/$TARBALL \
    \$L/libwebkit2gtk-4.1.so* \$L/libjavascriptcoregtk-4.1.so* \$L/webkit2gtk-4.1 \
    \$L/libgst*.so* \$L/libnice.so* \$L/gstreamer-1.0 usr/libexec/gstreamer-1.0
"
cp "$WORK/$TARBALL" "$HERE/dist/$TARBALL"
sha256sum "$HERE/dist/$TARBALL"
echo "Upload: gh release create webrtc-stack-$WEBKIT_VERSION --prerelease --title 'WebRTC stack for the Linux AppImage' dist/$TARBALL"
