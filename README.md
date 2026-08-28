# ipcam-honeypot

A low-interaction IP camera honeypot that impersonates the **D-Link DCS-2130 /
Pelco IDE10DN** (both run the same OEM firmware: Boa HTTPd + a shared rtspd).
Attackers get a believable camera; you get every request, credential and
command shipped to **Grafana Loki** for analysis — Cowrie-style behavior
capture for web cams.

## Fingerprint parity

Verified against a real device with `nmap -sV`:

```
PORT     STATE SERVICE VERSION
8080/tcp open  http    Boa HTTPd 0.94.14rc21        <- real device: same (port 80)
8554/tcp open  rtsp    D-Link DCS-2130 or Pelco IDE10DN webcam rtspd
Service Info: Device: webcam; CPE: cpe:/h:pelco:ide10dn
```

The RTSP listener answers nmap's `RTSPRequest` probe with the byte-exact
`400 Bad Request` (Date + Allow only, no Server header) the real firmware
sends — that is the signature nmap matches on. The HTTP listener replies
`HTTP/1.0` with `Date:` before `Server: Boa/0.94.14rc21` for the same reason.

## What's emulated

| Service | Default port | Details |
| --- | --- | --- |
| HTTP (Boa) | 8080 | DCS-2130 web UI (login form, live video page, setup pages), NIPCA endpoints (`/image/jpeg.cgi`, `/video/mjpg.cgi`, `/dms`, `/ipcam/stream.cgi`), Pelco aliases (`/jpeg`, `/jpeg/qvga.jpg`, `/jpeg/pull`) |
| RTSP | 8554 | OPTIONS / DESCRIBE (H264 SDP) / SETUP / PLAY / PAUSE / TEARDOWN for `/live1.sdp`, `/1/stream1`, `/stream1`; `Authorization: Basic` values captured (CVE-2017-8410 overflow probes) |
| Telnet | 2323 | generic telnetd fingerprint, then a BusyBox v1.19.4 shell backed by a virtual camera filesystem: `ls`/`cat /etc/passwd`/`ps` (boa, rtspd)/`uname -a` (Linux 2.6.31.8, armv5tejl)/`ifconfig`/`netstat`/`busybox` applet list, `wget`/`ping`/`reboot` attempts logged, unknown commands get `sh: x: not found` (Cowrie-lite) |

Classic exploit endpoints are emulated against the shared virtual shell
(`src/vsh.ts`) — injected commands are logged, never executed:

| Endpoint | Emulates |
| --- | --- |
| `/cgi-bin/rtpd.cgi?...` | CVE-2013-1599: query `&`→space parsing, `;` chains answered from the virtual shell (`uname -a`, `cat /etc/passwd`, ...) |
| `/docmd.htm` | post-bypass command exec page; 401s first so reused creds get captured |
| `/frame/GetConfig` | unauth config disclosure (DCS-930L family); XOR-obfuscated blob seeded with **honeycreds** (`admin`/`admin1234`) — reuse of them in later logins ties attacker sessions together |
| `/upnp/asf-mp4.asf` | CVE-2013-1600 unauth stream (ASF header + JPEG payload) |
| `/md/lums.cgi` | CVE-2013-1601 unauth ASCII luminance stream |

Media endpoints serve a live feed: gray sensor-noise frames with a burned-in
timestamp OSD, JPEG-encoded at runtime by a pure-TS baseline encoder
(`src/framegen.ts`, no native deps). One frame per second per size is rendered
and shared by every client — like a real camera, there is only one sensor.
MJPEG endpoints stream 640x360, snapshots come out at 1280x720. Anything is
accepted as credentials so attackers go deeper and get logged. All requests
(including malformed probe
garbage) are captured: method, raw target, headers, body, extracted creds.

## Run it

```sh
bun install
bun run start
```

To mirror the real device 1:1 (ports 80/554 need root):

```sh
sudo env HTTP_PORT=80 RTSP_PORT=554 $(which bun) src/index.ts
```

`nmap -sV <your-ip>` should then produce the exact output shown above.

Or run it as an unprivileged LXC on Proxmox — see [`lxc/`](lxc/README.md):

```sh
CTID=210 bash lxc/create-on-proxmox-host.sh
```

## Loki + Grafana

```sh
cd compose && docker compose up -d   # loki :3100, grafana :3001
```

The honeypot batches events and pushes them to
`LOKI_URL` (default `http://127.0.0.1:3100`) every 2s; everything is also
appended to `logs/honeypot.ndjson` so nothing is lost when Loki is down.

Grafana is at http://localhost:3001 (admin/admin) with a Loki datasource
pre-provisioned. Useful LogQL:

```logql
# everything, parsed
{job="ipcam-honeypot"} | json

# credential harvest across all services
{job="ipcam-honeypot"} | json | auth_kind!="" | line_format "{{.src_ip}} {{.auth_kind}} {{.auth_user}} / {{.auth_password}}"

# top attackers
topk(10, sum by (src_ip) (count_over_time({job="ipcam-honeypot"} | json [1h])))

# telnet commands (mirai-style)
{job="ipcam-honeypot", camera="telnet"} | json | note!="" | line_format "{{.src_ip}}: {{.note}}"

# probing paths
sum by (path) (count_over_time({job="ipcam-honeypot", proto="http"} | json [24h]))
```

Event shape (one JSON object per line):

```json
{"camera":"dlink","proto":"http","src_ip":"1.2.3.4","method":"POST","path":"/login.cgi","status":302,"user_agent":"...","headers":{...},"body":"username=admin&password=1234","auth":{"user":"admin","password":"1234","kind":"form"}}
```

`camera` is `dlink` / `pelco` / `rtsp` / `rtsp-dlink` / `rtsp-pelco` / `telnet`;
`auth.kind` is `basic` / `form` / `query` / `json` / `telnet`.

## Config

Copy `.env.example` to `.env` — ports, bind host, `PERSONAS` (`both|dlink|pelco`),
Loki URL/tenant, log file, `VERBOSE=1` to dump full headers/bodies to stdout.

## Notes

- Keep the honeypot isolated (dedicated IP / VLAN / firewall rules). It
  intentionally accepts any credential — do not run it on a host with real
  services.
- The snapshot JPEG is generated (`scripts/gen-assets.ts`), no copyrighted
  footage involved.
- Logs contain attacker-supplied strings unescaped — treat them as data.
