// The launchpad: creators sign in on the site, upload a collection, the owner reviews it, mints pay a fee to
// the market and the rest into the escrow, held 7 days and paid out only when the owner releases it, or refunded
// to the minters if the collection is frozen. Plus: privacy of drafts, the site session and its CSRF guard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

process.env.TEST_MODE = '1';
process.env.ADMIN_X_IDS = 'dev:boss';
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { LAUNCH } = await import('../src/launchpad.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { entryHash, GENESIS } = await import('../src/explorer.js');
const m = await import('../src/market.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let db, app, server, base, explorer, storage;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  storage = memoryStorage();
  ({ app, explorer } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

// a tiny valid PNG: w x h, one colour (RGB), built here so the test needs no image library
function png(w = 24, h = 24, rgb = [255, 42, 31]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// a browser session on the site: test sign-in (DEV_LOGIN), cookies kept by hand
async function browser(handle) {
  const jar = new Map();
  const keep = (r) => {
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (v) jar.set(k, v); else jar.delete(k);
    }
    return r;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const raw = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: cookie(), ...(opts.headers || {}) } }).then(keep);
  // /login/site starts a sign-in and sends the browser to the sign-in page
  const start = await raw('/login/site?return=%2F%23%2Flaunch');
  assert.equal(start.status, 302);
  const loc = start.headers.get('location');
  const id = new URL(loc, base).searchParams.get('req');
  const done = await raw('/login/dev', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${id}&handle=${handle}` });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/#/launch', 'back to where the sign-in started');
  const call = async (method, path, body, headers = { 'X-MCP-Site': '1', origin: 'http://localhost' }) => {
    const r = await raw('/api' + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { raw, call, cookie };
}

async function chat(userId) {
  const s = buildMcpServer(db, userId, { publicUrl: 'http://localhost', thumbsDir: '/nonexistent', deposits: { enabled: false }, withdrawals: null, ui: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  return async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { ...r, text: (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n') };
  };
}
const userOf = async (handle) => (await db.query('select * from users where handle = $1', [handle]))[0];
const balance = async (handle) => Number((await userOf(handle)).balance);
const item = (edition, extra = {}) => ({
  edition, name: `Frog #${edition}`, pixel: true,
  attributes: [{ trait_type: 'Rarity', value: edition === 1 ? 'Legendary' : 'Common' }, { trait_type: 'Hat', value: edition % 2 ? 'Cap' : 'None' }],
  image: png(24, 24, [edition * 20, 100, 50]).toString('base64'), thumb: png(252, 252).toString('base64'), ...extra,
});
async function ledgerMatches() {
  const [r] = await db.query(`select (select coalesce(sum(delta), 0) from ledger where user_id is not null)::bigint as l,
    (select coalesce(sum(balance), 0) from users)::bigint as b`);
  assert.equal(r.l, r.b, 'user balances equal the ledger');
}

let frogs; // the collection made below, shared by the tests that follow
let creator, boss, fan;

test('signing in on the site: a session cookie, /api/me, and nothing works without the site header', async () => {
  creator = await browser('frogmaker');
  const meRes = await creator.call('GET', '/me');
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.handle, 'frogmaker');
  assert.equal(meRes.body.admin, false);
  assert.match(meRes.body.public_id, /^mcp_/);
  assert.equal((await fetch(base + '/api/me')).status, 401, 'no session');
  // changes need the site's own header and origin: a form on another site can't make them
  const csrf = await creator.call('POST', '/launch', { name: 'x' }, {});
  assert.equal(csrf.status, 403);
  const other = await creator.call('POST', '/launch', { name: 'x' }, { 'X-MCP-Site': '1', origin: 'https://evil.example' });
  assert.equal(other.status, 403);
  // only a path on this site to go back to after signing in
  const bad = await creator.raw('/login/site?return=https%3A%2F%2Fevil.example');
  assert.equal(bad.status, 400);
  boss = await browser('boss');
  const bossMe = (await boss.call('GET', '/me')).body;
  assert.equal(bossMe.admin, true);
  assert.equal(bossMe.x_id, 'dev:boss', 'the owner sees the id to put in ADMIN_X_IDS');
});

test('a creator makes a draft, uploads pictures in batches, and submits it for review', async () => {
  const bad = await creator.call('POST', '/launch', { name: 'Pixel Frogs', slug: 'mcp', supply: 4, mint_price: 2, mint_limit: 2 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /collection id/);
  const made = await creator.call('POST', '/launch', { name: 'Pixel Frogs', slug: 'pixel-frogs', description: 'Frogs <b>on</b> chat', supply: 4, mint_price: 2, mint_limit: 2 });
  assert.equal(made.status, 200);
  frogs = made.body;
  assert.equal(frogs.status, 'draft');
  assert.equal(frogs.description, 'Frogs bon/b chat', 'no markup gets in');
  assert.equal(Number(frogs.fee_bps), 1000);
  // a draft is not public
  assert.equal((await fetch(base + '/api/collections/pixel-frogs')).status, 404);
  assert.equal((await fetch(base + '/api/stats?collection=pixel-frogs')).status, 404);
  assert.ok(!(await fetch(base + '/api/collections').then((r) => r.json())).some((c) => c.slug === 'pixel-frogs'));
  // not everything is a picture
  const svg = await creator.call('POST', `/launch/${frogs.id}/items`, { items: [item(1, { image: Buffer.from('<svg onload=alert(1)>').toString('base64') })] });
  assert.equal(svg.status, 400);
  assert.match(svg.body.error, /PNG, JPEG, GIF or WEBP/);
  assert.equal((await creator.call('POST', `/launch/${frogs.id}/items`, { items: [item(5)] })).status, 400, 'outside the supply');
  // trait names like __proto__ are dropped, and the server keeps working
  await creator.call('POST', `/launch/${frogs.id}/items`, { items: [item(1, { attributes: [
    { trait_type: '__proto__', value: 'site' }, { trait_type: 'constructor', value: 'hasOwn' }, { trait_type: 'Hat', value: 'prototype' }, { trait_type: 'Rarity', value: 'Legendary' }] })] });
  assert.equal(({}).site, undefined);
  assert.equal(typeof Object.hasOwn, 'function');
  assert.deepEqual((await db.query('select attributes from nfts where collection_id = $1 and edition = 1', [frogs.id]))[0].attributes, [{ trait_type: 'Rarity', value: 'Legendary' }]);
  // two batches; one NFT sent twice is replaced, not doubled
  assert.equal((await creator.call('POST', `/launch/${frogs.id}/items`, { items: [item(1), item(2)] })).body.uploaded, 2);
  assert.equal((await creator.call('POST', `/launch/${frogs.id}/submit`)).status, 400, 'not all uploaded');
  assert.equal((await creator.call('POST', `/launch/${frogs.id}/items`, { items: [item(2), item(3), item(4)] })).body.uploaded, 4);
  // someone else can't touch it
  const stranger = await browser('stranger');
  assert.equal((await stranger.call('POST', `/launch/${frogs.id}/items`, { items: [item(1)] })).status, 400);
  assert.equal((await stranger.call('POST', `/launch/${frogs.id}/submit`)).status, 400);
  // the pictures: the creator sees them, nobody else while it is not live
  const [first] = await db.query('select id from nfts where collection_id = $1 and edition = 1', [frogs.id]);
  frogs.first = first.id;
  assert.ok(first.id > 5000, 'creator NFTs are numbered after the MCP collection');
  const pic = await creator.raw(`/img/${first.id}.png`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.match(pic.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${base}/img/${first.id}.png`)).status, 404, 'a draft\'s pictures are private');
  // nothing of it on public pages or in the chat before the owner approves it
  assert.equal((await fetch(`${base}/api/nfts/${first.id}`)).status, 404);
  assert.equal((await creator.call('GET', `/nfts/${first.id}`)).status, 200, 'its creator can open it');
  const listed = await fetch(`${base}/api/nfts?status=unminted&sort=id&limit=200&offset=4900`).then((r) => r.json());
  assert.ok(!listed.some((n) => n.collection === 'pixel-frogs'));
  assert.equal((await fetch(`${base}/api/stats`).then((r) => r.json())).supply, 5000, 'the market counts only public collections');
  const peek = await chat((await userOf('stranger')).id);
  assert.match((await peek('nft', { nft_id: first.id })).text, /does not exist/);
  assert.equal((await peek('mint', { collection: 'pixel-frogs' })).isError, true);
  const sub = await creator.call('POST', `/launch/${frogs.id}/submit`);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'review');
  assert.equal((await creator.call('POST', `/launch/${frogs.id}/items`, { items: [item(1)] })).status, 400, 'no changes in review');
  const mine = (await creator.call('GET', '/launch/mine')).body;
  assert.equal(mine[0].slug, 'pixel-frogs');
  assert.equal(mine[0].uploaded, 4);
});

test('only the owner reviews: approve makes it public and mintable', async () => {
  assert.equal((await creator.call('POST', `/admin/collections/${frogs.id}/approve`, {})).status, 403);
  // taking the owner's handle is not enough: the owner is an X account id
  await db.query("update users set handle = 'boss-old' where x_id = 'dev:boss'");
  await db.query("update users set handle = 'boss' where handle = 'frogmaker'");
  assert.equal((await creator.call('GET', '/me')).body.admin, false);
  assert.equal((await creator.call('POST', `/admin/collections/${frogs.id}/approve`, {})).status, 403);
  await db.query("update users set handle = 'frogmaker' where handle = 'boss'");
  await db.query("update users set handle = 'boss' where x_id = 'dev:boss'");
  const queue = (await boss.call('GET', '/admin/collections')).body;
  assert.equal(queue.find((c) => c.id === frogs.id).status, 'review');
  // the owner can look at it before approving
  assert.equal((await boss.call('GET', '/collections/pixel-frogs')).status, 200);
  assert.equal((await boss.raw(`/img/${frogs.first}.png`)).status, 200);
  const ok = await boss.call('POST', `/admin/collections/${frogs.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'live');
  const pub = await fetch(base + '/api/collections/pixel-frogs').then((r) => r.json());
  assert.equal(pub.supply, 4);
  assert.equal(pub.cover, `/img/${frogs.first}.png`);
  assert.deepEqual(pub.traits.map((t) => t.type), ['Rarity', 'Hat']);
  const pic = await fetch(`${base}/img/${frogs.first}.png`);
  assert.equal(pic.status, 200);
  assert.match(pic.headers.get('cache-control'), /public/);
  assert.equal((await fetch(`${base}/thumb/${frogs.first}.png`)).status, 200);
});

test('a mint: 10% to the market, 90% into the escrow, held; the escrow counts as owed', async () => {
  const f = await m.upsertUser(db, { xId: 'dev:fan', handle: 'fan' });
  fan = f;
  await m.credit(db, f.id, 20e6, 'deposit', 'seed fan');
  const call = await chat(f.id);
  const list = await call('collections');
  assert.match(list.text, /Pixel Frogs \(collection: pixel-frogs\) · 0\/4 minted · mint 2 \$MCP, up to 2 per account/);
  const minted = await call('mint', { collection: 'pixel-frogs' });
  assert.equal(minted.isError, undefined, minted.text);
  assert.match(minted.text, /Minted Frog #\d/);
  assert.equal(await balance('fan'), 18e6);
  const id = Number((await db.query('select id from nfts where collection_id = $1 and minted_by = $2', [frogs.id, f.id]))[0].id);
  const rows = await db.query('select user_id, delta, kind from ledger where ref = $1 order by id', [String(id)]);
  assert.deepEqual(rows.map((r) => [r.user_id, Number(r.delta), r.kind]), [[f.id, -2e6, 'mint'], [null, 0.2e6, 'mint_fee'], [null, 1.8e6, 'hold']]);
  await call('mint', { collection: 'pixel-frogs' });
  assert.equal((await call('mint', { collection: 'pixel-frogs' })).isError, true, 'limit 2 per account');
  // in the explorer the held part sits in the escrow account
  await explorer.seal();
  const { body: tx } = await fetch(`${base}/api/explorer/txs?limit=5`).then(async (r) => ({ body: await r.json() }));
  const mint = tx.find((t) => t.type === 'mint');
  assert.deepEqual(mint.entries.map((e) => [e.account === f.public_id ? 'fan' : e.account, e.amount, e.kind]),
    [['fan', -2, 'mint'], ['treasury', 0.2, 'mint_fee'], ['escrow', 1.8, 'hold']]);
  assert.equal(mint.nft.collection, 'pixel-frogs');
  const o = await explorer.owed();
  assert.equal(o.escrow, 3600000n);
  await ledgerMatches();
});

test('payouts: nothing before 7 days, then only when the owner releases it, to the creator\'s balance', async () => {
  assert.equal((await boss.call('POST', `/admin/collections/${frogs.id}/release`, {})).body.released, 0, 'still in the hold');
  assert.equal(await balance('frogmaker'), 0);
  // a week later (the hold is counted from each mint)
  await db.query("update mint_holds set created_at = created_at - interval '8 days' where collection_id = $1", [frogs.id]);
  const mine = (await creator.call('GET', '/launch/mine')).body.find((c) => c.id === frogs.id);
  assert.equal(mine.earnings.releasable, 3.6e6);
  assert.equal(await balance('frogmaker'), 0, 'not paid until the owner releases it');
  assert.equal((await creator.call('POST', `/admin/collections/${frogs.id}/release`, {})).status, 403, 'the creator can not release it');
  const r = await boss.call('POST', `/admin/collections/${frogs.id}/release`, {});
  assert.equal(r.body.released, 3.6e6);
  assert.equal(await balance('frogmaker'), 3.6e6);
  assert.equal((await boss.call('POST', `/admin/collections/${frogs.id}/release`, {})).body.released, 0, 'paid once');
  await explorer.seal();
  const txs = await fetch(`${base}/api/explorer/txs?limit=3`).then((x) => x.json());
  const payout = txs.find((t) => t.type === 'payout');
  assert.deepEqual(payout.entries.map((e) => [e.account === 'escrow' ? 'escrow' : 'creator', e.amount, e.kind]), [['escrow', -3.6, 'hold_release'], ['creator', 3.6, 'payout']]);
  assert.equal(payout.collection.slug, 'pixel-frogs');
  assert.equal((await explorer.owed()).escrow, 0n);
  await ledgerMatches();
});

test('a scam: freeze stops minting and trading and refunds every mint still held, in full, to whoever holds it', async () => {
  const fan2 = await m.upsertUser(db, { xId: 'dev:fan2', handle: 'fan2' });
  await m.credit(db, fan2.id, 10e6, 'deposit', 'seed fan2');
  const call = await chat(fan2.id);
  assert.equal((await call('mint', { collection: 'pixel-frogs' })).isError, undefined);
  const [mineNft] = await db.query('select id from nfts where minted_by = $1', [fan2.id]);
  assert.equal((await call('sell', { nft_id: mineNft.id, price: 9 })).isError, undefined);
  assert.equal(await balance('fan2'), 8e6);
  // the scammer's own account mints and sells to a real buyer
  const alt = await m.upsertUser(db, { xId: 'dev:alt', handle: 'alt' });
  const victim = await m.upsertUser(db, { xId: 'dev:victim', handle: 'victim' });
  await m.credit(db, alt.id, 10e6, 'deposit', 'seed alt');
  await m.credit(db, victim.id, 10e6, 'deposit', 'seed victim');
  const altNft = await m.mint(db, alt.id, { collection: 'pixel-frogs' });
  await m.list(db, alt.id, altNft.id, 7e6);
  await m.buy(db, victim.id, altNft.id, 7e6);
  assert.equal(await balance('victim'), 3e6);
  const treasuryBefore = (await explorer.owed()).treasury;
  const f = await boss.call('POST', `/admin/collections/${frogs.id}/freeze`, { note: 'stolen art' });
  assert.equal(f.status, 200);
  assert.equal(f.body.refunded, 4e6);
  assert.equal(f.body.mints, 2);
  assert.equal(await balance('fan2'), 10e6, 'the whole mint price back');
  assert.equal(await balance('victim'), 5e6, 'the buyer left holding it gets the mint price back');
  assert.equal(await balance('alt'), 8e6 + 6.825e6, 'the account that minted and sold gets nothing more');
  assert.equal((await fetch(`${base}/img/${altNft.id}.png`)).status, 410, 'a frozen collection\'s pictures are not served');
  await explorer.seal();
  const freezeTx = (await fetch(`${base}/api/explorer/txs?limit=3`).then((r) => r.json())).find((t) => t.refunds);
  assert.deepEqual([freezeTx.type, freezeTx.refunds, freezeTx.refunded], ['refund', 2, 4]);
  assert.equal(await balance('fan'), 16e6, 'mints already paid out to the creator are not refunded');
  assert.equal((await explorer.owed()).treasury, treasuryBefore - 400000n, 'the market gives its fee back too');
  assert.equal((await explorer.owed()).escrow, 0n);
  assert.equal((await call('mint', { collection: 'pixel-frogs' })).isError, true);
  assert.equal((await db.query('select price from nfts where id = $1', [mineNft.id]))[0].price, null, 'taken off sale');
  assert.equal((await call('sell', { nft_id: mineNft.id, price: 9 })).isError, true, 'no trading in a frozen collection');
  assert.equal((await boss.call('POST', `/admin/collections/${frogs.id}/release`, {})).status, 400, 'a frozen collection pays nobody');
  const mine = (await creator.call('GET', '/launch/mine')).body.find((c) => c.id === frogs.id);
  assert.equal(mine.status, 'frozen');
  assert.equal(mine.review_note, 'stolen art');
  await ledgerMatches();
});

test('the chain still verifies with the escrow rows, and old kinds keep their hashes', async () => {
  await explorer.seal();
  let prev = GENESIS;
  let after = 0;
  for (;;) {
    const page = await fetch(`${base}/api/explorer/chain?after=${after}&limit=1000`).then((r) => r.json());
    if (!page.length) break;
    for (const e of page) {
      assert.equal(entryHash(prev, e), e.hash, `entry ${e.seq}`);
      prev = e.hash;
      after = e.seq;
    }
  }
  assert.ok(after > 10);
});

test('uploads have a quota per collection, and at most 3 unfinished collections per account', async () => {
  const keep = LAUNCH.maxBytes;
  LAUNCH.maxBytes = 3000;
  try {
    const q = (await creator.call('POST', '/launch', { name: 'Big', slug: 'big-one', supply: 9, mint_price: 1, mint_limit: 1 })).body;
    const r = await creator.call('POST', `/launch/${q.id}/items`, { items: [item(1), item(2), item(3), item(4), item(5), item(6)] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /over 0 GB of pictures/);
    assert.equal((await creator.call('DELETE', `/launch/${q.id}`)).status, 200);
  } finally {
    LAUNCH.maxBytes = keep;
  }
  const made = [];
  for (const s of ['a1x', 'a2x', 'a3x']) made.push((await creator.call('POST', '/launch', { name: s, slug: s, supply: 1, mint_price: 1, mint_limit: 1 })).body);
  const fourth = await creator.call('POST', '/launch', { name: 'a4x', slug: 'a4x', supply: 1, mint_price: 1, mint_limit: 1 });
  assert.equal(fourth.status, 400);
  assert.match(fourth.body.error, /already have 3/);
  for (const c of made) await creator.call('DELETE', `/launch/${c.id}`);
});

test('a draft can be deleted with its pictures; a rejected one too', async () => {
  const d = (await creator.call('POST', '/launch', { name: 'Toads', slug: 'toads', supply: 2, mint_price: 1, mint_limit: 1 })).body;
  await creator.call('POST', `/launch/${d.id}/items`, { items: [item(1), item(2)] });
  const before = storage.size();
  assert.equal((await creator.call('DELETE', `/launch/${d.id}`)).status, 200);
  assert.equal(storage.size(), before - 4);
  assert.equal((await db.query("select count(*)::int as n from collections where slug = 'toads'"))[0].n, 0);
  const r = (await creator.call('POST', '/launch', { name: 'Toads', slug: 'toads', supply: 1, mint_price: 1, mint_limit: 1 })).body;
  await creator.call('POST', `/launch/${r.id}/items`, { items: [item(1)] });
  await creator.call('POST', `/launch/${r.id}/submit`);
  const rej = await boss.call('POST', `/admin/collections/${r.id}/reject`, { note: 'not your art' });
  assert.equal(rej.body.status, 'rejected');
  assert.equal((await fetch(base + '/api/collections/toads')).status, 404);
  assert.equal((await creator.call('DELETE', `/launch/${r.id}`)).status, 200);
});
