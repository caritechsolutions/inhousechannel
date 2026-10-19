#!/usr/bin/env bash
# inhousechannel player installer — idempotent, Ubuntu 20.04/22.04/24.04, run as root:
#   curl -fsSL https://raw.githubusercontent.com/caritechsolutions/inhousechannel/main/player/install.sh | sudo bash
# Optional env: IHC_SERVER_URL IHC_PLAYER_KEY IHC_MCAST IHC_PORT IHC_RESOLUTION IHC_SERVICE_NAME
#               IHC_BRANCH (default main)  IHC_NO_START=1 (install only)
set -euo pipefail

REPO="https://github.com/caritechsolutions/inhousechannel"
BRANCH="${IHC_BRANCH:-main}"
BASE=/opt/inhousechannel
SRC=$BASE/src
APP=$BASE/player
BIN=$BASE/bin
CONF=/etc/inhousechannel/player.conf
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
. /etc/os-release
case "${VERSION_ID:-}" in 20.04|22.04|24.04) ;; *) echo "WARNING: untested Ubuntu ${VERSION_ID:-?}, continuing";; esac

say "apt packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates python3 python3-venv xvfb vainfo \
  intel-media-va-driver-non-free ffmpeg fonts-dejavu-core fonts-liberation >/dev/null

say "VAAPI hardware encoder check"
[ -e /dev/dri/renderD128 ] || die "/dev/dri/renderD128 missing: no GPU render node (kernel/i915 driver?)"
if ! LIBVA_DRIVER_NAME=iHD vainfo --display drm --device /dev/dri/renderD128 2>/dev/null | grep -q 'VAProfileH264.*VAEntrypointEncSlice'; then
  # older vainfo has no --display/--device; fall back to the plain call
  LIBVA_DRIVER_NAME=iHD vainfo 2>/dev/null | grep -q 'VAProfileH264.*VAEntrypointEncSlice' \
    || die "no H.264 hardware encode (VAEntrypointEncSlice) via iHD — this box cannot run the player"
fi
echo "H.264 hardware encode: OK (iHD)"

say "Google Chrome"
if ! command -v google-chrome >/dev/null; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq "$tmp/chrome.deb" >/dev/null
  rm -rf "$tmp"
fi
echo "$(google-chrome --version)"

say "source → $SRC (branch $BRANCH)"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q origin "$BRANCH" && git -C "$SRC" reset -q --hard "origin/$BRANCH"
else
  rm -rf "$SRC"; git clone -q --depth 1 -b "$BRANCH" "$REPO" "$SRC"
fi
echo "at $(git -C "$SRC" rev-parse --short HEAD): $(git -C "$SRC" log -1 --format=%s)"

say "python environment → $APP"
mkdir -p "$APP" "$BIN" /var/lib/inhousechannel /etc/inhousechannel
[ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv"
rm -rf "$APP/inhousechannel"
cp -r "$SRC/player/inhousechannel" "$APP/inhousechannel"
# the package is imported from $APP: make it importable without pip
echo "$APP" > "$APP/venv/lib/python$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')/site-packages/inhousechannel.pth"
install -m 755 "$SRC/player/inhousechannel-player" /usr/local/bin/inhousechannel-player

say "own ffmpeg (optional, needed for video regions)"
if [ -x "$BIN/ffmpeg" ]; then
  echo "present: $("$BIN/ffmpeg" -version | head -1)"
else
  echo "not installed yet — using system $(ffmpeg -version | head -1 | cut -d' ' -f1-3). Video regions need the own build (build order step 5)."
fi

say "configuration $CONF"
if [ -f "$CONF" ] && [ -z "${IHC_SERVER_URL:-}" ] && [ -z "${IHC_PLAYER_KEY:-}" ]; then
  echo "kept existing $CONF"
else
  if [ -z "${IHC_SERVER_URL:-}" ] && [ -t 0 ]; then
    read -rp "Content server URL (blank for now is fine): " IHC_SERVER_URL; export IHC_SERVER_URL
    read -rp "Player key (blank for now is fine): " IHC_PLAYER_KEY; export IHC_PLAYER_KEY
    read -rp "Multicast address [239.1.1.10]: " a; export IHC_MCAST="${a:-239.1.1.10}"
    read -rp "UDP port [1234]: " p; export IHC_PORT="${p:-1234}"
  fi
  "$APP/venv/bin/python" -m inhousechannel init
fi
grep -E '^(address|port|resolution) ' "$CONF" | sed 's/^/  /'

say "systemd"
install -m 644 "$SRC/player/inhousechannel-player.service" /etc/systemd/system/inhousechannel-player.service
systemctl daemon-reload
systemctl enable -q inhousechannel-player
if [ -z "${IHC_NO_START:-}" ]; then
  systemctl restart inhousechannel-player
  sleep 6
  systemctl --no-pager --lines=5 status inhousechannel-player || true
  say "self-test (10 s encode of the live display, with the player running)"
  "$APP/venv/bin/python" -m inhousechannel selftest --seconds 10 || echo "self-test FAILED — see output above"
fi

say "done"
echo "  status:   inhousechannel-player status"
echo "  preview:  inhousechannel-player preview /tmp/frame.png"
echo "  logs:     journalctl -u inhousechannel-player -f"
echo "  stream:   udp://$(grep -E '^address ' "$CONF" | awk '{print $3}'):$(grep -E '^port ' "$CONF" | awk '{print $3}')"
