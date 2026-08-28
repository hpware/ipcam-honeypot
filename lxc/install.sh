#!/bin/bash
# Auto-installer for Proxmox VE — downloads this repo straight from GitHub and
# provisions an unprivileged LXC with the honeypot. Run ON the Proxmox host:
#
#   curl -fsSL https://raw.githubusercontent.com/hpware/ipcam-honeypot/main/lxc/install.sh | bash
#
# Env overrides: CTID, HOSTNAME, MEMORY, SWAP, CORES, DISK, STORAGE, BRIDGE,
#                VLAN, TEMPLATE, TEMPLATE_STORE, REPO, BRANCH
set -euo pipefail

REPO=${REPO:-hpware/ipcam-honeypot}
BRANCH=${BRANCH:-main}

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root on the Proxmox VE host" >&2
  exit 1
fi
if [ ! -x /usr/bin/pct ] || [ ! -x /usr/bin/pveam ]; then
  echo "error: pct/pveam not found — this must run on a Proxmox VE host, not inside a CT/VM" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading ${REPO}@${BRANCH} from GitHub"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" -o "$TMP/repo.tar.gz"
tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
cd "$SRC"

echo "==> creating + provisioning LXC"
export CTID HOSTNAME MEMORY SWAP CORES DISK STORAGE BRIDGE VLAN TEMPLATE TEMPLATE_STORE
bash lxc/create-on-proxmox-host.sh
