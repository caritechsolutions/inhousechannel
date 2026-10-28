#!/usr/bin/env bash
# inhousechannel content server installer — idempotent, Ubuntu 22.04/24.04, run as root:
#   curl -fsSL https://raw.githubusercontent.com/caritechsolutions/inhousechannel/main/server/install.sh | sudo bash
#
# First run: Node.js 20 (NodeSource keyring + apt source, no remote script execution), ffmpeg,
# clones the repo to /opt/inhousechannel/src, creates the inhousechannel system user and
# /var/lib/inhousechannel/server, installs the systemd unit, seeds the superadmin.
# Every run: updates the checkout, npm ci in server/ (and admin/ + build when it exists),
# restarts the service, checks /healthz, prints the Nginx Proxy Manager settings.
#
# Optional environment (pass as `sudo IHC_ADMIN_EMAIL=... bash`):
#   IHC_ADMIN_EMAIL / IHC_ADMIN_PASSWORD  first superadmin (else prompted on /dev/tty)
#   IHC_PUBLIC_URL   what the pairing command shows players (default https://signage.caritech.net)
#   IHC_BRANCH       git branch (default main)      IHC_REPO  git URL
#   IHC_NODE_MAJOR   Node.js major from NodeSource (default 20)
set -euo pipefail

# Everything lives inside main() so bash parses the whole script before running any of it —
# required when piped from curl and when this file is replaced underneath us by the git update.
main() {
  local REPO BRANCH BASE SRC DATA SERVICE NODE_MAJOR PUBLIC_URL ENVFILE
  REPO="${IHC_REPO:-https://github.com/caritechsolutions/inhousechannel.git}"
  BRANCH="${IHC_BRANCH:-main}"
  BASE=/opt/inhousechannel
  SRC="$BASE/src"
  DATA=/var/lib/inhousechannel/server
  SERVICE=inhousechannel-server
  NODE_MAJOR="${IHC_NODE_MAJOR:-20}"
  PUBLIC_URL="${IHC_PUBLIC_URL:-https://signage.caritech.net}"
  ENVFILE=/etc/inhousechannel/server.env
  export DEBIAN_FRONTEND=noninteractive

  say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
  warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*" >&2; }
  die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
  # stdin is the curl pipe, so prompts read the controlling terminal when there is one
  have_tty() { [ -e /dev/tty ] && ( : < /dev/tty ) 2>/dev/null; }

  [ "$(id -u)" = 0 ] || die "run as root: curl -fsSL <url> | sudo bash"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${VERSION_ID:-}" in 22.04|24.04) ;; *) warn "untested on ${PRETTY_NAME:-this OS}; continuing";; esac
  fi

  say "apt packages"
  apt-get update -qq </dev/null
  apt-get install -y -qq git curl ca-certificates gnupg ffmpeg build-essential python3 </dev/null >/dev/null
  echo "$(ffmpeg -version | head -1 | cut -d' ' -f1-3) present"

  say "Node.js ${NODE_MAJOR}.x"
  local node_ok=0 nv
  if command -v node >/dev/null 2>&1; then
    nv="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$nv" -ge "$NODE_MAJOR" ] 2>/dev/null && node_ok=1
  fi
  if [ "$node_ok" -eq 1 ]; then
    echo "node $(node --version) present at $(command -v node)"
  else
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key </dev/null \
      | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq </dev/null
    apt-get install -y -qq nodejs </dev/null >/dev/null
    echo "installed node $(node --version), npm $(npm --version)"
  fi
  command -v npm >/dev/null 2>&1 || die "npm not found after Node.js install"
  [ -x /usr/bin/node ] || ln -sf "$(command -v node)" /usr/bin/node   # the unit uses /usr/bin/node

  say "system user + data dir"
  id -u inhousechannel >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin inhousechannel
  install -d -m 0750 -o inhousechannel -g inhousechannel "$DATA" "$DATA/media" "$DATA/thumbs" "$DATA/tmp"
  install -d -m 0755 /etc/inhousechannel

  say "source → $SRC (branch $BRANCH)"
  if [ -d "$SRC/.git" ]; then
    if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
      die "$SRC has local modifications; commit/stash/discard them, then re-run"
    fi
    git -C "$SRC" remote set-url origin "$REPO"
    git -C "$SRC" fetch -q --prune origin "$BRANCH" </dev/null
    git -C "$SRC" checkout -q -B "$BRANCH" "origin/$BRANCH"
  elif [ -e "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null)" ]; then
    die "$SRC exists but is not a git checkout; move it aside and re-run"
  else
    mkdir -p "$BASE"
    git clone -q --branch "$BRANCH" "$REPO" "$SRC" </dev/null
  fi
  echo "at $(git -C "$SRC" rev-parse --short HEAD): $(git -C "$SRC" log -1 --format=%s)"

  say "npm ci (server)"
  (cd "$SRC/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error </dev/null)
  if [ -f "$SRC/admin/package.json" ]; then
    say "npm ci + build (admin)"
    (cd "$SRC/admin" && npm ci --no-audit --no-fund --loglevel=error </dev/null && npm run build --silent </dev/null)
  else
    echo "admin/ not present yet — the server serves a placeholder at /admin"
  fi
  # the service runs as inhousechannel and only writes under $DATA; the code stays root-owned
  chown -R root:root "$SRC"
  chmod -R a+rX "$SRC"

  say "environment $ENVFILE"
  if [ ! -f "$ENVFILE" ]; then
    printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL" > "$ENVFILE"
    chmod 0640 "$ENVFILE"; chgrp inhousechannel "$ENVFILE"
    echo "wrote PUBLIC_URL=$PUBLIC_URL"
  else
    echo "kept existing $ENVFILE"
  fi

  say "systemd unit $SERVICE"
  install -m 0644 "$SRC/server/inhousechannel-server.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable -q "$SERVICE"

  say "superadmin"
  local users email pass
  users="$(cd "$SRC/server" && sudo -u inhousechannel env IHC_DATA="$DATA" node src/cli.js count-users)"
  if [ "$users" = "0" ]; then
    email="${IHC_ADMIN_EMAIL:-}"; pass="${IHC_ADMIN_PASSWORD:-}"
    if [ -z "$email" ] || [ -z "$pass" ]; then
      if have_tty; then
        [ -n "$email" ] || read -rp "Superadmin email: " email < /dev/tty
        while [ -z "$pass" ]; do
          read -rsp "Superadmin password (min 8 chars): " pass < /dev/tty; echo
          [ "${#pass}" -ge 8 ] || { echo "too short"; pass=""; }
        done
      else
        warn "no users yet and no terminal — set IHC_ADMIN_EMAIL / IHC_ADMIN_PASSWORD and re-run, or:"
        warn "  cd $SRC/server && sudo -u inhousechannel IHC_DATA=$DATA node src/cli.js create-superadmin <email> <password>"
      fi
    fi
    if [ -n "$email" ] && [ -n "$pass" ]; then
      (cd "$SRC/server" && sudo -u inhousechannel env IHC_DATA="$DATA" node src/cli.js create-superadmin "$email" "$pass")
    fi
  else
    echo "$users user(s) exist — not seeding"
  fi

  say "start"
  systemctl restart "$SERVICE"
  local i=0
  until curl -fsS http://127.0.0.1:3100/healthz >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 30 ] || { journalctl -u "$SERVICE" -n 30 --no-pager; die "$SERVICE did not answer on 127.0.0.1:3100"; }
    sleep 1
  done
  echo "healthz: $(curl -fsS http://127.0.0.1:3100/healthz)"

  say "done"
  cat <<EOF
Service:   systemctl status $SERVICE   |   journalctl -u $SERVICE -f
Data:      $DATA (SQLite DB, media, thumbnails)
Public URL for pairing commands: $PUBLIC_URL  (edit $ENVFILE, then restart)

Nginx Proxy Manager → new Proxy Host:
  Domain:           ${PUBLIC_URL#*://}
  Scheme/host/port: http / <this VM's IP> / 3100   (listening on 127.0.0.1 — if NPM runs on
                    another box, set HOST=0.0.0.0 in $ENVFILE and firewall the port)
  Websockets:       on          Block common exploits: on
  SSL:              Let's Encrypt, Force SSL on, HTTP/2 on
  Advanced:         client_max_body_size 2048m;   proxy_read_timeout 600s;   (large video uploads)
Admin UI:  $PUBLIC_URL/admin   — players pair with:  inhousechannel-player pair $PUBLIC_URL <key>
EOF
}

main "$@"
