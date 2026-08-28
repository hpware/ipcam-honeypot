import { config } from "./config";
import { logEvent } from "./log";
import type { Socket } from "bun";
import { credsFrom, html, mjpegStream, notFound, redirect, unauthorized } from "./personas/common";
import type { HttpResult, Persona, PersonaCtx } from "./personas/common";

// Raw TCP HTTP server speaking like Boa HTTPd 0.94.14rc21 (the web server on
// the real DCS-2130 / IDE10DN firmware): HTTP/1.0-style replies, Date header
// before Server, Connection: close. Written byte-exact so nmap -sV reports
// "Boa HTTPd 0.94.14rc21" exactly like the real device.

interface HttpSession {
  buf: string;
  last: number;
  streamTimer?: ReturnType<typeof setInterval>;
}

const MAX_BODY = 1_000_000;
const MAX_HEAD = 16_000;
const IDLE_CLOSE_MS = 30_000;
const sockets = new Set<Socket<HttpSession>>();

const REASONS: Record<number, string> = {
  200: "OK",
  206: "Partial Content",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  501: "Not Implemented",
};

function boarespond(status: number): string {
  const reason = REASONS[status] ?? "Unknown";
  return `HTTP/1.1 ${status} ${reason}\r\nDate: ${new Date().toUTCString()}\r\nServer: Boa/0.94.14rc21\r\nConnection: close\r\n`;
}

const BOA_400_BODY = `<HTML>
<HEAD><TITLE>400 Bad Request</TITLE></HEAD>
<BODY>
<H1>400 Bad Request</H1>
Your request was not understood by this server.
<HR>
<ADDRESS>Boa/0.94.14rc21 Server</ADDRESS>
</BODY>
</HTML>
`;
const BOA_501_BODY = (m: string) =>
  `<HTML>
<HEAD><TITLE>501 Not Implemented</TITLE></HEAD>
<BODY>
<H1>501 Not Implemented</H1>
The method ${m} is not supported by this server.
<HR>
<ADDRESS>Boa/0.94.14rc21 Server</ADDRESS>
</BODY>
</HTML>
`;

interface ParsedRequest {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  headEnd: number;
  contentLength: number;
}

function tryParse(buf: string): ParsedRequest | null | "wait" {
  const idx = buf.indexOf("\r\n\r\n");
  if (idx < 0) return buf.length > MAX_HEAD ? null : "wait";
  const lines = buf.slice(0, idx).split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length !== 3 || !parts[2]!.startsWith("HTTP/")) return null;
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const cl = headers["content-length"] ? Number(headers["content-length"]) : 0;
  if (Number.isNaN(cl) || cl < 0 || cl > MAX_BODY) return null;
  return { method: parts[0]!.toUpperCase(), target: parts[1]!, version: parts[2]!, headers, headEnd: idx + 4, contentLength: cl };
}

function safeUrl(target: string): { url: URL; weird: boolean } {
  try {
    return { url: new URL(target, "http://honeypot.invalid"), weird: false };
  } catch {
    try {
      return { url: new URL(`/${target.replace(/^\/+/, "")}`, "http://honeypot.invalid"), weird: true };
    } catch {
      return { url: new URL("/", "http://honeypot.invalid"), weird: true };
    }
  }
}

async function dispatch(
  socket: Socket<HttpSession>,
  req: ParsedRequest,
  src: { address: string; port: number },
  personas: Persona[],
): Promise<void> {
  const { url, weird } = safeUrl(req.target);
  const body = req.contentLength > 0 ? socket.data.buf.slice(req.headEnd, req.headEnd + req.contentLength) : "";
  const ctx: PersonaCtx = {
    method: req.method,
    url,
    body,
    authorization: req.headers["authorization"],
    contentType: req.headers["content-type"],
  };

  let result: HttpResult | undefined;
  let matched: Persona | undefined;
  try {
    for (const persona of personas) {
      result = await persona.handle(ctx);
      if (result.status !== 404) {
        matched = persona;
        break;
      }
    }
  } catch (err) {
    console.error(`handler error: ${err instanceof Error ? err.message : err}`);
    result = { status: 500, headers: { "Content-type": "text/html" } };
  }
  result ??= { status: 500, headers: { "Content-type": "text/html" } };

  const reason = REASONS[result.status] ?? "Unknown";
  const head =
    `${req.version} ${result.status} ${reason}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Server: ${matched?.serverHeader ?? personas[0]!.serverHeader}\r\n` +
    Object.entries(result.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") +
    "\r\n";

  if (result.stream) {
    // MJPEG: no Content-Length, keep writing frames until abort/max time.
    // Frames are pulled fresh each tick (one shared "sensor" per size).
    const { getFrame, boundary, fps, maxMs } = result.stream;
    const buildPart = (): Uint8Array => {
      const frame = getFrame();
      const partHead = `--${boundary}\r\nContent-type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
      const part = new Uint8Array(partHead.length + frame.length + 2);
      part.set(new TextEncoder().encode(partHead), 0);
      part.set(frame, partHead.length);
      part.set([13, 10], partHead.length + frame.length);
      return part;
    };
    const started = Date.now();
    socket.data.last = Date.now();
    socket.write(`${head}Connection: close\r\n\r\n`);
    socket.write(buildPart());
    socket.data.streamTimer = setInterval(() => {
      if (Date.now() - started > maxMs) {
        clearInterval(socket.data.streamTimer);
        socket.data.streamTimer = undefined;
        socket.end();
        return;
      }
      socket.data.last = Date.now();
      try {
        socket.write(buildPart());
      } catch {
        clearInterval(socket.data.streamTimer);
        socket.data.streamTimer = undefined;
        socket.end();
      }
    }, 1000 / fps);
  } else if (req.method === "HEAD") {
    socket.write(`${head}Connection: close\r\nContent-Length: ${result.body?.length ?? 0}\r\n\r\n`);
  } else {
    const bodyBytes = result.body ?? new Uint8Array(0);
    socket.write(`${head}Connection: close\r\nContent-Length: ${bodyBytes.length}\r\n\r\n`);
    if (bodyBytes.length > 0) socket.write(bodyBytes);
    socket.end();
  }

  const rawTarget = req.target;
  const normalized = url.pathname + url.search;
  logEvent({
    camera: matched?.name ?? "http",
    proto: "http",
    src_ip: src.address,
    src_port: src.port,
    method: req.method,
    path: url.pathname,
    query: url.search.slice(1) || undefined,
    status: result.status,
    user_agent: req.headers["user-agent"],
    headers: req.headers,
    body: body ? body.slice(0, 4096) : undefined,
    auth: result.auth,
    note:
      [
        result.note,
        weird ? "malformed request target" : undefined,
        rawTarget !== normalized ? `raw target: ${rawTarget.slice(0, 200)}` : undefined,
      ]
        .filter(Boolean)
        .join("; ") || undefined,
  });
}

function respondError(socket: Socket<HttpSession>, status: number, method?: string): void {
  const htmlBody = status === 501 && method ? BOA_501_BODY(method) : BOA_400_BODY;
  const bytes = new TextEncoder().encode(htmlBody);
  socket.write(
    `${boarespond(status)}Content-type: text/html\r\nContent-Length: ${bytes.length}\r\n\r\n${htmlBody}`,
  );
  socket.end();
}

function handleData(socket: Socket<HttpSession>, chunk: Uint8Array, src: { address: string; port: number }, personas: Persona[]): void {
  const s = socket.data;
  s.last = Date.now();
  s.buf += new TextDecoder("latin1").decode(chunk);
  if (s.streamTimer) return; // mid-MJPEG stream, ignore pipelined junk

  const parsed = tryParse(s.buf);
  if (parsed === "wait") return;
  if (parsed === null) {
    logEvent({
      camera: "http",
      proto: "http",
      src_ip: src.address,
      src_port: src.port,
      note: `malformed request: ${s.buf.slice(0, 120).replace(/[^\x20-\x7e]/g, ".")}`,
    });
    respondError(socket, 400);
    return;
  }
  s.buf = s.buf.slice(parsed.headEnd + parsed.contentLength);

  if (parsed.method !== "GET" && parsed.method !== "POST" && parsed.method !== "HEAD") {
    logEvent({
      camera: "http",
      proto: "http",
      src_ip: src.address,
      src_port: src.port,
      method: parsed.method,
      path: parsed.target,
      status: 501,
      headers: parsed.headers,
      note: "unsupported method",
    });
    respondError(socket, 501, parsed.method);
    return;
  }
  void dispatch(socket, parsed, src, personas);
}

export function startHttp(personas: Persona[], port: number): void {
  Bun.listen<HttpSession>({
    hostname: config.bind,
    port,
    socket: {
      open(socket) {
        socket.data = { buf: "", last: Date.now() };
        sockets.add(socket);
      },
      data(socket, chunk) {
        handleData(
          socket,
          chunk,
          { address: socket.remoteAddress ?? "unknown", port: socket.remotePort ?? 0 },
          personas,
        );
      },
      close(socket) {
        sockets.delete(socket);
        if (socket.data.streamTimer) clearInterval(socket.data.streamTimer);
      },
      error(socket, err) {
        console.warn(`http socket error: ${err.message}`);
        sockets.delete(socket);
        if (socket.data.streamTimer) clearInterval(socket.data.streamTimer);
        socket.end();
      },
    },
  });
  setInterval(() => {
    const now = Date.now();
    for (const socket of sockets) {
      if (now - socket.data.last > IDLE_CLOSE_MS) {
        sockets.delete(socket);
        if (socket.data.streamTimer) clearInterval(socket.data.streamTimer);
        socket.end();
      }
    }
  }, 15_000);
  console.log(`http honeypot listening on ${config.bind}:${port} [Boa/0.94.14rc21]`);
}
