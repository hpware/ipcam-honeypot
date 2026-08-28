import {
  type HttpResult,
  type Persona,
  type PersonaCtx,
  credsFrom,
  jpeg,
  mjpegStream,
  notFound,
  unauthorized,
} from "./common";
import { currentFrame } from "../framegen";
import { SERVER } from "./dlink";

// Pelco IDE10DN endpoints served by the same OEM firmware (same Boa HTTPd /
// rtspd as the DCS-2130 — that is why nmap reports
// "D-Link DCS-2130 or Pelco IDE10DN webcam rtspd" for both).
const REALM = "IDE10DN";

function handleGet(ctx: PersonaCtx, url: URL): HttpResult {
  switch (url.pathname) {
    case "/jpeg":
    case "/jpeg/qvga.jpg": {
      const auth = credsFrom(ctx, url);
      if (!auth) return unauthorized(persona);
      return {
        ...jpeg(persona, url.pathname.endsWith("qvga.jpg") ? currentFrame(320, 240) : currentFrame(1280, 720)),
        auth,
        note: "sarix jpeg",
      };
    }

    case "/jpeg/pull": {
      const auth = credsFrom(ctx, url);
      if (!auth) return unauthorized(persona);
      return {
        ...mjpegStream(persona, () => currentFrame(640, 360), { boundary: "jpegpull", fps: 3 }),
        auth,
        note: "sarix mjpeg pull",
      };
    }

    default:
      return notFound(persona, url);
  }
}

function handlePost(ctx: PersonaCtx, url: URL): HttpResult {
  switch (url.pathname) {
    case "/login":
    case "/api/login":
      return {
        status: 302,
        headers: { "Location": "/" },
        auth: credsFrom(ctx, url) ?? { kind: "form" as const },
        note: "sarix web login",
      };
    default:
      return notFound(persona, url);
  }
}

export const persona: Persona = {
  name: "pelco",
  serverHeader: SERVER,
  realm: REALM,
  handle(ctx) {
    if (ctx.method === "POST") return handlePost(ctx, ctx.url);
    return handleGet(ctx, ctx.url);
  },
};
