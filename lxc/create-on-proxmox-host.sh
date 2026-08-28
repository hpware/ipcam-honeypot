#!/bin/bash
# Creates (or reuses) an unprivileged Debian LXC and provisions the honeypot
# into it. Everything is customizable via environment variables:
#
#   CTID=210          container id                      (default 210)
#   HOSTNAME=...      hostname                          (default ipcam-honeypot)
#   MEMORY=512        RAM in MB                         (default 512)
#   SWAP=256          swap in MB                        (default 256)
#   CORES=1           cpu cores                         (default 1)
#   DISK=2            root disk size in GB              (default 2)
#   STORAGE=local-lvm storage for the root disk         (default local-lvm)
#   BRIDGE=vmbr0      network bridge                    (default vmbr0)
#   VLAN=50           VLAN tag (empty = none)
#   IP=192.168.1.50/24  static IP (empty = DHCP)
#   GW=192.168.1.1    gateway for static IP
#   MTU=1500          interface MTU
#   FIREWALL=1        enable PVE firewall on the NIC
#   TAGS=honey,net    CT tags (PVE 7.3+)
#   NOTES="..."       CT notes/description
#   DNS=1.1.1.1       DNS server (empty = host setting)
#   UNPRIVILEGED=0    create privileged CT instead      (default unprivileged)
#   ONBOOT=1          start with host                   (default 1)
#   TEMPLATE=...      exact template name (empty = auto: newest debian-1[23]-standard for this arch)
#   TEMPLATE_STORE=local
set -euo pipefail

CTID=${CTID:-210}
HOSTNAME=${HOSTNAME:-ipcam-honeypot}
MEMORY=${MEMORY:-512}
SWAP=${SWAP:-256}
CORES=${CORES:-1}
DISK=${DISK:-2}
STORAGE=${STORAGE:-local-lvm}
BRIDGE=${BRIDGE:-vmbr0}
VLAN=${VLAN:-}
IP=${IP:-}
GW=${GW:-}
MTU=${MTU:-}
FIREWALL=${FIREWALL:-0}
TAGS=${TAGS:-}
NOTES=${NOTES:-}
DNS=${DNS:-}
UNPRIVILEGED=${UNPRIVILEGED:-1}
ONBOOT=${ONBOOT:-1}
TEMPLATE=${TEMPLATE:-}
TEMPLATE_STORE=${TEMPLATE_STORE:-local}

cd "$(dirname "$0")/.."

# host architecture decides both the template and the bun binary
case "$(uname -m)" in
  x86_64) PKGARCH=amd64; BUNARCH=x64 ;;
  aarch64) PKGARCH=arm64; BUNARCH=arm64 ;;
  *) echo "error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if ! pct status "$CTID" >/dev/null 2>&1; then
  pveam update >/dev/null
  if [ -n "$TEMPLATE" ]; then
    # exact template requested — download it if missing
    if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
      pveam download "$TEMPLATE_STORE" "$TEMPLATE"
    fi
  else
    # auto: newest standard template matching this host's architecture
    TEMPLATE=$(pveam available | awk '{print $NF}' | grep -E "^debian-1[23]-standard_.*_${PKGARCH}\.tar\.zst$" | sort -V | tail -1)
    [ -n "$TEMPLATE" ] || { echo "error: no debian-1x-standard ${PKGARCH} template found in pveam available" >&2; exit 1; }
    if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
      pveam download "$TEMPLATE_STORE" "$TEMPLATE"
    fi
  fi
  echo "==> using template: $TEMPLATE"

  NET="name=eth0,bridge=${BRIDGE}"
  if [ -n "$VLAN" ]; then NET="${NET},tag=${VLAN}"; fi
  if [ -n "$IP" ]; then
    NET="${NET},ip=${IP}"
    [ -n "$GW" ] && NET="${NET},gw=${GW}"
  else
    NET="${NET},ip=dhcp"
  fi
  if [ -n "$MTU" ]; then NET="${NET},mtu=${MTU}"; fi
  if [ "$FIREWALL" = "1" ]; then NET="${NET},firewall=1"; fi

  CREATE_ARGS=(
    --hostname "$HOSTNAME"
    --unprivileged "$UNPRIVILEGED"
    --features nesting=1
    --memory "$MEMORY" --swap "$SWAP" --cores "$CORES"
    --rootfs "${STORAGE}:${DISK}"
    --net0 "$NET"
    --onboot "$ONBOOT"
  )
  [ -n "$TAGS" ] && CREATE_ARGS+=(--tags "$TAGS")
  [ -n "$NOTES" ] && CREATE_ARGS+=(--description "$NOTES")
  [ -n "$DNS" ] && CREATE_ARGS+=(--nameserver "$DNS")

  pct create "$CTID" "${TEMPLATE_STORE}:vztmpl/${TEMPLATE}" "${CREATE_ARGS[@]}"
fi

# Debian 13 (systemd 257) needs nesting in unprivileged CTs; heal CTs created
# before this default, and make sure an existing stopped CT is running.
pct set "$CTID" --features nesting=1 >/dev/null 2>&1 || true
pct start "$CTID" >/dev/null 2>&1 || true

# The CT may live on an isolated VLAN with no internet — everything it needs
# is fetched on the HOST and pushed in.
echo "==> fetching bun (host-side; the CT needs no internet)"
BUN_VERSION=${BUN_VERSION:-1.2.20}
BUN_ZIP=${BUN_ZIP:-/tmp/bun-linux-${BUNARCH}.zip}
if [ ! -f "$BUN_ZIP" ]; then
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUNARCH}.zip" -o "$BUN_ZIP"
fi
if ! command -v unzip >/dev/null 2>&1; then
  apt-get install -y unzip >/dev/null    # host-side only; the CT stays offline
fi
rm -rf /tmp/bun-extract && mkdir -p /tmp/bun-extract
unzip -q -o "$BUN_ZIP" -d /tmp/bun-extract
BUN_BIN=$(find /tmp/bun-extract -type f -name bun | head -1)
[ -n "$BUN_BIN" ] || { echo "error: bun binary not found in $BUN_ZIP" >&2; exit 1; }

echo "==> waiting for an IPv4 address on eth0 (30s, not fatal)"
NET_OK=0
for i in $(seq 1 30); do
  if pct exec "$CTID" -- sh -c "ip -4 addr show dev eth0 2>/dev/null | grep -q 'inet '" 2>/dev/null; then
    NET_OK=1
    break
  fi
  sleep 1
done
if [ "$NET_OK" != 1 ]; then
  echo "warn: no IPv4 on eth0 — the CT has no IP (no DHCP on this bridge/VLAN?)." >&2
  echo "      provisioning continues, but the honeypot is unreachable until the" >&2
  echo "      CT gets an address (re-run the installer and choose a static IP)." >&2
fi

echo "==> copying app..."
pct exec "$CTID" -- mkdir -p /opt/provision
TARPATHS="src package.json .env.example"
[ -d assets/www ] && TARPATHS="$TARPATHS assets/www"   # real firmware UI (scripts/fetch-www.sh)
tar cf - $TARPATHS \
  | pct exec "$CTID" -- tar xf - -C /opt/provision
pct push "$CTID" "$BUN_BIN" /opt/provision/bun
pct push "$CTID" lxc/setup-inside-ct.sh /root/setup.sh
pct push "$CTID" lxc/ipcam-honeypot.service /root/ipcam-honeypot.service

# app-level settings chosen by the installer (written before setup runs)
APPENV=""
for v in HTTP_PORT RTSP_PORT TELNET_PORT BIND_HOST LOKI_URL LOKI_TENANT_ID; do
  if [ -n "${!v:-}" ]; then APPENV+="${v}=${!v}"$'\n'; fi
done
if [ -n "$APPENV" ]; then
  printf '%s' "$APPENV" | pct exec "$CTID" -- sh -c 'cat > /opt/provision/.env.local'
fi

echo "provisioning..."
pct exec "$CTID" -- bash /root/setup.sh

IPADDR=$(pct exec "$CTID" -- sh -c "ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+)+'" || true)
echo
echo "honeypot CT $CTID is up: http://${IPADDR:-<ct-ip>}  rtsp://${IPADDR:-<ct-ip>}:554  telnet://${IPADDR:-<ct-ip>}"
echo "logs: pct exec $CTID -- journalctl -u ipcam-honeypot -f"
