#!/bin/bash
# Run this ON the Proxmox VE host. Creates an unprivileged Debian 12 LXC and
# provisions the honeypot into it. Adjust the variables below first.
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
TEMPLATE=${TEMPLATE:-}   # empty = auto-pick newest debian-1x-standard
TEMPLATE_STORE=${TEMPLATE_STORE:-local}

cd "$(dirname "$0")/.."

if ! pct status "$CTID" >/dev/null 2>&1; then
  pveam update >/dev/null
  if [ -n "$TEMPLATE" ]; then
    # exact template requested — download it if missing
    if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
      pveam download "$TEMPLATE_STORE" "$TEMPLATE"
    fi
  else
    # auto: newest available standard template (Debian 12/13)
    TEMPLATE=$(pveam available | awk '{print $NF}' | grep -E '^debian-1[23]-standard_' | sort -V | tail -1)
    [ -n "$TEMPLATE" ] || { echo "error: no debian-1x-standard template found in pveam available" >&2; exit 1; }
    if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
      pveam download "$TEMPLATE_STORE" "$TEMPLATE"
    fi
  fi
  echo "==> using template: $TEMPLATE"
  NET="name=eth0,bridge=${BRIDGE},ip=dhcp$( [ -n "$VLAN" ] && echo ",tag=${VLAN}" )"
  pct create "$CTID" "${TEMPLATE_STORE}:vztmpl/${TEMPLATE}" \
    --hostname "$HOSTNAME" \
    --unprivileged 1 \
    --features nesting=0 \
    --memory "$MEMORY" --swap "$SWAP" --cores "$CORES" \
    --rootfs "${STORAGE}:${DISK}" \
    --net0 "$NET" \
    --onboot 1 --start 1
fi

echo "waiting for network..."
for i in $(seq 1 30); do
  pct exec "$CTID" -- cat /proc/net/route >/dev/null 2>&1 && break
  sleep 1
done

echo "copying app..."
pct exec "$CTID" -- mkdir -p /opt/provision
tar cf - src package.json .env.example \
  | pct exec "$CTID" -- tar xf - -C /opt/provision
pct push "$CTID" lxc/setup-inside-ct.sh /root/setup.sh
pct push "$CTID" lxc/ipcam-honeypot.service /root/ipcam-honeypot.service

echo "provisioning..."
pct exec "$CTID" -- bash /root/setup.sh

IP=$(pct exec "$CTID" -- sh -c "ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+)+'")
echo
echo "honeypot CT $CTID is up: http://$IP  rtsp://$IP:554  telnet://$IP"
echo "logs: pct exec $CTID -- journalctl -u ipcam-honeypot -f"
