import {
  type HttpResult,
  type Persona,
  type PersonaCtx,
  credsFrom,
  html,
  jpeg,
  mjpegStream,
  notFound,
  redirect,
  unauthorized,
} from "./common";
import { currentFrame } from "../framegen";
import { runCommandLine } from "../vsh";

// D-Link DCS-2130 web UI, as served by Boa HTTPd 0.94.14rc21 on the real device.
export const SERVER = "Boa/0.94.14rc21";
const REALM = "DCS-2130";

const page = (title: string, body: string) => `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>${title}</title>
<style type="text/css">
body { font: 12px Verdana, Arial, sans-serif; background:#ffffff; margin:0; }
#header { background:#1a5276; color:#fff; padding:8px 12px; font-weight:bold; }
#nav { background:#d6eaf8; padding:4px 12px; border-bottom:1px solid #aaa; }
#nav a { color:#1a5276; margin-right:14px; text-decoration:none; }
#content { padding:14px; }
#footer { margin-top:24px; padding:6px 12px; border-top:1px solid #aaa; color:#555; font-size:11px; }
table.f { border-collapse:collapse; }
table.f td { border:1px solid #999; padding:3px 8px; }
</style>
</head>
<body>
<div id="header">D-Link&nbsp;|&nbsp;DCS-2130 HD Wireless N Network Camera</div>
<div id="nav"><a href="/live.html">Live Video</a><a href="/setup/system.html">Setup</a><a href="/logout.html">Logout</a></div>
<div id="content">
${body}
</div>
<div id="footer">DCS-2130 A1&nbsp;&nbsp;|&nbsp;&nbsp;Firmware Version: 1.23.00&nbsp;&nbsp;|&nbsp;&nbsp;Copyright D-Link Corporation</div>
</body>
</html>`;

function handleGet(ctx: PersonaCtx, url: URL): HttpResult {
  switch (url.pathname) {
    case "/cgi-bin/rtpd.cgi": {
      // CVE-2013-1599 emulation (Core Security CORE-2013-0303): the real
      // rtpd.cgi evals QUERY_STRING after turning `&` into spaces, so
      // ?uname&-a;cat&/etc/passwd becomes `uname -a;cat /etc/passwd`.
      // We mirror that parsing and answer from the virtual shell —
      // every injected command line is logged, nothing is executed.
      const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
      const line = decodeURIComponent(raw.replace(/\+/g, " ").replace(/&/g, " "));
      const vctx = { cwd: "/", note: () => {} };
      const out = runCommandLine(line, vctx);
      return {
        status: 200,
        headers: { "Content-type": "text/html" },
        body: new TextEncoder().encode(out),
        auth: credsFrom(ctx, url),
        note: `rtpd.cgi command injection (CVE-2013-1599): ${line.slice(0, 200)}`,
      };
    }

    case "/frame/GetConfig":
    case "/frame/GetConfig.cgi": {
      // Unauth config disclosure (DCS-930L/932L family, Paleari 2013): the real
      // device serves an obfuscated config blob containing the admin password.
      // Ours is XOR-0x85 "obfuscated" and seeded with honeycreds — anything the
      // attacker reuses shows up (and correlates) in later login attempts.
      return {
        status: 200,
        headers: { "Content-type": "application/octet-stream", "Cache-Control": "no-cache" },
        body: obfuscatedConfig(),
        note: "config leak probe (GetConfig)",
      };
    }

    case "/docmd.htm": {
      // Undocumented command-exec page used post-auth-bypass on the same
      // family: real device requires the admin session, so challenge first —
      // the creds the attacker reuses are the interesting part.
      const auth = credsFrom(ctx, url);
      if (!auth) return unauthorized(persona);
      const cmd = url.searchParams.get("cmd") ?? decodeURIComponent(url.search.slice(1));
      const vctx = { cwd: "/", note: () => {} };
      const out = runCommandLine(cmd, vctx);
      return {
        status: 200,
        headers: { "Content-type": "text/html" },
        body: new TextEncoder().encode(out),
        auth,
        note: `docmd.htm command exec: ${cmd.slice(0, 200)}`,
      };
    }

    case "/upnp/asf-mp4.asf": {
      // CVE-2013-1600: unauthenticated live stream via the UPnP ASF endpoint.
      return {
        status: 200,
        headers: { "Content-type": "video/x-ms-asf", "Cache-Control": "no-cache" },
        body: asfStream(),
        note: "unauth asf stream probe",
      };
    }

    case "/md/lums.cgi": {
      // CVE-2013-1601: unauthenticated ASCII luminance stream.
      return {
        status: 200,
        headers: { "Content-type": "text/plain", "Cache-Control": "no-cache" },
        body: new TextEncoder().encode(lums()),
        note: "unauth ascii stream probe",
      };
    }


    case "/":
    case "/index.html":
      return html(persona, page("DCS-2130 Login", `
<h3>Web Configuration Utility</h3>
<form method="POST" action="/login.cgi">
<table class="f">
<tr><td>Username:</td><td><input type="text" name="username" size="16" /></td></tr>
<tr><td>Password:</td><td><input type="password" name="password" size="16" /></td></tr>
<tr><td colspan="2" align="right"><input type="submit" value="Login" /></td></tr>
</table>
</form>`));

    case "/live.html":
      return html(persona, page("DCS-2130 Live Video", `
<h3>Live Video</h3>
<img src="/video/mjpg.cgi" width="640" height="360" alt="Live Video" />
<p>
<a href="/image/jpeg.cgi?profileid=1">Take a Snapshot</a> |
<a href="/setup/video.html">Video Setup</a> |
<a href="/setup/motion.html">Motion Detection</a>
</p>
<p>ActiveX controls required for audio. <a href="/dms?nowprofileid=2">Stream profile 2</a></p>`));

    case "/setup/system.html":
      return html(persona, page("DCS-2130 System Setup", `
<h3>System Setup</h3>
<table class="f">
<tr><td>Device Name</td><td>DCS-2130</td></tr>
<tr><td>Firmware Version</td><td>1.23.00</td></tr>
<tr><td>MAC Address</td><td>00:1c:f0:aa:bb:cc</td></tr>
<tr><td>Current Date/Time</td><td><script>document.write(new Date())</script></td></tr>
</table>
<p><a href="/setup/network.html">Network Setup</a></p>`));

    case "/setup/network.html":
      return html(persona, page("DCS-2130 Network Setup", `
<h3>Network Setup</h3>
<table class="f">
<tr><td>IP Address</td><td>192.168.0.20</td></tr>
<tr><td>Subnet Mask</td><td>255.255.255.0</td></tr>
<tr><td>Default Gateway</td><td>192.168.0.1</td></tr>
<tr><td>HTTP Port</td><td>80</td></tr>
<tr><td>RTSP Port</td><td>554</td></tr>
<tr><td>DDNS</td><td>Enabled (mycamera.dlinkddns.com)</td></tr>
</table>`));

    case "/logout.html":
      return html(persona, page("DCS-2130 Logout", "<p>You have been logged out. <a href=\"/\">Login again</a></p>"));

    case "/image/jpeg.cgi":
    case "/image/jpeg.cgi/":
    case "/dms.jpg":
    case "/snapshot.jpg": {
      const auth = credsFrom(ctx, url);
      if (!auth) return unauthorized(persona);
      return { ...jpeg(persona, currentFrame(1280, 720)), auth, note: "snapshot" };
    }

    case "/video/mjpg.cgi":
    case "/video.cgi":
    case "/dms":
    case "/ipcam/stream.cgi": {
      const auth = credsFrom(ctx, url);
      if (!auth) return unauthorized(persona);
      return { ...mjpegStream(persona, () => currentFrame(640, 360), { fps: 3 }), auth, note: "mjpeg stream" };
    }

    default:
      return notFound(persona, url);
  }
}

function handlePost(ctx: PersonaCtx, url: URL): HttpResult {
  switch (url.pathname) {
    case "/login.cgi": {
      const auth = credsFrom(ctx, url) ?? { kind: "form" as const };
      return {
        ...redirect(persona, "/live.html", `sid=${crypto.randomUUID().replace(/-/g, "")}; path=/`),
        auth,
        note: "web login",
      };
    }
    case "/setup/apply.cgi":
    case "/config.cgi":
      return { ...html(persona, "<p>Settings applied.</p>"), note: "config change attempt" };
    default:
      return notFound(persona, url);
  }
}

const CONFIG_TEXT = `#DCS-2130 config v1.23.00
AdminUserID=admin
AdminPasswd=admin1234
CameraName=DCS-2130
HttpPort=80
RtspPort=554
WirelessSSID=home-net
WirelessKey=abcde-12345
NtpServer=time.nist.gov
DdnsHost=mycamera.dlinkddns.com
`;

/** Trivial byte obfuscation, same spirit as the real GetConfig blob. */
function obfuscatedConfig(): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(CONFIG_TEXT);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i]! ^ 0x85;
  return out;
}

/** Minimal ASF header (header + file-properties objects, infinite data size) followed by JPEG payload. */
function asfStream(): Uint8Array<ArrayBuffer> {
  const asfHeader = new Uint8Array([
    // ASF header object
    0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
    0x6e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02,
    // ASF file properties object
    0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65,
    0x68, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...(Array.from({ length: 40 }, () => 0) as number[]),
    // ASF data object (unknown size = endless stream)
    0x36, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02,
  ]);
  const frame = currentFrame(640, 360);
  const out = new Uint8Array(asfHeader.length + frame.length);
  out.set(asfHeader, 0);
  out.set(frame, asfHeader.length);
  return out;
}

/** Fake ASCII luminance frame (48 rows x 64 cols, dark "night lobby" with a bright patch). */
function lums(): string {
  const rows: string[] = [];
  for (let y = 0; y < 48; y++) {
    const vals: string[] = [];
    for (let x = 0; x < 64; x++) {
      const base = 18 + Math.floor(Math.random() * 36);
      const hot = x > 22 && x < 30 && y > 18 && y < 27 ? 70 + Math.floor(Math.random() * 30) : 0;
      vals.push(String(base + hot));
    }
    rows.push(vals.join(" "));
  }
  return rows.join("\n") + "\n";
}

export const persona: Persona = {
  name: "dlink",
  serverHeader: SERVER,
  realm: REALM,
  handle(ctx) {
    if (ctx.method === "POST") return handlePost(ctx, ctx.url);
    return handleGet(ctx, ctx.url);
  },
};
