// The $CREDIT airdrop, batch by batch (airdrop.js): the owner makes a batch of the oldest pending claims in /admin,
// sends it, pastes the signatures, marks it sent, sends failed wallets back to the queue; the Tokens page reads the
// feed (batches, the batch being sent, the queue) and one wallet's status; the CA is set once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { base58 } from '@scure/base';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open';
process.env.ADMIN_X_IDS = 'dev:adboss';
process.env.CREDIT_CLAIM_FEE = '0';
delete process.env.CREDIT_LAUNCH_AT;
delete process.env.CREDIT_BATCH_SIZE;
delete process.env.CREDIT_BATCH_MINUTES;
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { findRoot } = await import('../src/paths.js');
const { checkMoney, makeBackup, restoreBackup, TABLES } = await import('../src/backup.js');
const { migrate } = await import('../src/schema.js');
const credit = await import('../src/credit.js');
const ad = await import('../src/airdrop.js');
const m = await import('../src/market.js');

let db, app, server, base;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const wallet = () => base58.encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const sig = () => base58.encode(crypto.randomBytes(64));
let n = 0;
async function user() {
  const u = await m.upsertUser(db, { xId: `dev:ad${++n}`, handle: `ad${n}` });
  await m.ensurePublicIds(db);
  return u;
}
const nftsOf = async (u, k) => (await db.query(`update nfts set owner_id = $1, minted_at = now() where id in (
    select n.id from nfts n join collections c on c.id = n.collection_id where c.slug = 'mcp' and n.minted_at is null and n.rarity = 'Common'
    order by random() limit $2) returning id`, [u.id, k])).map((x) => Number(x.id));
// an account that burned k Common NFTs and claimed the $CREDIT (10,000 each) to w
async function claimer(w = wallet(), k = 1) {
  const u = await user();
  await credit.burn(db, u.id, await nftsOf(u, k));
  return { u, w, c: await credit.claim(db, u.id, { wallet: w }) };
}
async function browserAs(handle) {
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
  const raw = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: cookie(), ...(opts.headers || {}) } }).then(keep);
  const start = await raw('/login/site?return=%2Fadmin');
  const id = new URL(start.headers.get('location'), base).searchParams.get('req');
  await raw('/login/dev', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${id}&handle=${handle}` });
  const call = async (method, p, body) => {
    const r = await raw('/api' + p, { method, headers: { 'content-type': 'application/json', 'X-MCP-Site': '1', origin: 'http://localhost' }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json(), headers: r.headers }; };
// every claim still pending in no batch → sent, so each test starts with an empty queue
async function drain() {
  const [open] = await db.query("select id from credit_batches where status = 'sending'");
  if (open) await ad.cancelBatch(db, open.id);
  for (;;) {
    const [q] = await db.query("select count(*)::int as k from credit_claims where status = 'pending' and batch_id is null");
    if (!q.k) return;
    const b = await ad.makeBatch(db, 1000);
    await ad.markBatchSent(db, b.id, { sent: sig() });
  }
}

test('signatures and wallets from what the owner pastes', () => {
  const w = wallet();
  const s1 = sig();
  const s2 = sig();
  assert.ok(ad.isSignature(s1));
  assert.ok(!ad.isSignature(w));
  assert.ok(!ad.isSignature('x'.repeat(88)));
  const r = ad.parseSent(`https://solscan.io/tx/${s1}\n${w},20000,${s2},ok\n  \njunk line\n${s1}`);
  assert.deepEqual(r.txs, [s1, s2]);
  assert.equal(r.byWallet.get(w), s2);
  assert.deepEqual(ad.parseWallets(`${w}\n${w}, nope`), [w]);
});

test('batches: oldest first, one line per wallet, one open at a time; sent with signatures; failed wallets back in the queue', async () => {
  await drain();
  const shared = wallet();
  const a = await claimer(shared, 1);
  const b = await claimer(undefined, 2);
  const c = await claimer(undefined, 1);
  // the same wallet again (another account): its claims go together, at the place of its first one
  const a2 = await claimer(shared, 3);
  const b1 = await ad.makeBatch(db, 2);
  assert.equal(b1.wallets, 2);
  assert.deepEqual(b1.lines.map((l) => l.wallet), [shared, b.w]);
  assert.equal(b1.lines[0].amount, 40_000);
  assert.deepEqual(b1.lines[0].claims, [a.c.id, a2.c.id]);
  assert.equal(b1.text, `${shared},40000\n${b.w},20000`);
  await assert.rejects(ad.makeBatch(db, 5), /Batch #\d+ is still open/);
  // a claim in an open batch can't be voided; one in the queue can
  await assert.rejects(credit.voidClaim(db, a.c.id), /in an airdrop batch/);
  // the public feed: the batch being sent, the queue behind it
  let f = (await get('/api/credit/airdrop')).body;
  assert.equal(f.open.no, b1.no);
  assert.equal(f.open.wallets, 2);
  assert.deepEqual(f.queue.map((q) => q.wallet), [c.w]);
  assert.equal(f.queue[0].batch, b1.no + 1);
  let s = (await get(`/api/credit/airdrop/wallet/${shared}`)).body;
  assert.deepEqual([s.found, s.total, s.sending.batch, s.sending.amount, s.queued], [true, 40_000, b1.no, 40_000, null]);
  // sent: needs a signature; a wallet that failed goes back to the queue, ahead of newer claims
  await assert.rejects(ad.markBatchSent(db, b1.id, { sent: sig(), failed: `${shared}\n${b.w}` }), /cancel the batch/);
  const t1 = sig();
  const own = sig();
  const r = await ad.markBatchSent(db, b1.id, { sent: `https://solscan.io/tx/${t1}\n${shared},40000,${own}`, failed: b.w });
  assert.deepEqual([r.status, r.wallets, r.failed, r.added], ['sent', 1, 1, 2]);
  assert.deepEqual(r.txs, [t1, own]);
  f = (await get('/api/credit/airdrop')).body;
  assert.equal(f.open, null);
  assert.deepEqual(f.queue.map((q) => q.wallet), [b.w, c.w], 'the failed wallet keeps its place');
  assert.equal(f.recent[0].wallet, shared);
  assert.equal(f.recent[0].tx, own, "the wallet's own signature");
  assert.equal(f.batches[0].no, b1.no);
  assert.deepEqual(f.batches[0].txs, [t1, own]);
  s = (await get(`/api/credit/airdrop/wallet/${shared}`)).body;
  assert.deepEqual([s.sent, s.sent_batches[0].batch, s.sent_batches[0].tx, s.sending, s.queued], [40_000, b1.no, own, null, null]);
  s = (await get(`/api/credit/airdrop/wallet/${c.w}`)).body;
  assert.deepEqual([s.queued.pos, s.queued.batch, s.queued.amount], [2, b1.no + 1, 10_000]);
  assert.ok(new Date(s.queued.eta) > new Date(Date.now() + 4 * 60e3), 'about a batch interval after the last one');
  // more signatures later, and a wallet that turned out not to have got it
  const t2 = sig();
  const r2 = await ad.markBatchSent(db, b1.id, { sent: t2, failed: shared });
  assert.deepEqual([r2.wallets, r2.txs.length], [0, 3]);
  s = (await get(`/api/credit/airdrop/wallet/${shared}`)).body;
  assert.deepEqual([s.sent, s.queued.pos], [0, 1]);
  // cancel: an open batch only; its claims go back, its number is used again
  const b2 = await ad.makeBatch(db, 100);
  assert.equal(b2.no, b1.no + 1);
  assert.equal((await ad.cancelBatch(db, b2.id)).returned, 4);
  const b3 = await ad.makeBatch(db, 100);
  assert.equal(b3.no, b2.no);
  await assert.rejects(ad.cancelBatch(db, b1.id), /was sent/);
  // no signature pasted: sent all the same (the page links each wallet's Solscan page)
  const r3 = await ad.markBatchSent(db, b3.id, { sent: '' });
  assert.deepEqual([r3.status, r3.txs.length], ['sent', 0]);
  assert.ok((await checkMoney(db)).creditMatch);
  // a sent claim put back to pending in /admin leaves its batch
  await credit.markClaims(db, [c.c.id], 'pending');
  const [row] = await db.query('select batch_id, tx, status from credit_claims where id = $1', [c.c.id]);
  assert.deepEqual([row.batch_id, row.tx, row.status], [null, null, 'pending']);
  await drain();
});

test('the queue: place and batch estimate; a wallet nobody claimed; bad input', async () => {
  await drain();
  const xs = [];
  for (let i = 0; i < 5; i++) xs.push(await claimer());
  const b = await ad.makeBatch(db, 2);
  const f = (await get('/api/credit/airdrop')).body;
  assert.deepEqual(f.queue.map((q) => [q.pos, q.batch]), [[1, b.no + 1], [2, b.no + 1], [3, b.no + 2]]);
  assert.equal(f.pace.size, 2, 'the estimate goes by the last batch size');
  assert.equal(f.pace.next_no, b.no + 1);
  assert.ok(f.totals.queued_wallets >= 3);
  const none = (await get(`/api/credit/airdrop/wallet/${wallet()}`)).body;
  assert.deepEqual([none.found, none.total, none.queued, none.sending], [false, 0, null, null]);
  assert.equal((await get('/api/credit/airdrop/wallet/nope')).status, 400);
  // no account or handle in the public feed
  const text = JSON.stringify(f);
  for (const x of xs) assert.ok(!text.includes(x.u.public_id) && !text.includes(x.u.handle));
  await ad.cancelBatch(db, b.id);
  await drain();
});

test('admin: batches and the CA (set once) are the owner\'s; the Tokens page shows the CA', async () => {
  await drain();
  const boss = await browserAs('adboss');
  const nobody = await browserAs('adnobody');
  for (const [mth, p] of [['GET', '/admin/airdrop'], ['POST', '/admin/airdrop/batch'], ['POST', '/admin/airdrop/token']]) {
    assert.equal((await nobody.call(mth, p, mth === 'POST' ? {} : undefined)).status, 403, p);
  }
  await claimer();
  await claimer();
  const made = await boss.call('POST', '/admin/airdrop/batch', { size: 1 });
  assert.equal(made.status, 200);
  assert.equal(made.body.wallets, 1);
  assert.equal((await boss.call('POST', '/admin/airdrop/batch', { size: 1 })).status, 400);
  const list = await boss.call('GET', '/admin/airdrop');
  assert.equal(list.body.open.no, made.body.no);
  assert.equal(list.body.queue.wallets, 1);
  // a big report from a multisender fits
  const report = Array.from({ length: 1000 }, () => `${wallet()},10000,${sig()},success`).join('\n');
  const sent = await boss.call('POST', `/admin/airdrop/batch/${made.body.id}/sent`, { sent: `${report}\n${sig()}`, failed: '', next: 1 });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.unknown, 1000, 'lines for wallets of no batch are counted, not used');
  // the next batch is made right away, ready to copy
  assert.equal(sent.body.next.no, made.body.no + 1);
  const nx = (await boss.call('GET', '/admin/airdrop')).body.open;
  assert.equal(nx.no, made.body.no + 1);
  await boss.call('POST', `/admin/airdrop/batch/${nx.id}/sent`, { sent: '' });
  assert.equal((await boss.call('POST', `/admin/airdrop/batch/${made.body.id}/cancel`)).status, 400);
  // the CA: a Solana address, once
  let f = (await get('/api/credit/airdrop')).body;
  assert.deepEqual([f.token.ca, f.token.symbol, f.token.live], [null, '$CREDIT', false]);
  assert.equal((await boss.call('POST', '/admin/airdrop/token', { ca: 'not-an-address' })).status, 400);
  assert.equal((await boss.call('POST', '/admin/airdrop/token', { ca: wallet(), url: 'javascript:alert(1)' })).status, 400);
  const ca = `${wallet()}`;
  const set = await boss.call('POST', '/admin/airdrop/token', { ca });
  assert.equal(set.status, 200);
  assert.equal(set.body.url, `https://pump.fun/coin/${ca}`);
  const again = await boss.call('POST', '/admin/airdrop/token', { ca: wallet() });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already set/);
  f = (await get('/api/credit/airdrop')).body;
  assert.deepEqual([f.token.ca, f.token.url, f.token.live], [ca, `https://pump.fun/coin/${ca}`, true]);
  // the feed is cached by the CDN for a moment, never by the browser
  const h = (await get('/api/credit/airdrop')).headers;
  assert.match(h.get('netlify-cdn-cache-control'), /s-maxage=3/);
  assert.match(h.get('cache-control'), /max-age=0/);
  // the site has the page and the admin section
  const root = findRoot();
  const html = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  assert.match(html, /\/api\/credit\/airdrop/);
  assert.match(fs.readFileSync(path.join(root, 'site', 'launch.js'), 'utf8'), /\/admin\/airdrop\/batch/);
  await db.query("delete from app_meta where key = 'credit_token'");
  await drain();
});

test('backups carry the batches; a restore keeps them and the numbers go on', async () => {
  assert.ok(Object.keys(TABLES).indexOf('credit_batches') < Object.keys(TABLES).indexOf('credit_claims'));
  await claimer();
  const b = await ad.makeBatch(db, 10);
  await ad.markBatchSent(db, b.id, { sent: sig() });
  const { data: buf } = await makeBackup(db);
  const fresh = await openDb({ url: '' });
  try {
    await migrate(fresh);
    const r = await restoreBackup(fresh, buf);
    assert.ok(r.check.creditMatch);
    assert.equal(r.counts.credit_batches, Number((await db.query('select count(*) as k from credit_batches'))[0].k));
    const [x] = await fresh.query('select status, cardinality(txs) as k from credit_batches where no = $1', [b.no]);
    assert.deepEqual([x.status, Number(x.k)], ['sent', 1]);
    const [{ id }] = await fresh.query("insert into credit_batches (no) values (100000) returning id");
    assert.ok(Number(id) > b.id);
  } finally {
    await fresh.close();
  }
});
