import { config } from "./config";
import { logEvent } from "./log";
import type { Socket } from "bun";
import { banner, execCommand } from "./vsh";
import type { VshCtx } from "./vsh";

interface TelnetSession {
  buf: string;
  stage: "login" | "password" | "shell";
  user: string;
  cwd: string;
  commands: number;
  last: number;
}

const MAX_COMMANDS = 40;
const IDLE_CLOSE_MS = 300_000;
const sockets = new Set<Socket<TelnetSession>>();

function send(socket: Socket<TelnetSession>, text: string): void {
  socket.write(text.replace(/\n/g, "\r\n"));
}

function handleLine(socket: Socket<TelnetSession>, rawLine: string): void {
  const s = socket.data;
  const line = rawLine.replace(/[^\x20-\x7e]/g, "").trim();
  const src = { address: socket.remoteAddress ?? "unknown", port: socket.remotePort ?? 0 };

  if (s.stage === "login") {
    s.user = line;
    s.stage = "password";
    send(socket, "Password: ");
    return;
  }
  if (s.stage === "password") {
    logEvent({
      camera: "telnet",
      proto: "telnet",
      src_ip: src.address,
      src_port: src.port,
      auth: { user: s.user, password: line, kind: "telnet" },
      note: "telnet login",
    });
    s.stage = "shell";
    s.cwd = "/";
    send(socket, banner() + "# ");
    return;
  }

  if (!line) {
    send(socket, "# ");
    return;
  }
  s.commands++;
  let close = false;
  let out = "";
  const notes: string[] = [];
  const ctx: VshCtx = { cwd: s.cwd, note: (t) => notes.push(t) };
  try {
    const r = execCommand(line, ctx);
    out = r.out;
    close = r.close === true;
  } catch {
    out = `sh: syntax error`;
  }
  s.cwd = ctx.cwd;
  for (const n of notes) {
    logEvent({
      camera: "telnet",
      proto: "telnet",
      src_ip: src.address,
      src_port: src.port,
      auth: { user: s.user, kind: "telnet" },
      note: n,
    });
  }
  logEvent({
    camera: "telnet",
    proto: "telnet",
    src_ip: src.address,
    src_port: src.port,
    auth: { user: s.user, kind: "telnet" },
    note: `command: ${line}`,
  });
  if (close || s.commands >= MAX_COMMANDS) {
    if (!close) send(socket, "\n");
    socket.end();
    return;
  }
  send(socket, (out ? `\n${out}\n` : "\n") + "# ");
}

export function startTelnet(): void {
  Bun.listen<TelnetSession>({
    hostname: config.bind,
    port: config.telnetPort,
    socket: {
      open(socket) {
        socket.data = { buf: "", stage: "login", user: "", cwd: "/", commands: 0, last: Date.now() };
        sockets.add(socket);
        logEvent({
          camera: "telnet",
          proto: "telnet",
          src_ip: socket.remoteAddress ?? "unknown",
          src_port: socket.remotePort ?? 0,
          note: "telnet connection opened",
        });
        // nmap's generic telnet fingerprint is `IAC WILL ECHO` + `login: `
        // (nmap-service-probes: "p/telnet/ i/generic/") — match it byte-exact
        // on connect, then run the camera-style credential grabber.
        // IAC bytes must be written raw (string writes go out as UTF-8!)
        socket.write(new Uint8Array([0xff, 0xfb, 0x01]));
        socket.write("login: ");
      },
      data(socket, chunk) {
        const s = socket.data;
        s.last = Date.now();
        s.buf += chunk.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        for (;;) {
          const idx = s.buf.indexOf("\n");
          if (idx < 0) {
            if (s.buf.length > 512) socket.end();
            break;
          }
          const line = s.buf.slice(0, idx);
          s.buf = s.buf.slice(idx + 1);
          handleLine(socket, line);
        }
      },
      close(socket) {
        sockets.delete(socket);
      },
      error(socket, err) {
        console.warn(`telnet socket error: ${err.message}`);
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
  console.log(`telnet honeypot listening on ${config.bind}:${config.telnetPort}`);
}
