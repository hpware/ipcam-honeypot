# LXC deployment (Proxmox VE)

Runs the honeypot as an **unprivileged Debian 12 LXC** with a hardened systemd
unit. The app has zero npm dependencies, so provisioning only needs the Bun
binary plus `src/`.

## One-shot from the Proxmox host

```sh
cd ipcam-honeypot
CTID=210 VLAN=50 bash lxc/create-on-proxmox-host.sh
```

Variables (all optional): `CTID`, `HOSTNAME`, `MEMORY`, `SWAP`, `CORES`,
`DISK`, `STORAGE`, `BRIDGE`, `VLAN`, `TEMPLATE`, `TEMPLATE_STORE`.

The script:

1. downloads the Debian 12 template if missing and creates an unprivileged CT
   (DHCP on `vmbr0`, optional VLAN tag — put the CT on an isolated VLAN, see
   "Isolation" below)
2. pushes `src/`, `package.json`, `.env.example` and the unit file into the CT
3. runs `setup-inside-ct.sh`: installs Bun to `/usr/local/bin`, creates the
   locked `honeypot` user, installs to `/opt/ipcam-honeypot`, enables and
   starts `ipcam-honeypot.service`

Then:

```sh
pct exec 210 -- journalctl -u ipcam-honeypot -f
# http://<ct-ip>  rtsp://<ct-ip>:554  telnet://<ct-ip>
```

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
