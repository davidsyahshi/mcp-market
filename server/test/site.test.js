// The site's market and explorer filters, and lost deposit reports (/lost-deposit → /admin).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open'; // these tests trade MCP NFTs long before 5,000 are minted
process.env.ADMIN_X_IDS = 'dev:boss';
const { openDb } = await import('../src/db.js');
const { createApp, SITE_PAGES } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { TX_TYPES } = await import('../src/explorer.js');
const claims = await import('../src/claims.js');
const m = await import('../src/market.js');

let db, app, server, base;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const sig = () => [...crypto.randomBytes(88)].map((b) => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[b % 58]).join('');
const sol = () => [...crypto.randomBytes(44)].map((b) => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[b % 58]).join('');
let n = 0;
async function user(handle = `s${++n}`, dollars = 50) {
  const u = await m.upsertUser(db, { xId: `dev:${handle}`, handle });
  if (dollars) await m.credit(db, u.id, dollars * 1e6, 'deposit', `USDC ${sig()} ${sol()}`);
  return u;
}

// a signed-in browser on the site (test sign-in), cookies kept by hand
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
  const start = await raw('/login/site?return=%2Fadmin');
  const id = new URL(start.headers.get('location'), base).searchParams.get('req');
  await raw('/login/dev', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${id}&handle=${handle}` });
  const call = async (method, path, body, headers = {}) => {
    const r = await raw('/api' + path, { method, headers: { 'content-type': 'application/json', 'X-MCP-Site': '1', origin: 'http://localhost', ...headers }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
// the public form, not signed in, from some address
const report = (body, { ip = '203.0.113.7', headers = {} } = {}) => fetch(base + '/api/deposit-claims', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-MCP-Site': '1', origin: 'http://localhost', 'x-nf-client-connection-ip': ip, ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('site pages: the mint page and the lost deposit form have their own addresses', () => {
  for (const p of ['/mint', '/lost-deposit', '/market', '/explorer']) assert.ok(SITE_PAGES.test(p), p);
  assert.ok(!SITE_PAGES.test('/lost-depositx'));
});

test('explorer: filter transactions by type, on the whole market and on an account (bought vs sold)', async () => {
  const a = await user();
  const b = await user();
  const [x, y] = (await m.teamMint(db, a.id, 2)).minted.map((t) => t.id);
  await m.mint(db, b.id);
  await m.list(db, a.id, x, 3_000_000);
  await m.buy(db, b.id, x, 3_000_000);
  // a transfer through the form path (no preview code needed there)
  await m.sendNftsFromForm(db, a.id, [{ nft_id: y, to: b.public_id }]);
  const kinds = (t) => t.entries.map((e) => e.kind);
  const all = (await get('/api/explorer/txs?limit=100')).body;
  for (const [type, want] of [['mint', ['mint', 'team mint', 'free mint']], ['buy', ['buy']], ['sell', ['buy']], ['transfer', ['transfer']], ['deposit', ['deposit']]]) {
    const r = await get(`/api/explorer/txs?type=${type}&limit=100`);
    assert.equal(r.status, 200, type);
    assert.ok(r.body.length, `${type}: some`);
    assert.ok(r.body.every((t) => want.includes(t.type)), `${type}: only ${want}`);
    assert.ok(r.body.every((t) => kinds(t).some((k) => TX_TYPES[type].includes(k))));
    assert.ok(r.body.length < all.length, `${type}: fewer than all`);
  }
  // on an account: what it bought is not what it sold
  const bought = (await get(`/api/explorer/txs?addr=${b.public_id}&type=buy`)).body;
  const sold = (await get(`/api/explorer/txs?addr=${b.public_id}&type=sell`)).body;
  assert.equal(bought.length, 1);
  assert.equal(bought[0].nft.id, x);
  assert.equal(sold.length, 0);
  assert.equal((await get(`/api/explorer/txs?addr=${a.public_id}&type=sell`)).body.length, 1);
  assert.equal((await get(`/api/explorer/txs?addr=${a.public_id}&type=buy`)).body.length, 0);
  assert.equal((await get(`/api/explorer/txs?addr=${b.public_id}&type=transfer`)).body.length, 1, 'received counts as a transfer');
  // paging with a filter goes back in time without repeats
  const first = (await get('/api/explorer/txs?type=deposit&limit=1')).body;
  const next = (await get(`/api/explorer/txs?type=deposit&limit=1&before=${first[0].id}`)).body;
  assert.ok(next[0].id < first[0].id);
  assert.equal((await get('/api/explorer/txs?type=nope')).status, 400);
});

test('lost deposit form: checks the fields, takes a Solscan link, one report per transaction', async () => {
  const s1 = sig();
  const to = sol();
  const from = sol();
  for (const [body, why] of [
    [{ deposit_address: 'mcp_6U7CAxR4VDea', from_wallet: from, tx: s1 }, /MCP deposit address/],
    [{ deposit_address: to, from_wallet: 'nope', tx: s1 }, /Your wallet/],
    [{ deposit_address: to, from_wallet: to, tx: s1 }, /same address/],
    [{ deposit_address: to, from_wallet: from, tx: 'https://example.com/whatever' }, /Transaction/],
  ]) {
    const r = await report(body);
    assert.equal(r.status, 400);
    assert.match(r.body.error, why);
  }
  const r = await report({ deposit_address: to, from_wallet: from, tx: `https://solscan.io/tx/${s1}?cluster=mainnet` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.duplicate, false);
  const [row] = await db.query('select * from deposit_claims where id = $1', [r.body.id]);
  assert.equal(row.tx, s1, 'the signature, taken out of the link');
  assert.equal(row.status, 'new');
  assert.notEqual(row.ip_hash, '203.0.113.7', 'the IP address itself is not kept');
  const again = await report({ deposit_address: to, from_wallet: from, tx: s1 }, { ip: '198.51.100.9' });
  assert.equal(again.body.id, r.body.id);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.status, undefined, 'nothing about how a report is going');
  // the same transaction with another deposit address is a report of its own: nobody blocks a real one by filing first
  const other = await report({ deposit_address: sol(), from_wallet: from, tx: s1 }, { ip: '198.51.100.10' });
  assert.equal(other.status, 200);
  assert.equal(other.body.duplicate, false);
  assert.notEqual(other.body.id, r.body.id);
  // the site's header is needed
  const noHeader = await report({ deposit_address: to, from_wallet: from, tx: sig() }, { headers: { 'X-MCP-Site': '' } });
  assert.equal(noHeader.status, 403);
  // only from the site itself
  const evil = await report({ deposit_address: to, from_wallet: from, tx: sig() }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('lost deposit form: a few reports an hour from one address', async () => {
  const ip = '192.0.2.44';
  for (let i = 0; i < claims.CLAIMS_PER_HOUR; i++) assert.equal((await report({ deposit_address: sol(), from_wallet: sol(), tx: sig() }, { ip })).status, 200);
  const r = await report({ deposit_address: sol(), from_wallet: sol(), tx: sig() }, { ip });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Too many reports/);
  assert.equal((await report({ deposit_address: sol(), from_wallet: sol(), tx: sig() }, { ip: '192.0.2.45' })).status, 200, 'another address is fine');
  // IPv6: one /64 is one sender
  assert.equal(claims.ipHash('2001:db8:1:2::5'), claims.ipHash('2001:db8:1:2:abcd::9'));
  assert.notEqual(claims.ipHash('2001:db8:1:2::5'), claims.ipHash('2001:db8:1:3::5'));
});

test('admin: lost deposits with whose address it is and whether it was credited; done / rejected / note', async () => {
  const owner = await user('depowner', 0);
  const addr = sol();
  await db.query("insert into deposit_pool (network, idx, address, mac, user_id, assigned_at) values ('mainnet', 777, $1, 'x', $2, now())", [addr, owner.id]);
  const credited = sig();
  await db.query("insert into deposits (user_id, signature, token, token_account, amount, status) values ($1, $2, 'USDC', $3, 25000000, 'credited')", [owner.id, credited, sol()]);
  const missing = sig();
  const byHand = sig();
  await m.credit(db, owner.id, 10e6, 'deposit', `manual ${byHand}`);
  const c1 = (await report({ deposit_address: addr, from_wallet: sol(), tx: credited }, { ip: '10.0.0.1' })).body;
  const c2 = (await report({ deposit_address: addr, from_wallet: sol(), tx: missing }, { ip: '10.0.0.1' })).body;
  const c3 = (await report({ deposit_address: sol(), from_wallet: sol(), tx: sig() }, { ip: '10.0.0.1' })).body;
  const c4 = (await report({ deposit_address: addr, from_wallet: sol(), tx: byHand }, { ip: '10.0.0.2' })).body;
  const c5 = (await report({ deposit_address: sol(), from_wallet: sol(), tx: missing }, { ip: '10.0.0.3' })).body; // someone else claims it
  const boss = await browser('boss');
  const list = (await boss.call('GET', '/admin/deposit-claims?status=new')).body;
  const by = (id) => list.find((c) => c.id === id);
  assert.equal(by(c1.id).check.address, 'ours');
  assert.equal(by(c1.id).check.owner.addr, owner.public_id);
  assert.equal(by(c1.id).check.credited, true);
  assert.deepEqual(by(c1.id).check.deposits.map((d) => [d.status, d.amount, d.token]), [['credited', 25, 'USDC']]);
  assert.equal(by(c2.id).check.credited, false);
  assert.equal(by(c2.id).check.deposits.length, 0);
  assert.equal(by(c3.id).check.address, 'not ours');
  assert.equal(by(c4.id).check.credited, true);
  assert.equal(by(c4.id).check.manual, true);
  assert.equal(by(c2.id).check.other_addresses, 1, 'flagged: the same transaction with another address');
  assert.equal(by(c5.id).check.other_addresses, 1);
  assert.equal(by(c1.id).check.other_addresses, 0);
  // statuses
  assert.equal((await boss.call('POST', `/admin/deposit-claims/${c1.id}`, { status: 'done', note: 'already credited automatically' })).body.status, 'done');
  assert.equal((await boss.call('POST', `/admin/deposit-claims/${c3.id}`, { status: 'rejected' })).body.status, 'rejected');
  assert.equal((await boss.call('POST', `/admin/deposit-claims/${c2.id}`, { note: 'asked on X' })).body.note, 'asked on X');
  assert.equal((await boss.call('POST', `/admin/deposit-claims/${c2.id}`, { status: 'maybe' })).status, 400);
  const fresh = (await boss.call('GET', '/admin/deposit-claims?status=new')).body.map((c) => c.id);
  assert.ok(fresh.includes(c2.id) && !fresh.includes(c1.id) && !fresh.includes(c3.id));
  const everything = (await boss.call('GET', '/admin/deposit-claims')).body;
  assert.equal(everything.find((c) => c.id === c1.id).note, 'already credited automatically');
  // nobody else sees them
  const fan = await browser('fan');
  assert.equal((await fan.call('GET', '/admin/deposit-claims')).status, 403);
  assert.equal((await fetch(base + '/api/admin/deposit-claims')).status, 401);
});

test('a signed-in reporter is attached to the report', async () => {
  const me = await browser('reporter');
  const r = await me.call('POST', '/deposit-claims', { deposit_address: sol(), from_wallet: sol(), tx: sig() }, { 'x-nf-client-connection-ip': '10.9.9.9' });
  assert.equal(r.status, 200);
  const [row] = await db.query('select u.handle from deposit_claims c join users u on u.id = c.user_id where c.id = $1', [r.body.id]);
  assert.equal(row.handle, 'reporter');
});
