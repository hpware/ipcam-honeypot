import { config } from "./config";
import { startLogShipper, stopLogShipper } from "./log";
import { startRtsp } from "./rtsp";
import { startTelnet } from "./telnet";
import { startHttp } from "./httpd";
import type { Persona } from "./personas/common";
import { persona as dlink } from "./personas/dlink";
import { persona as pelco } from "./personas/pelco";

async function main(): Promise<void> {
  startLogShipper();

  // the real DCS-2130 / IDE10DN run the same OEM firmware — `both` serves the
  // D-Link UI plus the Pelco alias endpoints on one Boa HTTPd
  const personas: Persona[] =
    config.personas === "dlink" ? [dlink] : config.personas === "pelco" ? [pelco] : [dlink, pelco];
  startHttp(personas, config.httpPort);
  startRtsp();
  startTelnet();

  console.log("honeypot up — logs: console + NDJSON + Loki push");

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received, flushing logs...`);
    await stopLogShipper();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
