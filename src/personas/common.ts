import type { HoneypotEvent } from "../log";

export interface PersonaCtx {
  method: string;
  url: URL;
  body: string;
  authorization?: string;
  contentType?: string;
  cookie?: string;
}

export interface MjpegStream {
  getFrame: () => Uint8Array<ArrayBuffer>;
  boundary: string;
  fps: number;
  maxMs: number;
}

/** Raw HTTP response — written byte-exact by the httpd. */
export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array<ArrayBuffer>;
  stream?: MjpegStream;
  auth?: HoneypotEvent["auth"];
  note?: string;
}

export interface Persona {
  name: string;
  serverHeader: string;
  realm: string;
  handle(ctx: PersonaCtx): HttpResult | Promise<HttpResult>;
}

/** Extract credentials from Basic auth header, query string or form/JSON body. */
export function credsFrom(ctx: PersonaCtx, url: URL): HoneypotEvent["auth"] | undefined {
  if (ctx.authorization?.startsWith("Basic ")) {
    try {
      const [user = "", ...rest] = atob(ctx.authorization.slice(6)).split(":");
      return { user, password: rest.join(":"), kind: "basic" };
    } catch {
      return { kind: "basic" };
    }
  }
  const user = url.searchParams.get("user") ?? url.searchParams.get("username") ?? undefined;
  const pass = url.searchParams.get("password") ?? url.searchParams.get("pwd") ?? undefined;
  if (user !== undefined || pass !== undefined) return { user, password: pass, kind: "query" };

  if (ctx.body) {
    if (ctx.contentType?.includes("application/json")) {
      try {
        const j = JSON.parse(ctx.body) as Record<string, unknown>;
        const u =
          typeof j["user"] === "string" ? j["user"] : typeof j["username"] === "string" ? j["username"] : undefined;
        const p = typeof j["password"] === "string" ? j["password"] : undefined;
        if (u !== undefined || p !== undefined) return { user: u, password: p, kind: "json" };
      } catch {
        /* not json */
      }
    }
    const params = new URLSearchParams(ctx.body);
    const u =
      params.get("username") ?? params.get("user") ?? params.get("user1") ?? params.get("WAPLOGIN") ?? undefined;
    const p =
      params.get("password") ?? params.get("passwd") ?? params.get("pwd") ?? params.get("WAPPASSWORD") ?? undefined;
    if (u !== undefined || p !== undefined) return { user: u, password: p, kind: "form" };
  }
  return undefined;
}

const UNAUTHORIZED_BODY = `<HTML>
<HEAD><TITLE>401 Unauthorized</TITLE></HEAD>
<BODY>
<H1>401 Unauthorized</H1>
<HR>
<ADDRESS>Boa/0.94.14rc21 Server</ADDRESS>
</BODY>
</HTML>
`;

export function unauthorized(persona: Persona): HttpResult {
  return {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${persona.realm}", charset="UTF-8"`,
      "Content-type": "text/html",
    },
    body: new TextEncoder().encode(UNAUTHORIZED_BODY),
  };
}

export function html(persona: Persona, body: string, status = 200, extra: Record<string, string> = {}): HttpResult {
  return {
    status,
    headers: { "Content-type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...extra },
    body: new TextEncoder().encode(body),
  };
}

export function jpeg(persona: Persona, bytes: Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}): HttpResult {
  return {
    status: 200,
    headers: { "Content-type": "image/jpeg", "Cache-Control": "no-cache, no-store", ...extra },
    body: bytes,
  };
}

const BOA_404 = (url: URL) =>
  `<HTML>
<HEAD><TITLE>404 Not Found</TITLE></HEAD>
<BODY>
<H1>404 Not Found</H1>
The requested URL ${url.pathname} was not found on this server.
<HR>
<ADDRESS>Boa/0.94.14rc21 Server</ADDRESS>
</BODY>
</HTML>
`;

export function notFound(persona: Persona, url: URL): HttpResult {
  return {
    status: 404,
    headers: { "Content-type": "text/html" },
    body: new TextEncoder().encode(BOA_404(url)),
  };
}

export function redirect(persona: Persona, location: string, cookie?: string): HttpResult {
  const headers: Record<string, string> = { "Location": location };
  if (cookie) headers["Set-Cookie"] = cookie;
  return { status: 302, headers };
}

export function mjpegStream(
  persona: Persona,
  getFrame: () => Uint8Array<ArrayBuffer>,
  opts: { fps?: number; maxMs?: number; boundary?: string } = {},
): HttpResult {
  return {
    status: 200,
    headers: {
      "Content-type": `multipart/x-mixed-replace;boundary=${opts.boundary ?? "ImageBoundary"}`,
      "Cache-Control": "no-cache, no-store",
    },
    stream: {
      getFrame,
      boundary: opts.boundary ?? "ImageBoundary",
      fps: opts.fps ?? 5,
      maxMs: opts.maxMs ?? 120_000,
    },
  };
}

// --- real firmware www (extracted from the official 1.20.00 image, see
// scripts/fetch-www.sh) served verbatim for maximum fidelity ---

const WWW_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  js: "application/x-javascript",
  css: "text/css",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain",
  ini: "text/plain",
  xml: "text/xml",
  cab: "application/octet-stream",
  exe: "application/octet-stream",
};

export async function wwwFile(pathname: string): Promise<HttpResult | null> {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p.endsWith("/")) p += "index.htm";
  if (p.includes("..") || p.includes("\0")) return null;
  const f = Bun.file("assets/www" + p);
  if (!(await f.exists())) return null;
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  return {
    status: 200,
    headers: { "Content-type": WWW_TYPES[ext] ?? "application/octet-stream" },
    body: new Uint8Array(await f.arrayBuffer()),
  };
}
