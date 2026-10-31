// The MCP collection: 5,000 NFTs with traits, minting per collection, trait filters, NFT pages,
// the switch from the test NFTs, and the image archives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open'; // these tests trade MCP NFTs long before 5,000 are minted
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/schema.js');
const { findRoot } = await import('../src/paths.js');
const { readTarGz, unpackCollection } = await import('../src/assets.js');
const { buildMcpServer } = await import('../src/mcp.js');
const m = await import('../src/market.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const ROOT = findRoot();
let db, app, server, base, explorer;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app, explorer } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
let n = 0;
async function user(dollars = 100) {
  const handle = `col${++n}`;
  const u = await m.upsertUser(db, { xId: `dev:${handle}`, handle });
  if (dollars) await m.credit(db, u.id, dollars * 1e6, 'deposit', `seed ${handle}`);
  return u;
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

test('the collection is seeded once: 5,000 NFTs with their traits and the rarity counts', async () => {
  const [c] = await db.query("select * from collections where slug = 'mcp'");
  assert.equal(c.name, 'MCP');
  assert.equal(c.supply, 5000);
  assert.equal(c.creator_id, null, 'the market\'s own collection');
  assert.equal(Number(c.mint_price), 5e6);
  assert.equal(c.mint_limit, 5);
  assert.deepEqual(c.traits.Rarity, { Rare: 1400, Common: 2750, Epic: 600, Legendary: 200, 'Ultra-Rare': 50 });
  assert.equal(c.traits.Chassis.Bunny, 285);
  const [{ count, first, last }] = await db.query("select count(*)::int as count, min(id) as first, max(id) as last from nfts where collection_id = $1", [c.id]);
  assert.deepEqual([count, first, last], [5000, 1, 5000]);
  const [one] = await db.query('select * from nfts where id = 1');
  assert.equal(one.name, 'MCP #1');
  assert.equal(one.edition, 1);
  assert.equal(one.rarity, 'Rare');
  assert.deepEqual(one.attributes[2], { trait_type: 'Chassis', value: 'Bunny' });
  // a second start adds nothing
  assert.equal(await m.seedCollection(db, path.join(ROOT, 'collection', 'collection.json')), 5000);
  assert.equal((await db.query('select count(*)::int as n from nfts'))[0].n, 5000);
  assert.equal((await db.query('select count(*)::int as n from collections'))[0].n, 1);
});

test('mint: 5 $MCP to the treasury, a random unminted NFT, at most 5 per account even in parallel', async () => {
  const u = await user(100);
  const tries = await Promise.allSettled(Array.from({ length: 8 }, () => m.mint(db, u.id)));
  const ok = tries.filter((t) => t.status === 'fulfilled').map((t) => t.value);
  assert.equal(ok.length, 5);
  assert.ok(tries.filter((t) => t.status === 'rejected').every((t) => /Mint limit reached: 5 per account in MCP/.test(t.reason.message)));
  assert.equal(new Set(ok.map((x) => x.id)).size, 5);
  assert.ok(ok.every((x) => x.minted_by === u.id && x.owner_id === u.id && x.price === 5e6 && x.collection === 'mcp'));
  assert.equal(Number((await m.getUser(db, u.id)).balance), 75e6);
  // selling a minted NFT does not give the minter another mint
  const buyer = await user(100);
  await m.list(db, u.id, ok[0].id, 7e6);
  await m.buy(db, buyer.id, ok[0].id, 7e6);
  await assert.rejects(m.mint(db, u.id), /Mint limit reached/);
  await assert.rejects(m.mint(db, u.id, { collection: 'nope' }), /There is no collection "nope"/);
  const [t] = await db.query("select coalesce(sum(delta), 0)::bigint as s from ledger where user_id is null and kind = 'mint'");
  assert.ok(Number(t.s) >= 25e6);
});

test('the mint price and limit follow MINT_PRICE_USD / MINT_LIMIT_PER_USER on the next start', async () => {
  const before = { price: m.CONFIG.mintPrice, limit: m.CONFIG.mintLimit };
  try {
    m.CONFIG.mintLimit = 20;
    await m.seedCollection(db, path.join(ROOT, 'collection', 'collection.json'));
    assert.equal((await m.getCollection(db, 'mcp')).mint_limit, 20);
  } finally {
    m.CONFIG.mintLimit = before.limit;
    await m.seedCollection(db, path.join(ROOT, 'collection', 'collection.json'));
  }
  assert.equal((await m.getCollection(db, 'mcp')).mint_limit, 5);
});

test('trait filters: values of one trait are alternatives, different traits must all match', async () => {
  const count = (traits, extra = {}) => m.browseCount(db, { collection: 'mcp', traits, ...extra });
  assert.equal(await count([['Chassis', 'Bunny']]), 285);
  assert.equal(await count([['Chassis', 'Bunny'], ['Chassis', 'Bubble']]), 285 + 284);
  assert.equal(await count([['Chassis', 'Bunny'], ['Bloodline', 'Void Born']]), 0, 'every Bunny is Scarf Gang');
  const onion = await count([['Chassis', 'Onion']]);
  assert.equal(await count([['Chassis', 'Onion'], ['Bloodline', 'Void Born']]), onion, 'every Onion is Void Born');
  const both = await count([['Chassis', 'Onion'], ['Rarity', 'Common']]);
  assert.ok(both > 0 && both < onion);
  assert.equal(await count([['Chassis', 'Onion']], { rarity: 'Common' }), both);
  assert.equal(await count([], { rarity: 'ultra-rare' }), 50);
  assert.equal(await count([['Chassis', 'No such']]), 0);
  // the page API: a total and one page of items
  const { body } = await get('/api/collections/mcp/nfts?trait=Chassis:Bunny&limit=50&offset=250');
  assert.equal(body.total, 285);
  assert.equal(body.items.length, 35);
  assert.ok(body.items.every((x) => x.attributes.some((a) => a.trait_type === 'Chassis' && a.value === 'Bunny')));
  assert.ok(body.items.every((x) => x.image === `/img/${x.id}.png` && x.thumb === `/thumb/${x.id}.png` && typeof x.pixel === 'boolean'));
});

test('public API: collections with numbers and every trait with its share', async () => {
  const { body: list } = await get('/api/collections');
  const mcp = list.find((c) => c.slug === 'mcp');
  assert.equal(mcp.supply, 5000);
  assert.equal(mcp.mint_price, 5);
  assert.equal(mcp.cover, '/covers/mcp.png');
  assert.ok(mcp.minted >= 5);
  const { body: c } = await get('/api/collections/mcp');
  const rarity = c.traits.find((t) => t.type === 'Rarity');
  assert.deepEqual(rarity.values.map((v) => [v.value, v.count, v.percent]),
    [['Common', 2750, 55], ['Rare', 1400, 28], ['Epic', 600, 12], ['Legendary', 200, 4], ['Ultra-Rare', 50, 1]]);
  assert.equal(c.traits.length, 12);
  assert.deepEqual(c.traits.map((t) => t.type), ['Rarity', 'Render Engine', 'Chassis', 'Bloodline', 'Paint Job', 'Habitat', 'Trim', 'Lid', 'Optics', 'Fit', 'Bling', 'Side Quest'],
    'in the artist\'s order');
  assert.equal((await get('/api/collections/nope')).status, 404);
  // odd input is a normal answer, never a server error
  for (const sort of ['constructor', '__proto__', 'toString', 'nope']) assert.equal((await get(`/api/nfts?sort=${sort}&limit=1`)).status, 200, sort);
  assert.equal((await get('/api/nfts/99999999999')).status, 404);
  const { body: s } = await get('/api/stats?collection=mcp');
  assert.equal(s.supply, 5000);
  assert.equal((await get('/api/stats?collection=nope')).status, 404);
});

test('an NFT page: traits with their share, owner, and every mint and sale as an explorer transaction', async () => {
  const seller = await user(50);
  const buyer = await user(50);
  const nft = await m.mint(db, seller.id);
  await m.list(db, seller.id, nft.id, 12e6);
  await m.buy(db, buyer.id, nft.id, 12e6);
  const { body: n } = await get(`/api/nfts/${nft.id}`);
  assert.equal(n.owner_addr, buyer.public_id);
  assert.ok(n.attributes.every((a) => a.count > 0));
  assert.equal(n.attributes.find((a) => a.trait_type === 'Rarity').percent, { Common: 55, Rare: 28, Epic: 12, Legendary: 4, 'Ultra-Rare': 1 }[n.rarity]);
  assert.deepEqual(n.activity.map((a) => [a.type, a.price, a.to_addr, a.from_addr ?? null]),
    [['sale', 12, buyer.public_id, seller.public_id], ['mint', 5, seller.public_id, null]]);
  for (const a of n.activity) {
    const { body: tx } = await get(`/api/explorer/tx/${a.tx}`);
    assert.equal(tx.type, a.type === 'sale' ? 'buy' : 'mint');
    assert.equal(tx.nft.id, nft.id);
    assert.equal(tx.nft.name, nft.name);
    assert.equal(tx.nft.thumb, `/thumb/${nft.id}.png`);
  }
  // the explorer's totals count minted NFTs
  await explorer.refreshStats();
  assert.ok((await get('/api/explorer/summary')).body.minted >= 1);
});

test('in the chat: collections, mint with traits, market filtered by traits', async () => {
  const u = await user(30);
  const call = await chat(u.id);
  const cols = await call('collections');
  assert.match(cols.text, /MCP \(collection: mcp\) · \d+\/5000 minted · mint 5 \$MCP, up to 5 per account/);
  const minted = await call('mint');
  assert.equal(minted.isError, undefined);
  assert.match(minted.text, /Minted MCP #\d+ · (Common|Rare|Epic|Legendary|Ultra-Rare)/);
  assert.match(minted.text, /Chassis: [\w ]+ \([\d.]+% have it\)/);
  assert.match(minted.text, /Minted 1 of 5 allowed in MCP/);
  const id = Number(minted.text.match(/MCP #(\d+)/)[1]);
  const chassis = minted.text.match(/Chassis: ([\w ]+) \(/)[1];
  assert.equal((await call('sell', { nft_id: id, price: 9 })).isError, undefined);
  const market = await call('market', { traits: [`Chassis: ${chassis}`] });
  assert.match(market.text, new RegExp(`MCP #${id} · .*listed at 9 \\$MCP`));
  const none = await call('market', { traits: ['Chassis: No such'] });
  assert.match(none.text, /Nothing for sale matches/);
  assert.equal((await call('mint', { collection: 'nope' })).isError, true);
  const nft = await call('nft', { nft_id: id });
  assert.match(nft.text, /Traits:\nRarity: /);
  const acct = await call('account');
  assert.match(acct.text, new RegExp(`-5 \\$MCP mint MCP #${id}`));
});

test('migration: unminted test NFTs are replaced by the collection, minted ones stop it', async () => {
  const fresh = await openDb({ url: '' });
  try {
    // a database from before collections: test NFTs without a collection
    await fresh.query("insert into nfts (id, name, rarity) values (9001, 'MCP #9001', 'common'), (9002, 'MCP #9002', 'rare')");
    await fresh.query("delete from app_meta where key = 'data:mcp-collection'");
    await fresh.query("update app_meta set value = 'old' where key = 'schema'");
    assert.equal(await migrate(fresh), true);
    assert.equal((await fresh.query('select count(*)::int as n from nfts where id > 9000'))[0].n, 0);
    // one of them was minted: nothing is touched and the start fails loudly
    const u = await m.upsertUser(fresh, { xId: 'dev:t', handle: 't' });
    await fresh.query("insert into nfts (id, name, owner_id, minted_at) values (9003, 'MCP #9003', $1, now()), (9004, 'MCP #9004', null, null)", [u.id]);
    await fresh.query("delete from app_meta where key = 'data:mcp-collection'");
    await fresh.query("update app_meta set value = 'old' where key = 'schema'");
    await assert.rejects(migrate(fresh), /the test NFTs were minted here/);
    assert.equal((await fresh.query('select count(*)::int as n from nfts where id > 9000'))[0].n, 2);
  } finally {
    await fresh.close();
  }
});

test('image archives: 5,000 pictures and 5,000 thumbnails, unpacked only as <number>.png', async () => {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const file of ['mcp-images.tar.gz', 'mcp-thumbs.tar.gz']) {
    const files = readTarGz(path.join(ROOT, 'collection', file));
    assert.equal(files.length, 5000, file);
    assert.deepEqual(files.map((f) => f.name).sort((a, b) => parseInt(a) - parseInt(b)), Array.from({ length: 5000 }, (_, i) => `${i + 1}.png`));
    assert.ok(files.every((f) => f.data.subarray(0, 8).equals(pngSig)), `${file}: every file is a PNG`);
  }
  // unpacking into a copy of the project
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unpack-'));
  try {
    fs.mkdirSync(path.join(tmp, 'collection'));
    for (const f of ['mcp-images.tar.gz', 'mcp-thumbs.tar.gz']) fs.copyFileSync(path.join(ROOT, 'collection', f), path.join(tmp, 'collection', f));
    const counts = unpackCollection(tmp, { dist: path.join(tmp, 'dist') });
    assert.deepEqual(counts, { images: 5000, thumbs: 5000 });
    assert.ok(fs.existsSync(path.join(tmp, 'dist', 'img', '5000.png')) && fs.existsSync(path.join(tmp, 'dist', 'thumb', '1.png')));
    assert.ok(fs.existsSync(path.join(tmp, 'collection', 'thumbs', '42.png')), 'the function bundles collection/thumbs');
    // an archive with any other name is refused, so nothing can be written outside the folder
    const evil = path.join(tmp, 'evil.tar.gz');
    fs.writeFileSync(evil, zlib.gzipSync(tarOf([['../x.png', Buffer.from('x')]])));
    assert.throws(() => readTarGz(evil), /unexpected file "\.\.\/x\.png"/);
    fs.writeFileSync(evil, zlib.gzipSync(tarOf([['1.png', Buffer.alloc(1000, 1)]]).subarray(0, 900)));
    assert.throws(() => readTarGz(evil), /cut short/);
    const garbled = tarOf([['1.png', Buffer.from('ok')]]);
    garbled.write('zzzzzzzzzzz\0', 124); // a size that is not a number (checksum fixed below)
    garbled.write('        ', 148);
    let sum = 0;
    for (const b of garbled.subarray(0, 512)) sum += b;
    garbled.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    fs.writeFileSync(evil, zlib.gzipSync(garbled));
    assert.throws(() => readTarGz(evil), /bad size/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mint phase: MCP NFTs can be minted but not listed or bought until all 5,000 are minted (MCP_TRADING)', async () => {
  const file = path.join(ROOT, 'collection', 'collection.json');
  const seller = await user();
  const buyer = await user();
  const nft = await m.mint(db, seller.id, {});
  await m.list(db, seller.id, nft.id, 40e6); // while trading is open
  delete process.env.MCP_TRADING; // the default
  try {
    await m.seedCollection(db, file);
    assert.equal((await m.getCollection(db, 'mcp')).trade_after_sold_out, true);
    const [was] = await db.query('select price from nfts where id = $1', [nft.id]);
    assert.equal(was.price, null, 'listings made while it was open come off the market');
    const call = await chat(seller.id);
    const sell = await call('sell', { nft_id: nft.id, price: 50 });
    assert.equal(sell.isError, true);
    assert.match(sell.text, /Trading in MCP opens when the whole collection is minted: [\d,]+ of 5,000 so far/);
    const minted = await call('mint', {});
    assert.match(minted.text, /It can be sold once the whole collection is minted/);
    assert.match((await call('collections')).text, /trading opens after the sell-out/);
    // a listing made before the switch can't be bought either
    await db.query('update nfts set price = 50000000, listed_at = now() where id = $1', [nft.id]);
    await assert.rejects(m.buy(db, buyer.id, nft.id, 50e6), /opens when the whole collection is minted/);
    await db.query('update nfts set price = null, listed_at = null where id = $1', [nft.id]);
    const page = (await get('/api/collections/mcp')).body;
    assert.equal(page.trading_open, false);
    assert.equal((await get('/api/collections')).body.find((c) => c.slug === 'mcp').trading_open, false);
    assert.equal((await get('/api/stats')).body.trading_open, false, 'the home page knows it is the mint phase');
    // the last NFT minted: trading opens by itself, no restart needed
    await db.query("update nfts set owner_id = $1, minted_by = $1, minted_at = now() where collection_id = (select id from collections where slug = 'mcp') and minted_at is null", [buyer.id]);
    assert.equal((await get('/api/collections/mcp')).body.trading_open, true);
    assert.equal((await get('/api/stats')).body.trading_open, true);
    assert.equal((await call('sell', { nft_id: nft.id, price: 50 })).isError, undefined);
    assert.equal((await m.buy(db, buyer.id, nft.id, 50e6)).price, 50e6);
  } finally {
    process.env.MCP_TRADING = 'open';
    await m.seedCollection(db, file);
  }
  assert.equal((await m.getCollection(db, 'mcp')).trade_after_sold_out, false, 'MCP_TRADING=open opens it on the next start');
});

test('a collection that trades after its sell-out opens with the real last mint', async () => {
  const creator = await user(0);
  const [c] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, trade_after_sold_out)
    values ('duo', 'Duo', $1, 2, 1000000, 1, 1000, 'live', true) returning id`, [creator.id]);
  for (const e of [1, 2]) await db.query("insert into nfts (id, name, collection_id, edition) values (nextval('nft_ids'), $2, $1, $3)", [c.id, `Duo #${e}`, e]);
  const [a, b] = [await user(), await user()];
  const first = await m.mint(db, a.id, { collection: 'duo' });
  assert.equal(first.sold_out, false);
  await assert.rejects(m.list(db, a.id, first.id, 3e6), /Trading in Duo opens when the whole collection is minted: 1 of 2 so far/);
  const second = await m.mint(db, b.id, { collection: 'duo' });
  assert.equal(second.sold_out, true);
  assert.equal(Number((await m.list(db, a.id, first.id, 3e6)).price), 3e6);
  assert.equal((await m.buy(db, b.id, first.id, 3e6)).price, 3e6);
});

test('the website pages have plain addresses: /c/mcp, /nft/1, /connect are the site page; the API stays the API', async () => {
  for (const pg of ['/c/mcp', '/nft/1', '/connect', '/explorer', '/collections', '/launch', '/admin', '/tx/1', '/a/treasury', '/u/someone', '/c/mcp/']) {
    const r = await fetch(base + pg);
    assert.equal(r.status, 200, pg);
    assert.match(await r.text(), /<main id="app">/, pg);
  }
  assert.equal((await fetch(base + '/api/collections/mcp')).headers.get('content-type').includes('json'), true);
  assert.equal((await fetch(base + '/c/mcp/extra')).status, 404);
  assert.notEqual((await fetch(base + '/admin/deposit', { method: 'POST' })).status, 200, 'the manual credit endpoint is not the page');
  // links in chat answers use the plain addresses too
  const u = await user();
  const call = await chat(u.id);
  assert.match((await call('collections')).text, /http:\/\/localhost\/c\/mcp/);
  assert.doesNotMatch((await call('collections')).text, /#\//);
});

// the Netlify rules send the same pages to index.html
test('netlify.toml rewrites exactly the site pages to index.html, before the catch-all to the function', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const froms = [...toml.matchAll(/from = "([^"]+)"\s*\n\s*to = "\/index\.html"/g)].map((x) => x[1]);
  assert.deepEqual(froms.sort(), ['/a/*', '/admin', '/c/*', '/collections', '/connect', '/explorer', '/launch', '/lost-deposit', '/market', '/mint', '/nft/*', '/tokens', '/tx/*', '/u/*'].sort());
  assert.ok(toml.indexOf('to = "/index.html"') < toml.indexOf('to = "/.netlify/functions/api/:splat"'));
});

// a minimal ustar writer for the test above
function tarOf(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h[156] = '0'.charCodeAt(0);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

