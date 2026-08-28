const str = (key: string, fallback: string) => Bun.env[key] ?? fallback;
const num = (key: string, fallback: number) => Number(Bun.env[key] ?? fallback) || fallback;

export const config = {
  // both = one HTTP port serving the D-Link UI plus the Pelco IDE10DN alias
  // endpoints (they run the same OEM firmware, matching the real nmap fingerprint)
  personas: str("PERSONAS", "both"),
  bind: str("BIND_HOST", "0.0.0.0"),
  httpPort: num("HTTP_PORT", 8080),
  rtspPort: num("RTSP_PORT", 8554),
  telnetPort: num("TELNET_PORT", 2323),
  lokiUrl: str("LOKI_URL", "http://127.0.0.1:3100").replace(/\/$/, ""),
  lokiTenant: Bun.env["LOKI_TENANT_ID"],
  lokiJob: str("LOKI_JOB", "ipcam-honeypot"),
  logFile: str("LOG_FILE", "logs/honeypot.ndjson"),
  verbose: Bun.env["VERBOSE"] === "1",
};
