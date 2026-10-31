// Small PNG tools with no dependencies: read a PNG of 8 bits per channel or less (palette, grey, RGB, RGBA), scale it
// up by a whole factor with nearest neighbour (sharp pixels, like the site draws them) and write it back. The build uses
// it for the big NFT pictures (/big/<id>.png, 1008 px) that people download from the site; card.js draws the burn
// cards with toRgba and encodeRgb.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

// channels per colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function readPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let p = 8;
  let ihdr = null;
  const idat = [];
  const extra = []; // PLTE, tRNS kept as they are
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE' || type === 'tRNS') extra.push([type, data]);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('PNG without IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colorType, , , interlace] = ihdr.subarray(8, 13);
  if (!CHANNELS[colorType] || interlace !== 0 || depth > 8 || width < 1 || height < 1 || width * height > 4e6) {
    throw new Error('unsupported PNG');
  }
  const bpp = Math.max(1, (CHANNELS[colorType] * depth) >> 3); // bytes per pixel for the filters
  const stride = Math.ceil((width * CHANNELS[colorType] * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 64 * 1024 * 1024 });
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is too short');
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error('bad PNG filter');
      out[x] = v & 0xff;
    }
  }
  return { width, height, depth, colorType, stride, rows, extra };
}

// the sample (palette index, grey or one channel byte) at x of a row, for depths below 8: palette and grey only
const sampleAt = (row, x, depth) => {
  const per = 8 / depth;
  return (row[Math.floor(x / per)] >> (8 - depth * ((x % per) + 1))) & ((1 << depth) - 1);
};

// nearest-neighbour scale by a whole factor, same colour type and depth
export function scalePng(img, factor) {
  const f = Math.floor(factor);
  if (!(f >= 1 && f <= 64)) throw new Error('scale factor 1 to 64');
  const { width, height, depth, colorType } = img;
  const W = width * f;
  const H = height * f;
  const ch = CHANNELS[colorType];
  const stride = Math.ceil((W * ch * depth) / 8);
  const line = Buffer.alloc(stride);
  // each scaled row once, then the same row f times: the first with filter None, the rest with Up (all zeros)
  const out = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < height; y++) {
    const src = img.rows.subarray(y * img.stride, (y + 1) * img.stride);
    line.fill(0);
    if (depth < 8) {
      const per = 8 / depth;
      for (let x = 0; x < W; x++) {
        const v = sampleAt(src, Math.floor(x / f), depth);
        line[Math.floor(x / per)] |= v << (8 - depth * ((x % per) + 1));
      }
    } else {
      for (let x = 0; x < width; x++) {
        const px = src.subarray(x * ch, (x + 1) * ch);
        for (let k = 0; k < f; k++) px.copy(line, (x * f + k) * ch);
      }
    }
    for (let k = 0; k < f; k++) {
      const at = (y * f + k) * (stride + 1);
      out[at] = k ? 2 : 0;
      if (!k) line.copy(out, at + 1);
    }
  }
  return writePng({ width: W, height: H, depth, colorType, extra: img.extra }, out);
}

// filtered rows (each starting with its filter byte) to a PNG file
export function writePng({ width, height, depth, colorType, extra = [] }, filtered, level = 9) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', zlib.deflateSync(filtered, { level })), chunk('IEND', Buffer.alloc(0))]);
}

export const upscalePng = (buf, factor) => scalePng(readPng(buf), factor);

// a decoded picture as RGBA bytes, width * height * 4
export function toRgba(img) {
  const { width, height, depth, colorType } = img;
  const ch = CHANNELS[colorType];
  const out = new Uint8Array(width * height * 4);
  const plte = img.extra.find(([t]) => t === 'PLTE')?.[1];
  const trns = img.extra.find(([t]) => t === 'tRNS')?.[1];
  const max = (1 << depth) - 1;
  const at = (row, x, k) => (depth < 8 ? sampleAt(row, x, depth) : row[x * ch + k]);
  for (let y = 0; y < height; y++) {
    const row = img.rows.subarray(y * img.stride, (y + 1) * img.stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const i = at(row, x, 0);
        out[o] = plte?.[i * 3] ?? 0; out[o + 1] = plte?.[i * 3 + 1] ?? 0; out[o + 2] = plte?.[i * 3 + 2] ?? 0;
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const v = Math.round((at(row, x, 0) * 255) / max);
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = colorType === 4 ? row[x * ch + 1] : 255;
      } else {
        out[o] = row[x * ch]; out[o + 1] = row[x * ch + 1]; out[o + 2] = row[x * ch + 2];
        out[o + 3] = colorType === 6 ? row[x * ch + 3] : 255;
      }
    }
  }
  return out;
}

// RGB bytes (width * height * 3) to a PNG: a palette PNG when there are 256 colours or fewer (flat pixel art), else RGB
export function encodeRgb(width, height, rgb) {
  const colors = new Map();
  for (let i = 0; i < rgb.length && colors.size <= 256; i += 3) {
    const k = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    if (!colors.has(k)) colors.set(k, colors.size);
  }
  if (colors.size <= 256) {
    const plte = Buffer.alloc(colors.size * 3);
    for (const [k, i] of colors) { plte[i * 3] = k >> 16; plte[i * 3 + 1] = (k >> 8) & 255; plte[i * 3 + 2] = k & 255; }
    const out = Buffer.alloc(height * (width + 1));
    for (let y = 0; y < height; y++) {
      const at = y * (width + 1);
      out[at] = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        out[at + 1 + x] = colors.get((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]);
      }
    }
    return writePng({ width, height, depth: 8, colorType: 3, extra: [['PLTE', plte]] }, out, 6);
  }
  const stride = width * 3;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    out[at] = 1; // Sub
    for (let x = 0; x < stride; x++) out[at + 1 + x] = (rgb[y * stride + x] - (x >= 3 ? rgb[y * stride + x - 3] : 0)) & 255;
  }
  return writePng({ width, height, depth: 8, colorType: 2 }, out, 6);
}
