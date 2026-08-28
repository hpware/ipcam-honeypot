import { config } from "./config";
import { logEvent } from "./log";
import type { Socket } from "bun";
import type { HoneypotEvent } from "./log";

interface RtspSession {
  buf: string;
  session: string;
  active: boolean;
  last: number;
}

interface RtspRequest {
  method: string;
  path: string;
  version: string;
  cseq: string;
  headers: Record<string, string>;
}

// The real OEM rtspd banner shared by both models — this is what nmap's
// service probe matches on, producing "D-Link DCS-2130 or Pelco IDE10DN
// webcam rtspd" with cpe:/h:pelco:ide10dn.
export const RTSP_BANNER = "D-Link DCS-2130 or Pelco IDE10DN webcam rtspd";

const DLINK_PATHS = new Set(["/live1.sdp", "/video1.sdp", "/play1.sdp", "//live1.sdp"]);

const REQUEST_LINE = /^(OPTIONS|DESCRIBE|SETUP|TEARDOWN|PLAY|PAUSE|GET_PARAMETER|SET_PARAMETER) (\S+) RTSP\/1\.0$/i;
const IDLE_CLOSE_MS = 30_000;

function personaFor(path: string): "rtsp-dlink" | "rtsp-pelco" {
  return DLINK_PATHS.has(path) ? "rtsp-dlink" : "rtsp-pelco";
}

function parseRequest(raw: string): RtspRequest | null {
  const lines = raw.split("\r\n").filter(Boolean);
  const requestLine = lines[0];
  if (!requestLine || !REQUEST_LINE.test(requestLine)) return null;
  const parts = requestLine.split(" ");
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return {
    method: parts[0]!,
    path: parts[1]!,
    version: parts[2]!,
    cseq: headers["cseq"] ?? "0",
    headers,
  };
}

function sdp(): string {
  return [
    "v=0",
    `o=- ${Date.now()} ${Date.now()} IN IP4 0.0.0.0`,
    "s=DCS-2130 Live",
    "i=Live Video",
    "c=IN IP4 0.0.0.0",
    "t=0 0",
    "m=video 0 RTP/AVP 96",
    "a=rtpmap:96 H264/90000",
    "a=fmtp:96 packetization-mode=1;profile-level-id=640028;sprop-parameter-sets=Z2QAKKwaEgHjBlA=,aO4xsgs=",
    "a=control:trackID=1",
    "",
    "m=audio 0 RTP/AVP 0",
    "a=rtpmap:0 PCMU/8000",
    "a=control:trackID=2",
  ].join("\r\n");
}

// Exact response the real OEM rtspd gives to requests without a CSeq header
// (nmap's RTSPRequest probe = "OPTIONS / RTSP/1.0\r\n\r\n"). This byte-exact
// reply is what makes nmap report:
//   D-Link DCS-2130 or Pelco IDE10DN webcam rtspd
//   cpe:/h:dlink:dcs-2130/ cpe:/h:pelco:ide10dn/
function badRequest(): string {
  return `RTSP/1.0 400 Bad Request\r\nDate: ${new Date().toUTCString()}\r\nAllow: OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, GET_PARAMETER, SET_PARAMETER\r\n\r\n`;
}

function response(req: RtspRequest, status: string, extra: Record<string, string> = {}, body = ""): string {
  const headers: Record<string, string> = {
    CSeq: req.cseq,
    Date: new Date().toUTCString(),
    ...extra,
  };
  if (body) headers["Content-Length"] = String(body.length);
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return `RTSP/1.0 ${status}\r\n${head}\r\n\r\n${body}`;
}

/** Derive the base URL from the request URI (falls back to the local socket). */
function rtspUrl(req: RtspRequest, pathSuffix: string, src: { address: string; port: number }): string {
  const m = /^rtsp:\/\/([^/]+)(\/.*)?$/.exec(req.path);
  const host = m?.[1] ?? `${src.address}:${config.rtspPort}`;
  const path = m?.[2] ?? req.path;
  return `rtsp://${host}${path}${pathSuffix}`;
}

/** Capture Basic auth from the RTSP Authorization header — long values here are
 * CVE-2017-8410 stack-overflow probes, so keep the raw header in `headers` too. */
function rtspAuth(headers: Record<string, string>): HoneypotEvent["auth"] | undefined {
  const a = headers["authorization"];
  if (!a?.startsWith("Basic ")) return undefined;
  try {
    const [user = "", ...rest] = atob(a.slice(6)).split(":");
    return { user, password: rest.join(":"), kind: "basic" };
  } catch {
    return { kind: "basic" };
  }
}

function handleRequest(socket: Socket<RtspSession>, raw: string, src: { address: string; port: number }): boolean {
  const req = parseRequest(raw);
  if (!req) {
    logEvent({
      camera: "rtsp",
      proto: "rtsp",
      src_ip: src.address,
      src_port: src.port,
      note: `non-RTSP traffic: ${raw.slice(0, 120).replace(/[^\x20-\x7e]/g, ".")}`,
    });
    socket.end();
    return true;
  }
  const s = socket.data;
  const camera = personaFor(req.path);

  logEvent({
    camera,
    proto: "rtsp",
    src_ip: src.address,
    src_port: src.port,
    method: req.method,
    path: req.path,
    headers: req.headers,
    auth: rtspAuth(req.headers),
    note: `cseq=${req.cseq}${req.headers["authorization"] ? " (auth probe)" : ""}`,
  });

  if (!req.headers["cseq"]) {
    // real device: missing CSeq -> bare 400, then close (nmap fingerprint)
    logEvent({
      camera: "rtsp",
      proto: "rtsp",
      src_ip: src.address,
      src_port: src.port,
      method: req.method,
      path: req.path,
      headers: req.headers,
      note: "missing cseq -> 400 (probe)",
    });
    socket.write(badRequest());
    socket.end();
    return true;
  }

  let out: string;
  let close = true;
  switch (req.method.toUpperCase()) {
    case "OPTIONS":
      out = response(req, "200 OK", {
        Public: "OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, GET_PARAMETER, SET_PARAMETER",
      });
      break;
    case "DESCRIBE":
      out = response(
        req,
        "200 OK",
        {
          "Content-Type": "application/sdp",
          "Content-Base": rtspUrl(req, "/", src),
        },
        sdp(),
      );
      break;
    case "SETUP": {
      s.session = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      s.active = true;
      close = false;
      const clientTransport = req.headers["transport"] ?? "RTP/AVP/TCP;unicast;interleaved=0-1";
      const serverTransport = clientTransport.includes("TCP")
        ? "RTP/AVP/TCP;unicast;interleaved=0-1"
        : "RTP/AVP;unicast;client_port=50000-50001;server_port=6970-6971";
      out = response(req, "200 OK", { Transport: serverTransport, Session: `${s.session};timeout=60` });
      break;
    }
    case "PLAY": {
      close = false;
      out = response(req, "200 OK", {
        Session: s.session ? `${s.session};timeout=60` : "0;timeout=60",
        "RTP-Info": `url=${rtspUrl(req, "/trackID=1", src)};seq=31785;rtptime=${Math.floor(Date.now() / 100) % 4294967296}`,
      });
      break;
    }
    case "PAUSE":
    case "GET_PARAMETER":
      close = false;
      out = response(req, "200 OK", s.session ? { Session: s.session } : {});
      break;
    case "TEARDOWN":
      out = response(req, "200 OK", s.session ? { Session: s.session } : {});
      break;
    default:
      out = response(req, "461 Unsupported transport");
  }
  socket.write(out);
  if (close) {
    socket.end();
    return true;
  }
  return false;
}

const sockets = new Set<Socket<RtspSession>>();

export function startRtsp(): void {
  Bun.listen<RtspSession>({
    hostname: config.bind,
    port: config.rtspPort,
    socket: {
      open(socket) {
        socket.data = { buf: "", session: "", active: false, last: Date.now() };
        sockets.add(socket);
      },
      data(socket, chunk) {
        const s = socket.data;
        s.last = Date.now();
        s.buf += chunk.toString("utf8");
        for (;;) {
          const idx = s.buf.indexOf("\r\n\r\n");
          if (idx < 0) {
            if (s.buf.length > 8192) socket.end();
            break;
          }
          const raw = s.buf.slice(0, idx + 4);
          s.buf = s.buf.slice(idx + 4);
          const closed = handleRequest(socket, raw, {
            address: socket.remoteAddress ?? "unknown",
            port: socket.remotePort ?? 0,
          });
          if (closed) break;
        }
      },
      close(socket) {
        sockets.delete(socket);
      },
      error(socket, err) {
        console.warn(`rtsp socket error: ${err.message}`);
        sockets.delete(socket);
        socket.end();
      },
    },
  });
  setInterval(() => {
    const now = Date.now();
    for (const socket of sockets) {
      if (now - socket.data.last > IDLE_CLOSE_MS) {
        sockets.delete(socket);
        socket.end();
      }
    }
  }, 15_000);
  console.log(`rtsp honeypot listening on ${config.bind}:${config.rtspPort} [${RTSP_BANNER}]`);
}
