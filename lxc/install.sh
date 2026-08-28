#!/bin/bash
# Guided installer for Proxmox VE — downloads this repo and walks you through
# creating the honeypot LXC. Run ON the Proxmox host:
#
#   curl -fsSL https://raw.githubusercontent.com/hpware/ipcam-honeypot/main/lxc/install.sh | bash
#
# Prompts are read from /dev/tty, so this works even when piped through curl.
# For automation: NONINTERACTIVE=1 plus env vars (CTID, VLAN, IP, ...) skips
# all questions. See lxc/README.md for the full variable list.
set -euo pipefail

REPO=${REPO:-hpware/ipcam-honeypot}
BRANCH=${BRANCH:-main}

echo "==> ipcam-honeypot LXC installer v3 (guided)"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root on the Proxmox VE host" >&2
  exit 1
fi
if [ ! -d /etc/pve ] || ! command -v pct >/dev/null 2>&1; then
  echo "error: pct not found — this must run on a Proxmox VE host, not inside a CT/VM" >&2
  exit 1
fi
command -v pveam >/dev/null 2>&1 || {
  echo "error: pveam not found — is pve-manager installed on this host?" >&2
  exit 1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading ${REPO}@${BRANCH} from GitHub"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" -o "$TMP/repo.tar.gz"
tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
cd "$SRC"

# ---------------------------------------------------------------- wizard ---
# prompts go to /dev/tty so `curl | bash` still works interactively
TTY=""
if [ -e /dev/tty ] && [ -w /dev/tty ] && [ "${NONINTERACTIVE:-0}" != 1 ]; then
  TTY=/dev/tty
fi

ask() { # $1 var, $2 prompt, $3 default (env value wins as pre-filled default)
  local __var=$1 __prompt=$2 __def="${!1:-${3:-}}" __ans=""
  if [ -z "$TTY" ]; then printf -v "$__var" '%s' "$__def"; export "$__var"; return; fi
  if [ -n "$__def" ]; then printf '%s [%s]: ' "$__prompt" "$__def" >"$TTY"
  else printf '%s: ' "$__prompt" >"$TTY"; fi
  IFS= read -r __ans <"$TTY" || __ans=""
  printf -v "$__var" '%s' "${__ans:-$__def}"
  export "$__var"
}

ask_yn() { # $1 var(1/0), $2 prompt, $3 default y|n
  local __def=${3:-y} __ans=""
  if [ -z "$TTY" ]; then
    [ "$__def" = y ] && printf -v "$1" '%s' 1 || printf -v "$1" '%s' 0
    export "$1"; return
  fi
  while :; do
    if [ "$__def" = y ]; then printf '%s [Y/n]: ' "$2" >"$TTY"
    else printf '%s [y/N]: ' "$2" >"$TTY"; fi
    IFS= read -r __ans <"$TTY" || __ans=""
    __ans=${__ans:-$__def}
    case "${__ans,,}" in
      y|yes) printf -v "$1" '%s' 1; export "$1"; return ;;
      n|no)  printf -v "$1" '%s' 0; export "$1"; return ;;
    esac
  done
}

echo
echo "── Container ──────────────────────────────────────"

SUGGESTED=210
for id in $(seq 210 240); do
  if ! pct status "$id" >/dev/null 2>&1; then SUGGESTED=$id; break; fi
done
ask CTID "Container ID" "$SUGGESTED"
if pct status "$CTID" >/dev/null 2>&1; then
  ask_yn REUSE "CT $CTID already exists — reuse it and re-provision?" y
  [ "$REUSE" = 1 ] || { echo "aborted."; exit 1; }
fi
ask HOSTNAME "Hostname" ipcam-honeypot
ask MEMORY "Memory (MB)" 512
ask CORES "CPU cores" 1
ask DISK "Disk size (GB)" 2

DEF_STORAGE=$(pvesm status -content rootdir 2>/dev/null | awk '$3=="active"{print $1; exit}')
DEF_STORAGE=${DEF_STORAGE:-local-lvm}
ask STORAGE "Storage for root disk" "$DEF_STORAGE"
ask TEMPLATE_STORE "Template download storage" local

echo
echo "── Network ────────────────────────────────────────"

DEF_BRIDGE=$(ls /sys/class/net 2>/dev/null | grep -E '^vmbr' | head -1)
DEF_BRIDGE=${DEF_BRIDGE:-vmbr0}
ask BRIDGE "Bridge" "$DEF_BRIDGE"
ask VLAN "VLAN tag (blank = untagged)" ""
ask_yn STATIC "Use a static IP instead of DHCP?" n
IP=""; GW=""
if [ "$STATIC" = 1 ]; then
  ask IP "IP address (CIDR, e.g. 192.168.1.50/24)" ""
  while [ -z "$IP" ]; do ask IP "IP address (CIDR) is required" ""; done
  ask GW "Gateway" "$(cut -d. -f1-3 <<<"${IP%%/*}").1"
fi
ask MTU "Interface MTU (blank = default)" ""
ask_yn FIREWALL "Enable the PVE firewall on this NIC?" n

echo
echo "── Camera services ────────────────────────────────"

ask_yn STDPORTS "Use standard camera ports (HTTP 80, RTSP 554, telnet 23)?" y
if [ "$STDPORTS" = 1 ]; then
  HTTP_PORT=80; RTSP_PORT=554; TELNET_PORT=23
else
  ask HTTP_PORT "HTTP port" 8080
  ask RTSP_PORT "RTSP port" 8554
  ask TELNET_PORT "Telnet port" 2323
fi
ask LOKI_URL "Loki push URL for logs (blank = local file/journal only)" ""

echo
echo "── Summary ────────────────────────────────────────"
printf '  CT %s "%s"  %sMB RAM / %s core(s) / %sGB on %s\n' "$CTID" "$HOSTNAME" "$MEMORY" "$CORES" "$DISK" "$STORAGE"
printf '  net: %s tag=%s %s %s%s\n' "$BRIDGE" "${VLAN:-(none)}" "${IP:+static $IP gw $GW}" "${IP:-dhcp}" "${FIREWALL:+ (pve-fw)}"
printf '  ports: http %s / rtsp %s / telnet %s\n' "$HTTP_PORT" "$RTSP_PORT" "$TELNET_PORT"
printf '  logs: %s\n' "${LOKI_URL:-local NDJSON + journalctl}"
ask_yn PROCEED "Create the container with these settings?" y
[ "$PROCEED" = 1 ] || { echo "aborted."; exit 1; }
echo

# ------------------------------------------------------------------ deploy --
for v in CTID HOSTNAME MEMORY SWAP CORES DISK STORAGE BRIDGE VLAN IP GW MTU \
         FIREWALL TAGS NOTES DNS UNPRIVILEGED ONBOOT TEMPLATE TEMPLATE_STORE \
         HTTP_PORT RTSP_PORT TELNET_PORT LOKI_URL; do
  export "$v"
done
echo "==> creating + provisioning LXC"
bash lxc/create-on-proxmox-host.sh
