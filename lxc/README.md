# LXC deployment (Proxmox VE)

Runs the honeypot as an **unprivileged Debian 12/13 LXC** with a hardened
systemd unit. The app has zero npm dependencies. **The CT itself needs no
internet** — Bun and the app files are downloaded on the Proxmox host and
pushed in — so the CT can live on an isolated VLAN with no outbound access
(the ideal honeypot setup). No apt packages are installed inside the CT.

## One-shot from the Proxmox host (guided)

```sh
curl -fsSL https://raw.githubusercontent.com/hpware/ipcam-honeypot/main/lxc/install.sh | bash
```

You'll be walked through everything with sensible defaults: container ID,
resources, storage, bridge, VLAN, DHCP vs static IP, PVE firewall, camera
ports, and where to ship logs (Loki URL). Prompts are read from `/dev/tty`,
so the curl-piped form works interactively. Nothing happens until you confirm
the summary.

Pre-seed answers via env vars attached to `bash` (they become the pre-filled
defaults — attach them to `bash`, not `curl`):

```sh
curl -fsSL https://raw.githubusercontent.com/hpware/ipcam-honeypot/main/lxc/install.sh \
  | CTID=210 VLAN=50 bash
```

Fully non-interactive (CI / scripts) — skips all prompts, uses env vars or
defaults:

```sh
curl -fsSL https://raw.githubusercontent.com/hpware/ipcam-honeypot/main/lxc/install.sh \
  | NONINTERACTIVE=1 CTID=210 IP=192.168.50.20/24 GW=192.168.50.1 bash
```

Or from a local checkout: `bash lxc/install.sh` (guided) or
`NONINTERACTIVE=1 CTID=210 VLAN=50 bash lxc/create-on-proxmox-host.sh` (direct).

## All container settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CTID` | `210` | container id |
| `HOSTNAME` | `ipcam-honeypot` | CT hostname |
| `MEMORY` / `SWAP` / `CORES` | `512` / `256` / `1` | resources |
| `DISK` | `2` | root disk size (GB) |
| `STORAGE` | `local-lvm` | storage for the root disk |
| `BRIDGE` | `vmbr0` | network bridge |
| `VLAN` | *(empty)* | VLAN tag on the NIC |
| `IP` | *(DHCP)* | static IP, e.g. `192.168.1.50/24` |
| `GW` | *(empty)* | gateway (required companion to `IP`) |
| `MTU` | *(empty)* | interface MTU |
| `FIREWALL` | `0` | `1` = enable PVE firewall on the NIC |
| `TAGS` | *(empty)* | PVE tags, comma separated |
| `NOTES` | *(empty)* | CT notes/description |
| `DNS` | *(host default)* | DNS server for the CT |
| `UNPRIVILEGED` | `1` | `0` = privileged CT (not recommended) |
| `ONBOOT` | `1` | start with the host |
| `TEMPLATE` | *(auto)* | exact template name; auto = newest `debian-12/13-standard` for the host arch |
| `TEMPLATE_STORE` | `local` | where templates are downloaded |

Debian 13's systemd 257 needs `nesting=1` in unprivileged CTs, so that is set
unconditionally (with a heal step for CTs created earlier without it).

## Manual (inside an existing CT)

```sh
tar cf - src package.json .env.example | pct exec <CTID> -- mkdir -p /opt/provision
# copy lxc/setup-inside-ct.sh + lxc/ipcam-honeypot.service into the CT, then:
bash setup-inside-ct.sh
```

## Config

Edit `/opt/ipcam-honeypot/.env.local` in the CT (Bun auto-loads `.env*` from
the working directory), then `systemctl restart ipcam-honeypot`. Ports default
to the standard camera ports — HTTP 80, RTSP 554, telnet 23. The unit grants
`CAP_NET_BIND_SERVICE` so the unprivileged `honeypot` user can bind them. To
use different ports, set `HTTP_PORT` / `RTSP_PORT` / `TELNET_PORT`.

## Isolation (read this)

- The CT is unprivileged and single-purpose — that is the isolation. Do **not**
  add real services to it.
- Enable the Proxmox firewall on the CT and only allow what you intend:
  `pct set 210 --firewall 1`, then rules in Datacenter → Firewall. Drop
  outbound from the CT if you want a pure sinkhole (the honeypot only ever
  calls your Loki instance).
- Loki/Grafana: run the `compose/` stack on a separate host or CT and point
  `LOKI_URL` at it in `.env.local`.

## Troubleshooting

- `bun` fails to start inside the CT → recreate with
  `--features nesting=1` (some older Proxmox/LXC combos need it for io_uring).
- No DHCP → set a static IP in the `--net0` line of the create script.
- Service loops on start → `journalctl -u ipcam-honeypot -e` (usually a bad
  `.env.local` value).
