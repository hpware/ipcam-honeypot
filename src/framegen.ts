// Live frame generator: gray sensor noise + timestamp OSD, encoded to baseline
// JPEG by a small pure-TS encoder (no native deps). One frame per second per
// size is rendered and shared by every stream — like a real camera, there is
// only one sensor feed. Attacker data never reaches this code.

// --- 5x7 bitmap font (only the glyphs a timestamp needs) ---
const FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  "-": [0, 0, 0, 0b01110, 0, 0, 0],
  ":": [0, 0b00100, 0b00100, 0, 0b00100, 0b00100, 0],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

function setPx(px: Uint8Array, w: number, h: number, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 3;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
}

function drawText(
  px: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  text: string,
  scale: number,
  rgb: [number, number, number],
): void {
  // dark outline pass, then the OSD color on top
  const passes: Array<{ dx: number; dy: number; col: [number, number, number] }> = [
    { dx: -1, dy: -1, col: [10, 10, 10] },
    { dx: 1, dy: -1, col: [10, 10, 10] },
    { dx: -1, dy: 1, col: [10, 10, 10] },
    { dx: 1, dy: 1, col: [10, 10, 10] },
    { dx: 0, dy: 0, col: rgb },
  ];
  for (const pass of passes) {
    let x = x0;
    for (const ch of text) {
      const glyph = FONT[ch] ?? FONT[" "]!;
      for (let gy = 0; gy < 7; gy++) {
        const row = glyph[gy]!;
        for (let gx = 0; gx < 5; gx++) {
          if (!(row & (1 << (4 - gx)))) continue;
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              setPx(px, w, h, x + gx * scale + sx + pass.dx, y0 + gy * scale + sy + pass.dy, pass.col[0], pass.col[1], pass.col[2]);
        }
      }
      x += 6 * scale;
    }
  }
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderPixels(w: number, h: number): { px: Uint8Array; ts: string } {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = 152 + ((Math.random() * 18) | 0) - 9;
    const i3 = i * 3;
    px[i3] = v;
    px[i3 + 1] = v;
    px[i3 + 2] = v;
  }
  const ts = timestamp();
  drawText(px, w, h, 6, 6, ts, 2, [222, 232, 74]);
  return { px, ts };
}

// --- baseline JPEG encoder (YCbCr, 1x1 sampling, Annex K tables, quality ~75) ---

const ZZ = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

const Q_LUM = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const Q_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99,
];

const DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];

const AC_LUM_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
  0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
  0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
  0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
  0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
  0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
  0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

interface HuffTable {
  code: Uint16Array;
  len: Uint8Array;
}

function buildHuff(bits: number[], vals: number[]): HuffTable {
  const code = new Uint16Array(256);
  const len = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]!; i++) {
      const sym = vals[k++]!;
      code[sym] = c;
      len[sym] = l;
      c++;
    }
    c <<= 1;
  }
  return { code, len };
}

const HUFF = {
  dcLum: buildHuff(DC_LUM_BITS, Array.from({ length: 12 }, (_, i) => i)),
  dcChroma: buildHuff(DC_CHROMA_BITS, Array.from({ length: 12 }, (_, i) => i)),
  acLum: buildHuff(AC_LUM_BITS, AC_LUM_VALS),
  acChroma: buildHuff(AC_CHROMA_BITS, AC_CHROMA_VALS),
};

const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const CU = new Float64Array(8);
for (let u = 0; u < 8; u++) CU[u] = (u === 0 ? Math.SQRT1_2 : 1) / 2;

const dctTmp = new Float64Array(64);

/** Forward DCT on an 8x8 block (row-major, already level-shifted). */
function dct(blk: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += blk[y * 8 + x]! * COS[u * 8 + x]!;
      dctTmp[y * 8 + u] = sum * CU[u]!;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += dctTmp[y * 8 + u]! * COS[v * 8 + y]!;
      blk[v * 8 + u] = sum * CU[v]!;
    }
  }
}

class BitWriter {
  private out = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private n = 0;

  private push(b: number): void {
    if (this.len === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.len++] = b;
    if (b === 0xff) this.push(0);
  }

  write(value: number, bits: number): void {
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.push((this.acc >>> this.n) & 0xff);
    }
  }

  finish(): Uint8Array<ArrayBuffer> {
    if (this.n > 0) this.write((1 << (8 - this.n)) - 1, 8 - this.n);
    return this.out.slice(0, this.len);
  }
}

function cat(v: number): number {
  let n = 0;
  while (v) {
    n++;
    v >>= 1;
  }
  return n;
}

interface CompCtx {
  q: Uint8Array;
  dc: HuffTable;
  ac: HuffTable;
  pred: number;
}

function encodeBlock(bw: BitWriter, blk: Float64Array, comp: CompCtx): void {
  dct(blk);
  const coefs = new Int16Array(64);
  for (let i = 0; i < 64; i++) coefs[i] = Math.round(blk[ZZ[i]!]! / comp.q[ZZ[i]!]!);

  const diff = coefs[0]! - comp.pred;
  comp.pred = coefs[0]!;
  const c = cat(Math.abs(diff));
  bw.write(comp.dc.code[c]!, comp.dc.len[c]!);
  if (c > 0) bw.write(diff < 0 ? diff + (1 << c) - 1 : diff, c);

  let run = 0;
  for (let i = 1; i < 64; i++) {
    const v = coefs[i]!;
    if (v === 0) {
      run++;
      continue;
    }
    while (run >= 16) {
      bw.write(comp.ac.code[0xf0]!, comp.ac.len[0xf0]!);
      run -= 16;
    }
    const size = cat(Math.abs(v));
    const sym = (run << 4) | size;
    bw.write(comp.ac.code[sym]!, comp.ac.len[sym]!);
    bw.write(v < 0 ? v + (1 << size) - 1 : v, size);
    run = 0;
  }
  if (run > 0) bw.write(comp.ac.code[0]!, comp.ac.len[0]!);
}

function seg(marker: number, payload: number[]): number[] {
  return [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
}

const lumCtx: CompCtx = { q: Uint8Array.from(Q_LUM), dc: HUFF.dcLum, ac: HUFF.acLum, pred: 0 };
const cbCtx: CompCtx = { q: Uint8Array.from(Q_CHROMA), dc: HUFF.dcChroma, ac: HUFF.acChroma, pred: 0 };
const crCtx: CompCtx = { q: Uint8Array.from(Q_CHROMA), dc: HUFF.dcChroma, ac: HUFF.acChroma, pred: 0 };
const blkY = new Float64Array(64);
const blkCb = new Float64Array(64);
const blkCr = new Float64Array(64);

function encodeJpeg(w: number, h: number, px: Uint8Array): Uint8Array<ArrayBuffer> {
  lumCtx.pred = 0;
  cbCtx.pred = 0;
  crCtx.pred = 0;

  const bw = new BitWriter();
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const yy = Math.min(by + y, h - 1);
        for (let x = 0; x < 8; x++) {
          const xx = Math.min(bx + x, w - 1);
          const i = (yy * w + xx) * 3;
          const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
          const o = y * 8 + x;
          blkY[o] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          blkCb[o] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          blkCr[o] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      encodeBlock(bw, blkY, lumCtx);
      encodeBlock(bw, blkCb, cbCtx);
      encodeBlock(bw, blkCr, crCtx);
    }
  }
  const entropy = bw.finish();

  const jfif = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dqt = (id: number, q: Uint8Array) =>
    seg(0xdb, [id, ...Array.from({ length: 64 }, (_, i) => q[ZZ[i]!]!)]);
  const sof = seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = (tclass: number, id: number, bits: number[], vals: number[]) =>
    seg(0xc4, [(tclass << 4) | id, ...bits, ...vals]);
  const sos = seg(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

  return Uint8Array.from([
    0xff, 0xd8,
    ...jfif,
    ...dqt(0, lumCtx.q),
    ...dqt(1, cbCtx.q),
    ...sof,
    ...dht(0, 0, DC_LUM_BITS, Array.from({ length: 12 }, (_, i) => i)),
    ...dht(0, 1, DC_CHROMA_BITS, Array.from({ length: 12 }, (_, i) => i)),
    ...dht(1, 0, AC_LUM_BITS, AC_LUM_VALS),
    ...dht(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS),
    ...sos,
    ...entropy,
    0xff, 0xd9,
  ]);
}

// --- cached current frame per size (max one encode per second per size) ---

const cache = new Map<string, { sec: number; jpg: Uint8Array<ArrayBuffer> }>();

export function currentFrame(w: number, h: number): Uint8Array<ArrayBuffer> {
  const sec = Math.floor(Date.now() / 1000);
  const key = `${w}x${h}`;
  const hit = cache.get(key);
  if (hit && hit.sec === sec) return hit.jpg;
  const { px } = renderPixels(w, h);
  const jpg = encodeJpeg(w, h, px);
  cache.set(key, { sec, jpg });
  return jpg;
}
