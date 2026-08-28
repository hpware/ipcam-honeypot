import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

export interface HoneypotEvent {
  camera: string; // dlink | pelco | rtsp-dlink | rtsp-pelco | telnet
  proto: "http" | "rtsp" | "telnet";
  src_ip?: string;
  src_port?: number;
  method?: string;
  path?: string;
  query?: string;
  status?: number;
  user_agent?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: { user?: string; password?: string; kind: string };
  note?: string;
}

const pending: HoneypotEvent[] = [];
let flushing = false;
let timer: ReturnType<typeof setInterval> | undefined;

const FLUSH_EVERY_MS = 2000;
const FLUSH_AT = 200;

function tsNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function line(e: HoneypotEvent): string {
  const cred = e.auth ? ` auth=${JSON.stringify(e.auth)}` : "";
  const extra = e.note ? ` ${e.note}` : "";
  const req = e.method ? `"${e.method} ${e.path ?? ""}${e.query ? `?${e.query}` : ""}"` : "";
  return `[${new Date().toISOString()}] ${e.camera}/${e.proto} ${e.src_ip ?? "?"}${req} ${e.status ?? ""}${cred}${extra}`;
}

async function pushToLoki(events: HoneypotEvent[]): Promise<boolean> {
  const streams = new Map<string, { stream: Record<string, string>; values: [string, string][] }>();
  for (const e of events) {
    const labels = { job: config.lokiJob, camera: e.camera, proto: e.proto };
    const key = `${labels.job}|${labels.camera}|${labels.proto}`;
    let s = streams.get(key);
    if (!s) {
      s = { stream: labels, values: [] };
      streams.set(key, s);
    }
    s.values.push([tsNs(), JSON.stringify(e)]);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.lokiTenant) headers["X-Scope-OrgID"] = config.lokiTenant;
  try {
    const res = await fetch(`${config.lokiUrl}/loki/api/v1/push`, {
      method: "POST",
      headers,
      body: JSON.stringify({ streams: [...streams.values()] }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function flush(): Promise<void> {
  if (flushing || pending.length === 0) return;
  flushing = true;
  const batch = pending.splice(0, pending.length);
  const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
  try {
    appendFileSync(config.logFile, lines);
  } catch (err) {
    console.error("failed writing NDJSON:", err);
  }
  const ok = await pushToLoki(batch);
  if (!ok) console.warn(`warn: Loki push failed (${batch.length} events kept in local NDJSON only)`);
  flushing = false;
}

export function logEvent(e: HoneypotEvent): void {
  pending.push(e);
  console.log(line(e));
  if (config.verbose && (e.headers || e.body)) {
    if (e.headers) console.log(`  headers: ${JSON.stringify(e.headers)}`);
    if (e.body) console.log(`  body: ${e.body.slice(0, 1024)}`);
  }
  if (pending.length >= FLUSH_AT) void flush();
}

export function startLogShipper(): void {
  mkdirSync(dirname(config.logFile), { recursive: true });
  timer = setInterval(() => void flush(), FLUSH_EVERY_MS);
}

export async function stopLogShipper(): Promise<void> {
  if (timer) clearInterval(timer);
  await flush();
}
