#!/usr/bin/env bash
#
# Builds the ffmpeg that gets bundled into the macOS and Linux packages.
#
#   bash scripts/build-ffmpeg.sh [--force]
#
# Windows downloads a prebuilt ffmpeg.exe instead (scripts/fetch-ffmpeg.mjs). macOS and Linux
# build one from source, for three reasons that do not apply to Windows:
#
# There is no trustworthy pinned binary to download. The macOS builds people link to are
# GPL, unversioned or x86-only, and the Linux static builds are GPL and have no ALSA, which
# is the one input device a Linux desktop is guaranteed to have.
#
# We need almost none of it. This app asks ffmpeg for exactly one thing — read a microphone,
# write 16 kHz mono s16le to stdout — so `--disable-everything` plus one input device, a
# handful of PCM decoders and the resampler is the entire program. It comes out at a few MB
# where a full build is ~100 MB, which matters for an installer people download on
# Uzbek mobile bandwidth.
#
# It stays LGPL. Nothing GPL is enabled, so the licence question is the same one the
# Windows build already answered: a separate process, never linked, with its licence shipped
# next to it.
#
# macOS gets a universal binary (arm64 + x86_64, lipo'd), because the app itself is
# universal and @electron/universal needs identical files in both halves. Linux is built for
# the host architecture; CI runs it inside an old Debian so the binary's glibc floor is
# well below anything Electron itself still runs on.
#
# To bump the version, update FFMPEG_VERSION and FFMPEG_SHA256 together.

set -euo pipefail

FFMPEG_VERSION="8.1.3"
FFMPEG_SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES="$ROOT/resources"
TARGET="$RESOURCES/ffmpeg"
WORK="$RESOURCES/.ffmpeg-build"
TARBALL="$WORK/ffmpeg-${FFMPEG_VERSION}.tar.xz"

log() { echo "[ffmpeg] $*"; }
fail() { echo "[ffmpeg] $*" >&2; exit 1; }

if [[ -f "$TARGET" && "${1:-}" != "--force" ]]; then
  log "resources/ffmpeg already present — pass --force to rebuild"
  exit 0
fi

OS="$(uname -s)"
case "$OS" in
  Darwin | Linux) ;;
  *) fail "this script builds for macOS and Linux; Windows uses scripts/fetch-ffmpeg.mjs" ;;
esac

mkdir -p "$WORK"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if [[ ! -f "$TARBALL" || "$(sha256 "$TARBALL")" != "$FFMPEG_SHA256" ]]; then
  log "downloading ffmpeg ${FFMPEG_VERSION} source"
  curl -sSfL -o "$TARBALL" "$FFMPEG_URL"
fi

GOT="$(sha256 "$TARBALL")"
if [[ "$GOT" != "$FFMPEG_SHA256" ]]; then
  rm -f "$TARBALL"
  fail "digest mismatch — refusing to build this source.
         expected $FFMPEG_SHA256
         got      $GOT"
fi
log "source digest verified"

# The whole program. Everything not listed here is off.
#
#   indev      the microphone (avfoundation / alsa, added per platform below)
#   decoders   whatever sample format the device hands over — CoreAudio usually gives
#              32-bit float, ALSA usually s16, USB interfaces anything at all
#   aresample  -ar 16000 / -ac 1; aformat/anull/atrim are selected by the ffmpeg CLI itself
#   pcm_s16le  the raw output muxer (`-f s16le`), written to stdout through the pipe protocol.
#              configure knows it by its component name, not its -f name: `--enable-muxer=s16le`
#              matches nothing, silently, and yields an ffmpeg that cannot write its output
COMMON_FLAGS=(
  --disable-everything
  --disable-autodetect
  --disable-doc
  --disable-debug
  --disable-network
  --disable-ffplay
  --disable-ffprobe
  --disable-asm
  --enable-small
  --enable-pthreads
  --enable-ffmpeg
  --enable-swresample
  --enable-protocol=pipe,file
  --enable-muxer=pcm_s16le,wav
  --enable-encoder=pcm_s16le
  --enable-decoder=pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_u8
  --enable-filter=aresample,aformat,anull,atrim,volume
)

JOBS="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# build_one <arch> <out> [extra configure flags...]
build_one() {
  local arch="$1" out="$2"
  shift 2
  local src="$WORK/src-$arch"

  rm -rf "$src"
  mkdir -p "$src"
  tar -xJf "$TARBALL" -C "$src" --strip-components=1

  log "configuring for $arch"
  (
    cd "$src"
    ./configure "${COMMON_FLAGS[@]}" "$@" >"$WORK/configure-$arch.log" 2>&1 ||
      { tail -40 "$WORK/configure-$arch.log"; tail -60 ffbuild/config.log 2>/dev/null; exit 1; }
    log "compiling for $arch (-j$JOBS)"
    make -j"$JOBS" ffmpeg >"$WORK/make-$arch.log" 2>&1 || { tail -60 "$WORK/make-$arch.log"; exit 1; }
  )
  cp "$src/ffmpeg" "$out"
}

if [[ "$OS" == "Darwin" ]]; then
  # The app's own floor: Electron 33 supports macOS 10.15+, and arm64 starts at 11.
  MAC_FLAGS=(
    --target-os=darwin
    --enable-avfoundation
    --enable-indev=avfoundation
  )
  build_one arm64 "$WORK/ffmpeg-arm64" "${MAC_FLAGS[@]}" \
    --arch=arm64 --enable-cross-compile --cc="clang -arch arm64" \
    --extra-cflags="-mmacosx-version-min=11.0" --extra-ldflags="-mmacosx-version-min=11.0"
  build_one x86_64 "$WORK/ffmpeg-x86_64" "${MAC_FLAGS[@]}" \
    --arch=x86_64 --enable-cross-compile --cc="clang -arch x86_64" \
    --extra-cflags="-mmacosx-version-min=10.15" --extra-ldflags="-mmacosx-version-min=10.15"
  lipo -create "$WORK/ffmpeg-arm64" "$WORK/ffmpeg-x86_64" -output "$TARGET"
else
  # ALSA, not PulseAudio: libasound.so.2 is on every machine Electron runs on (Chromium links
  # it), where libpulse is not — and a binary that cannot load a library cannot start at all.
  # On a PipeWire or PulseAudio desktop the ALSA "default" device is routed through the sound
  # server anyway, so it is the microphone chosen in the system's sound settings.
  build_one "$(uname -m)" "$TARGET" --enable-alsa --enable-indev=alsa
fi

chmod +x "$TARGET"
strip "$TARGET" 2>/dev/null || true

# configure ignores component names it does not know, so a typo in COMMON_FLAGS still builds —
# an ffmpeg that opens the microphone and then dies on "Requested output format 's16le' is not
# known". Catch that here rather than in a shipped installer.
if ! "$TARGET" -hide_banner -muxers 2>/dev/null | grep -qE '^ *E +s16le '; then
  rm -f "$TARGET"
  fail "built ffmpeg has no s16le muxer — check --enable-muxer in COMMON_FLAGS"
fi

# The LGPL asks that the licence travel with the binary; electron-builder ships this file
# next to ffmpeg in the package.
cp "$WORK/src-$( [[ "$OS" == "Darwin" ]] && echo arm64 || uname -m )/COPYING.LGPLv2.1" "$RESOURCES/ffmpeg-LICENSE.txt"

rm -rf "$WORK"/src-*

log "wrote resources/ffmpeg ($(du -h "$TARGET" | cut -f1)), devices:"
"$TARGET" -hide_banner -devices 2>/dev/null | sed -n '/--/,$p' | sed 's/^/[ffmpeg]   /' || true
