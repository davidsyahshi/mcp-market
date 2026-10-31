// NFT pictures of the market's own collection ship in the repo as two archives (5,000 files each would be
// thousands of commits): collection/mcp-images.tar.gz (/img/<id>.png) and collection/mcp-thumbs.tar.gz
// (/thumb/<id>.png). The build unpacks them (scripts/build.js); locally `npm start` does too.
// A small reader for plain ustar archives, so no system tar or extra package is needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { upscalePng } from './png.js';

export const ARCHIVES = [
  { file: 'mcp-images.tar.gz', dir: 'images' },
  { file: 'mcp-thumbs.tar.gz', dir: 'thumbs' },
];

// only "<number>.png" at the top level: nothing in an archive can write outside its folder
const SAFE_NAME = /^[1-9]\d{0,6}\.png$/;

export function readTarGz(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // end of archive
    const field = (a, b) => h.subarray(a, b).toString('utf8').split('\0')[0];
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (parseInt(field(148, 156).trim(), 8) !== sum) throw new Error(`${path.basename(file)}: damaged archive (bad header at byte ${off})`);
    const prefix = field(345, 500);
    const name = (prefix ? `${prefix}/` : '') + field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${path.basename(file)}: damaged archive (bad size at byte ${off})`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    off += 512;
    if (off + size > buf.length) throw new Error(`${path.basename(file)}: archive is cut short`);
    if (type === '0') {
      if (!SAFE_NAME.test(name)) throw new Error(`${path.basename(file)}: unexpected file "${name}"`);
      files.push({ name, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

// Unpacks the archives into collection/images and collection/thumbs (and, when given, into dist/img and
// dist/thumb). Returns how many files each folder got.
export function unpackCollection(root, { dist } = {}) {
  const counts = {};
  for (const { file, dir } of ARCHIVES) {
    const src = path.join(root, 'collection', file);
    if (!fs.existsSync(src)) throw new Error(`collection/${file} is missing`);
    const files = readTarGz(src);
    const targets = [path.join(root, 'collection', dir)];
    if (dist) targets.push(path.join(dist, dir === 'images' ? 'img' : 'thumb'));
    for (const t of targets) {
      fs.rmSync(t, { recursive: true, force: true });
      fs.mkdirSync(t, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(t, f.name), f.data);
    }
    counts[dir] = files.length;
  }
  return counts;
}

// for `npm start`: unpack once if the folders are not there yet
export function ensureUnpacked(root) {
  const have = ARCHIVES.every(({ dir }) => fs.existsSync(path.join(root, 'collection', dir, '1.png')));
  return have ? null : unpackCollection(root);
}

// The 28x28 pixel pictures at 1008 px (36x, sharp), for downloading and sharing: /big/<id>.png. Only for pixel NFTs
// (px in collection.json); the others' /img/<id>.png is already full size. Built into dist/big, served by the CDN.
export const BIG_PX = 1008;
export function bigImage(png) {
  const width = png.readUInt32BE(16);
  if (!(width > 0) || BIG_PX % width) throw new Error(`a ${width} px picture doesn't scale to ${BIG_PX} px`);
  return upscalePng(png, BIG_PX / width);
}
export function makeBigImages(root, outDir) {
  const { items } = JSON.parse(fs.readFileSync(path.join(root, 'collection', 'collection.json'), 'utf8'));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const it of items) {
    if (!it.px) continue;
    const name = `${Number(it.id)}.png`;
    fs.writeFileSync(path.join(outDir, name), bigImage(fs.readFileSync(path.join(root, 'collection', 'images', name))));
    n++;
  }
  return n;
}
