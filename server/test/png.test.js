// Big NFT pictures for downloading: png.js scales a PNG up with sharp pixels, the build makes /big/<id>.png (1008 px)
// for the market's own pixel NFTs, the API names that picture as "big" and the NFT's page offers it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.TEST_MODE = '1';
const { readPng, scalePng, writePng, upscalePng } = await import('../src/png.js');
const { bigImage, BIG_PX } = await import('../src/assets.js');
const { findRoot } = await import('../src/paths.js');
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');

const root = findRoot();
const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// every sample of a decoded picture as [row][x] = [channels…]
function pixels(img) {
  const ch = CH[img.colorType];
  const out = [];
  for (let y = 0; y < img.height; y++) {
    const row = img.rows.subarray(y * img.stride, (y + 1) * img.stride);
    const line = [];
    for (let x = 0; x < img.width; x++) {
      if (img.depth < 8) {
        const per = 8 / img.depth;
        line.push([(row[Math.floor(x / per)] >> (8 - img.depth * ((x % per) + 1))) & ((1 << img.depth) - 1)]);
      } else line.push([...row.subarray(x * ch, (x + 1) * ch)]);
    }
    out.push(line);
  }
  return out;
}
// a test picture written with a mix of filters, so the reader has to undo all of them
function makePng(width, height, depth, colorType, sample) {
  const ch = CH[colorType];
  const stride = Math.ceil((width * ch * depth) / 8);
  const bpp = Math.max(1, (ch * depth) >> 3);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const r = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const v = sample(x, y);
      if (depth < 8) {
        const per = 8 / depth;
        r[Math.floor(x / per)] |= v[0] << (8 - depth * ((x % per) + 1));
      } else v.forEach((b, k) => { r[x * ch + k] = b; });
    }
    rows.push(r);
  }
  const filtered = [];
  rows.forEach((r, y) => {
    const f = y % 5;
    const up = y ? rows[y - 1] : Buffer.alloc(stride);
    const o = Buffer.alloc(stride + 1);
    o[0] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? r[x - bpp] : 0;
      const b = up[x];
      const c = x >= bpp ? up[x - bpp] : 0;
      const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      o[x + 1] = (r[x] - pred) & 0xff;
    }
    filtered.push(o);
  });
  const extra = colorType === 3 ? [['PLTE', Buffer.from([...Array(1 << depth)].flatMap((_, i) => [i * 7 % 256, i * 13 % 256, i * 29 % 256]))]] : [];
  return writePng({ width, height, depth, colorType, extra }, Buffer.concat(filtered));
}

test('png: reads every filter, scales up sharp (each pixel becomes a factor x factor block), keeps the palette', () => {
  const cases = [[3, 2], [3, 4], [3, 8], [0, 8], [2, 8], [6, 8], [4, 8], [3, 1]];
  for (const [colorType, depth] of cases) {
    const ch = CH[colorType];
    const max = (1 << depth) - 1;
    const sample = (x, y) => [...Array(ch)].map((_, k) => (x * 3 + y * 5 + k * 11) % (max + 1));
    const src = makePng(11, 7, depth, colorType, sample);
    const img = readPng(src);
    assert.deepEqual([img.width, img.height, img.depth, img.colorType], [11, 7, depth, colorType]);
    const p = pixels(img);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 11; x++) assert.deepEqual(p[y][x], sample(x, y), `${colorType}/${depth} at ${x},${y}`);
    const big = readPng(scalePng(img, 5));
    assert.deepEqual([big.width, big.height, big.depth, big.colorType], [55, 35, depth, colorType]);
    const q = pixels(big);
    for (let y = 0; y < 35; y++) for (let x = 0; x < 55; x++) assert.deepEqual(q[y][x], sample(Math.floor(x / 5), Math.floor(y / 5)));
    assert.deepEqual(big.extra, img.extra);
  }
  assert.throws(() => readPng(Buffer.from('not a png')), /not a PNG/);
  assert.throws(() => scalePng(readPng(makePng(2, 2, 8, 0, () => [1])), 0), /scale factor/);
});

test('png: an MCP picture at 1008 px is the 28 px one, every pixel a 36 x 36 block, small enough to serve', () => {
  const src = fs.readFileSync(path.join(root, 'collection', 'images', '42.png'));
  const small = readPng(src);
  assert.equal(small.width, 28);
  const out = bigImage(src);
  const big = readPng(out);
  assert.equal(BIG_PX, 1008);
  assert.deepEqual([big.width, big.height, big.colorType, big.depth], [1008, 1008, small.colorType, small.depth]);
  const a = pixels(small);
  const b = pixels(big);
  for (let y = 0; y < 1008; y += 7) for (let x = 0; x < 1008; x += 5) assert.deepEqual(b[y][x], a[Math.floor(y / 36)][Math.floor(x / 36)]);
  assert.ok(out.length < 20_000, `${out.length} bytes`);
  // a picture that doesn't divide into 1008 px is refused, not stretched
  assert.throws(() => bigImage(upscalePng(src, 5)), /doesn't scale/);
  // the data is a real zlib stream (a browser will open it)
  assert.ok(zlib.inflateSync(out.subarray(out.indexOf('IDAT') + 4, out.lastIndexOf('IEND') - 8)).length > 0);
});

let db, server, base;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  const { app } = await createApp({ db, publicUrl: 'http://localhost', storage: memoryStorage() });
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

test('png: the API names the picture to download, the local server serves /big, the NFT page has a Download button', async () => {
  const items = JSON.parse(fs.readFileSync(path.join(root, 'collection', 'collection.json'), 'utf8')).items;
  const px = items.find((it) => it.px);
  const full = items.find((it) => !it.px);
  const nft = async (id) => (await fetch(`${base}/api/nfts/${id}`)).json();
  assert.equal((await nft(px.id)).big, `/big/${px.id}.png`);
  assert.equal((await nft(full.id)).big, `/img/${full.id}.png`); // already full size
  const list = await (await fetch(`${base}/api/nfts?limit=3`)).json();
  for (const n of list.items || list) assert.ok(n.big, 'every NFT in a list has big');
  const r = await fetch(`${base}/big/${px.id}.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const img = readPng(Buffer.from(await r.arrayBuffer()));
  assert.equal(img.width, 1008);
  assert.equal((await fetch(`${base}/big/999999.png`)).status, 404);
  const site = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  assert.match(site, /download="\$\{esc\(fileName\(n\)\)\}"/);
  assert.match(site, /Download PNG/);
  const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
  assert.match(toml, /for = "\/big\/\*"/);
});
