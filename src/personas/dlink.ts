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
  wwwFile,
} from "./common";
import { currentFrame } from "../framegen";
import { runCommandLine } from "../vsh";

// DCS-2130 / Pelco IDE10DN OEM web UI (Boa HTTPd 0.94.14rc21).
//
// The official 1.20.00 firmware image from D-Link is fully AES-encrypted
// (~7.96 entropy, no plaintext sections), so the UI here is mirrored from
// live reference devices running the same firmware family (identical Boa
// build, identical rtspd banner): the IE-sniffer index, the wap.htm login
// (POST /cgi-bin/wappwd -> camera.htm / denied.htm) and the ActiveX ie.htm
// are byte-accurate where the devices serve them publicly. camera.htm is
// behind the real device's auth, so it is modeled in the same bare style.
export const SERVER = "Boa/0.94.14rc21";
const REALM = "DCS-2130";

function wapSession(ctx: PersonaCtx): boolean {
  return /(?:^|;[ \t]*)WAPSID=[0-9a-f]{8}(?:;|$)/.test(ctx.cookie ?? "");
}

function handleGet(ctx: PersonaCtx, url: URL): HttpResult {
  switch (url.pathname) {
    // NOTE: "/" and "/index.html" are NOT listed here on purpose — the real
    // firmware's own index.htm (assets/www) is served via the wwwFile
    // fallback below, exactly as the 1.20.00 image ships it.

    case "/wap.htm":
      // Byte-accurate copy of the reference devices' login menu. The form
      // posts to /cgi-bin/wappwd with FILEOK=camera.htm / FILEFAIL=denied.htm.
      return html(persona, `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html">
<meta name="viewport" content="width=device-width; initial-scale=1.0"/>
<title>LOGIN MENU</title>
</head>
<body bgcolor="#ffffff" text="#000000" link="#ff3535">
<form name="form1" method="post" action="/cgi-bin/wappwd">
<table border="1" cellpadding="0" bgcolor="#C0C0C0">
	<tbody>
		<tr>
			<th align=left><FONT color=#000000 size=1>ID:</FONT></TH>
			<td align=left><input name="WAPLOGIN" size="8" maxlength="14" ></TD>
		</tr>
		<tr>
			<th align=left><FONT color=#000000 size=1>PSWD:</FONT></TH>
			<td align=left>
			<input type="password" name="WAPPASSWORD" size="8" maxlength="14"></TD>
		</tr>
		<tr>
			<th align=left><FONT color=#000000 size=1>PIC Size :</FONT></TH>
			<td align=left>
			<input type="radio" checked="checked" name="PIC_SIZE" value="RES_0">
			<FONT color=#000000 size=1>176X144<br></FONT>
			<input type="radio" name="PIC_SIZE" value="RES_1">
			<FONT color=#000000 size=1>228X187<br></FONT>
			<input type="radio" name="PIC_SIZE" value="RES_2">
			<FONT color=#000000 size=1>320X240<br></FONT>
			<input type="radio" name="PIC_SIZE" value="RES_3">
			<FONT color=#000000 size=1>640X480</FONT></td>
      </td>
    	</tr>
		<tr>
			<th align=left><FONT color=#000000 size=1> </FONT></TH>
			<td align=left>
			<input type=hidden name=FILEOK value=camera.htm>
			<input type=hidden name=FILEFAIL value=denied.htm>
			<input type="submit" name="Submit" value="OK"></td>
		</tr>
	</tbody>
</table>
</form>
<hr>
</body>
</html>`);

    case "/ie.htm":
      // Byte-accurate copy of the reference devices' IE gatekeeper page.
      return html(persona, `<html>

<head>
<meta name="GENERATOR" content="Microsoft FrontPage 6.0">
<meta name="ProgId" content="FrontPage.Editor.Document">
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<title>IE-Plugin</title>
</head>

<body bgcolor="#ffffff">

<p align="center">
<table>
	<tr>
		<td align="center">
			<object classid="clsid:62A7FE9E-A494-49f4-BE78-E4C340B75BF4" id="IE_OCX" width="1" height="1"
				CODEBASE="IEPlugin.cab#version=7,0,2,8">
				<param name="_Version" value="65536">
				<param name="_ExtentX" value="25929">
				<param name="_ExtentY" value="16404">
				<param name="_StockProps" value="0">
			</object>
		</td>
	</tr>
	<tr>
		<td align="center" id="downloadDescription">
            <font size="5">If you connect to the DVR at the first time, you need to install the IE-Plugin first.<br />
            Please download the manual <a href="" onclick="OnDownload();return false;">package</a>,
			run 'setup.exe' as administrator, and login to the DVR again.<br />
            For Google Maps function, you need IE version 11 above.</font>
		</td>
	</tr>
</table>
</p>

<script language="JavaScript">
	var SvrIP;
	SvrIP = document.location.hostname;
	IE_OCX.setText(0, 0, "Please click in this window before any operation in Login Dialog!");
IE_OCX.SetIPAddrEx(SvrIP, 2);

	function OCXSizeChange(width, height) {
		IE_OCX.width = width;
		IE_OCX.height = height;
	}
	function DownloadDescriptionHide() {
		document.getElementById("downloadDescription").style.visibility='hidden';
	}
	function OnDownload() {
		window.open('Setup.exe', '_blank');
		var url = location.href;
		url = url.substring(0, url.lastIndexOf("/"));
		location.href = url + "/IEPlugin.cab";
	}
	function BackgroundColorChange(color) {
		document.body.bgColor = color;
	}
</script>

</body>
</html>`);

    case "/camera.htm": {
      // Modeled post-login video page (the real one is behind auth). Same
      // bare wap-family styling; requires a wap session or Basic auth.
      if (!wapSession(ctx)) {
        const auth = credsFrom(ctx, url);
        if (!auth) return redirect(persona, "/wap.htm");
        return videoPage();
      }
      return videoPage();
    }

    case "/denied.htm":
      return html(persona, `<html>
<head>
<meta http-equiv="Content-Type" content="text/html">
<title>DENIED</title>
</head>
<body bgcolor="#ffffff" text="#000000">
<FONT color=#000000 size=2>Access denied.</FONT>
<hr>
</body>
</html>`);

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
      // Blob matches the real device defaults: admin with a BLANK password.
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

    case "/image/jpeg.cgi":
    case "/image/jpeg.cgi/":
    case "/dms.jpg":
    case "/snapshot.jpg": {
      const wap = wapSession(ctx);
      const auth = credsFrom(ctx, url);
      if (!wap && !auth) return unauthorized(persona);
      return {
        ...jpeg(persona, currentFrame(1280, 720)),
        auth,
        note: wap ? "snapshot (wap session)" : "snapshot",
      };
    }

    case "/video/mjpg.cgi":
    case "/video.cgi":
    case "/dms":
    case "/ipcam/stream.cgi": {
      const wap = wapSession(ctx);
      const auth = credsFrom(ctx, url);
      if (!wap && !auth) return unauthorized(persona);
      return {
        ...mjpegStream(persona, () => currentFrame(640, 360), { fps: 3 }),
        auth,
        note: wap ? "mjpeg stream (wap session)" : "mjpeg stream",
      };
    }

    default:
      return notFound(persona, url);
  }
}

function videoPage(): HttpResult {
  return html(persona, `<html>
<head>
<meta http-equiv="Content-Type" content="text/html">
<title>CAMERA</title>
</head>
<body bgcolor="#ffffff" text="#000000" link="#ff3535">
<table border="1" cellpadding="0" bgcolor="#C0C0C0">
<tr><td>
<img src="/video/mjpg.cgi" width="320" height="240" border="0">
</td></tr>
</table>
<br>
<FONT color=#000000 size=1>[<a href="/image/jpeg.cgi?profileid=1">Snapshot</a>]
[<a href="/wap.htm">Logout</a>]</FONT>
<hr>
</body>
</html>`);
}

function handlePost(ctx: PersonaCtx, url: URL): HttpResult {
  switch (url.pathname) {
    case "/cgi-bin/wappwd":
    case "/login.cgi": {
      // Real flow: FILEOK=camera.htm on success, FILEFAIL=denied.htm on
      // failure. Device ships with admin + BLANK password, so any non-empty
      // ID gets in; a fully empty submission is denied. All of it is logged.
      const auth = credsFrom(ctx, url) ?? { kind: "form" as const };
      const ok = !!auth.user;
      const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      return {
        ...redirect(persona, ok ? "/camera.htm" : "/denied.htm", `WAPSID=${sid}; path=/`),
        auth,
        note: ok ? "wap login" : "wap login denied (empty creds)",
      };
    }
    default:
      return notFound(persona, url);
  }
}

const CONFIG_TEXT = `#DCS-2130 config v1.20.00
AdminUserID=admin
AdminPasswd=
CameraName=DCS-2130
HttpPort=80
RtspPort=554
WirelessSSID=
WirelessKey=
NtpServer=time.nist.gov
DdnsHost=
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
  async handle(ctx) {
    if (ctx.method === "POST") return handlePost(ctx, ctx.url);
    const hit = handleGet(ctx, ctx.url);
    if (hit.status !== 404) return hit;
    // anything not explicitly modeled is answered from the real firmware's
    // web root (assets/www — extracted from the official 1.20.00 image)
    return (await wwwFile(ctx.url.pathname)) ?? hit;
  },
};
