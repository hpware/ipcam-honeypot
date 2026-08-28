import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// Pure-TS minimal PNG writer + synthetic "night lobby" camera still.
// Converts to JPEG via macOS `sips` (no runtime deps needed).

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// deterministic per-pixel noise
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) & 0xff) >>> 0;
}

function renderScene(w: number, h: number, seed: number): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  const horizon = 0.62;
  const doorX0 = 0.64 * w;
  const doorX1 = 0.78 * w;
  const doorY0 = 0.16 * h;
  const doorY1 = horizon * h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r: number, g: number, b: number;
      if (y < horizon * h) {
        // upper wall: cold gradient
        const t = y / (horizon * h);
        r = 16 + 26 * t;
        g = 20 + 30 * t;
        b = 30 + 44 * t;
      } else {
        // floor: darker, slight reflective sheen
        const t = (y - horizon * h) / (h - horizon * h);
        r = 22 - 12 * t;
        g = 23 - 13 * t;
        b = 26 - 14 * t;
      }
      // lit doorway
      if (x > doorX0 && x < doorX1 && y > doorY0 && y < doorY1) {
        const edge = Math.min(x - doorX0, doorX1 - x, y - doorY0, doorY1 - y) / (0.04 * w);
        const glow = Math.min(1, edge * 0.9);
        r = r * (1 - glow) + 232 * glow;
        g = g * (1 - glow) + 226 * glow;
        b = b * (1 - glow) + 200 * glow;
      } else {
        // spill light falloff around the door
        const dx = Math.max(Math.max(doorX0 - x, x - doorX1), 0);
        const dy = Math.max(Math.max(doorY0 - y, y - doorY1), 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const spill = Math.exp(-dist / (0.28 * w)) * 0.55;
        r += 90 * spill;
        g += 88 * spill;
        b += 80 * spill;
      }
      // vignette
      const cx = x / w - 0.5;
      const cy = y / h - 0.5;
      const vig = 1 - 0.9 * (cx * cx + cy * cy) * 2.2;
      r *= vig;
      g *= vig;
      b *= vig;
      // sensor noise + slight green-ish CCD tint
      const n = (hash(x, y, seed) - 128) / 255;
      r += n * 14;
      g += n * 16;
      b += n * 12;
      const i = (y * w + x) * 3;
      rgb[i] = Math.max(0, Math.min(255, r | 0));
      rgb[i + 1] = Math.max(0, Math.min(255, g | 0));
      rgb[i + 2] = Math.max(0, Math.min(255, b | 0));
    }
  }
  return rgb;
}

function main(): void {
  mkdirSync("assets", { recursive: true });
  const jobs: Array<[number, number, number, string, string]> = [
    [1280, 720, 1337, "/tmp/honeypot_snapshot.png", "assets/snapshot.jpg"],
    [320, 240, 1338, "/tmp/honeypot_qvga.png", "assets/qvga.jpg"],
  ];
  for (const [w, h, seed, tmp, out] of jobs) {
    const png = encodePng(w, h, renderScene(w, h, seed));
    writeFileSync(tmp, png);
    const conv = Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", tmp, "--out", out]);
    if (conv.exitCode !== 0) {
      console.error(new TextDecoder().decode(conv.stderr));
      process.exit(1);
    }
    console.log(`wrote ${out}`);
  }
}

main();
