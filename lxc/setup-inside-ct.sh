#!/bin/bash
# Runs INSIDE the LXC (as root). The CT does NOT need internet — the bun
# binary, app files and .env are all pushed in from the Proxmox host.
# No apt, no package installs. Safe to re-run.
set -euo pipefail

APP_DIR=/opt/ipcam-honeypot
APP_USER=honeypot

[ -f /opt/provision/bun ] || { echo "error: /opt/provision/bun missing (push failed on host?)" >&2; exit 1; }

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

mkdir -p "$APP_DIR"
cp -a /opt/provision/src /opt/provision/package.json "$APP_DIR/"
cp -a /opt/provision/.env.example "$APP_DIR/.env"
if [ -f /opt/provision/.env.local ]; then
  # settings chosen by the installer (ports, Loki URL, ...)
  cp -a /opt/provision/.env.local "$APP_DIR/.env.local"
elif [ ! -f "$APP_DIR/.env.local" ]; then
  cp -a "$APP_DIR/.env" "$APP_DIR/.env.local"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

install -m 755 /opt/provision/bun /usr/local/bin/bun
install -m 644 /root/ipcam-honeypot.service /etc/systemd/system/ipcam-honeypot.service
mkdir -p "$APP_DIR/logs"
chown "$APP_USER:$APP_USER" "$APP_DIR/logs"
systemctl daemon-reload
systemctl enable ipcam-honeypot >/dev/null
systemctl restart ipcam-honeypot

HTTP_PORT=80
if [ -f "$APP_DIR/.env.local" ]; then
  HTTP_PORT=$(grep -E '^HTTP_PORT=' "$APP_DIR/.env.local" | cut -d= -f2 || true)
  HTTP_PORT=${HTTP_PORT:-80}
fi

echo "waiting for the honeypot to come up..."
for i in $(seq 1 20); do
  if grep -q ":$(printf '%04X' "$HTTP_PORT") " /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    echo "ipcam-honeypot is running (http on port ${HTTP_PORT}, rtsp 554, telnet 23):"
    ss -lnt || true
    exit 0
  fi
  sleep 1
done
echo "service did not open port ${HTTP_PORT} — check: journalctl -u ipcam-honeypot -e" >&2
exit 1
