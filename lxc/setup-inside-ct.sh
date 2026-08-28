#!/bin/bash
# Runs INSIDE the LXC (as root): installs Bun, creates a locked-down service
# user, installs the app + systemd unit. Idempotent — safe to re-run.
set -euo pipefail

APP_DIR=/opt/ipcam-honeypot
APP_USER=honeypot
BUN_VERSION=${BUN_VERSION:-1.2.20}

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl unzip iproute2

if [ ! -x /usr/local/bin/bun ]; then
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip
  unzip -q -o /tmp/bun.zip -d /tmp/bun-extract
  install -m 755 "/tmp/bun-extract/bun-linux-x64/bun" /usr/local/bin/bun
  rm -rf /tmp/bun.zip /tmp/bun-extract
fi
/usr/local/bin/bun --version

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

mkdir -p "$APP_DIR"
cp -a /opt/provision/src /opt/provision/package.json "$APP_DIR/"
cp -a /opt/provision/.env.example "$APP_DIR/.env"
[ -f "$APP_DIR/.env.local" ] || cp -a "$APP_DIR/.env" "$APP_DIR/.env.local"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

install -m 644 /root/ipcam-honeypot.service /etc/systemd/system/ipcam-honeypot.service
systemctl daemon-reload
systemctl enable --now ipcam-honeypot

echo "waiting for the honeypot to come up..."
for i in $(seq 1 20); do
  if ss -lnt | grep -q ':8080'; then
    echo "ipcam-honeypot is running:"
    ss -lnt | grep -E ':(8080|8554|2323)'
    exit 0
  fi
  sleep 1
done
echo "service did not open port 8080 — check: journalctl -u ipcam-honeypot -e" >&2
exit 1
