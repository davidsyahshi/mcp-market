// Database backups: a copy of every table that matters, kept in Netlify Blobs, downloaded from /admin, and
// loaded into a new database by scripts/restore-backup.js with the money checked (balances and hash chain).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open';
process.env.ADMIN_X_IDS = 'dev:boss';
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { createExplorer } = await import('../src/explorer.js');
const { memoryStorage, memoryBackupStore } = await import('../src/storage.js');
const bk = await import('../src/backup.js');
const m = await import('../src/market.js');

let db, app, server, base, explorer, store;
before(async () => {
  db = await openDb({ url: '' });
  store = memoryBackupStore();
  ({ app, explorer } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage(), backupStore: store }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

// a market with a bit of everything: deposits, mints, a sale, a launchpad mint held in escrow, a withdrawal, an anchor
async function fill() {
  const [a, b, c] = [await m.upsertUser(db, { xId: 'dev:ann', handle: 'ann' }), await m.upsertUser(db, { xId: 'dev:bob', handle: 'bob' }),
    await m.upsertUser(db, { xId: 'dev:cid', handle: 'cid' })];
  await m.credit(db, a.id, 50e6, 'deposit', 'sig-ann');
  await m.credit(db, b.id, 30e6, 'deposit', 'sig-bob');
  const n1 = await m.mint(db, a.id, {});
  await m.mint(db, a.id, {});
  await m.list(db, a.id, n1.id, 12e6);
  await m.buy(db, b.id, n1.id, 12e6);
  const [col] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
    values ('duo', 'Duo', $1, 2, 3000000, 2, 1000, 'live', 7) returning id`, [c.id]);
  for (const e of [1, 2]) await db.query("insert into nfts (id, name, collection_id, edition, attributes) values (nextval('nft_ids'), $2, $1, $3, $4)", [col.id, `Duo #${e}`, e, JSON.stringify([{ trait_type: 'Hat', value: 'Red' }])]);
  await m.mint(db, b.id, { collection: 'duo' });
  await db.query("insert into withdrawals (user_id, amount, address, status, network) values ($1, 5000000, 'So1aNaAddre55', 'sent', 'devnet')", [a.id]);
  await db.query("insert into deposit_pool (network, idx, address, mac, user_id, assigned_at) values ('devnet', 0, 'PoolAddr0', 'mac0', $1, now()), ('devnet', 1, 'PoolAddr1', 'mac1', null, null)", [a.id]);
  await explorer.seal();
  const [head] = await db.query('select seq, hash from ledger where seq is not null order by seq desc limit 1');
  await db.query("insert into chain_anchors (network, seq, hash, signature, status) values ('devnet', $1, $2, 'anchor-sig-1', 'finalized')", [head.seq, head.hash]);
  await db.query(`insert into app_meta (key, value) values ('helius_webhook', '{"id":"wh-1"}')`);
  // one more row after the seal: a backup also carries rows not sealed yet
  await m.credit(db, c.id, 1e6, 'deposit', 'sig-cid');
}

const dump = async (d, table, order) => d.query(`select to_jsonb(x)::text as r from ${table} x order by ${order}`).then((rows) => rows.map((r) => r.r));

test('a backup is one gzipped file with every table, and a restore brings back exactly the same rows', async () => {
  await fill();
  const status = await bk.runBackup(db, store, { now: new Date('2026-10-28T12:17:00Z'), log: {} });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.key, 'b/2026-10-28T12-17-00Z.json.gz');
  assert.deepEqual(await store.list(), [status.key]);
  assert.equal(status.counts.users, 3);
  assert.ok(status.counts.ledger > 10);
  assert.equal((await bk.lastBackup(db)).key, status.key);

  const file = await store.get(status.key);
  const doc = JSON.parse(zlib.gunzipSync(file).toString());
  assert.equal(doc.format, 'mcp-backup');
  assert.deepEqual(Object.keys(doc.tables), Object.keys(bk.TABLES));
  assert.equal(doc.tables.site_sessions, undefined, 'sign-in sessions are not kept');

  const fresh = await openDb({ url: '' });
  try {
    const out = await bk.restoreBackup(fresh, file);
    assert.deepEqual(out.check, { balancesMatch: true, balancesOff: 0, chainOk: true, sealed: out.check.sealed, brokenAt: null });
    assert.ok(out.check.sealed > 10);
    // row for row, to the microsecond
    for (const [table, order] of Object.entries(bk.TABLES)) {
      if (table === 'app_meta') continue;
      assert.deepEqual(await dump(fresh, table, order), await dump(db, table, order), table);
    }
    const meta = Object.fromEntries((await fresh.query('select key, value from app_meta')).map((r) => [r.key, r.value]));
    assert.equal(meta.helius_webhook, '{"id":"wh-1"}', 'the market\'s own notes come back');
    assert.ok(meta.schema, 'the new database keeps its own schema mark');
    // the counters carry on: new rows get new ids, and the chain continues from the restored head
    const d = await m.upsertUser(fresh, { xId: 'dev:dan', handle: 'dan' });
    const [{ max }] = await db.query('select max(id) as max from users');
    assert.equal(d.id, Number(max) + 1);
    await m.credit(fresh, d.id, 2e6, 'deposit', 'sig-dan');
    const [{ id: nid }] = await fresh.query("select nextval('nft_ids') as id");
    const [{ top }] = await db.query('select max(id) as top from nfts');
    assert.ok(Number(nid) > Number(top));
    await createExplorer(fresh, {}).seal();
    assert.equal((await bk.checkMoney(fresh)).chainOk, true);
    // never over a database that has data
    await assert.rejects(bk.restoreBackup(fresh, file), /not empty/);
  } finally {
    await fresh.close();
  }
});

test('a changed amount in a backup is caught by the money check after the restore', async () => {
  const doc = JSON.parse(zlib.gunzipSync(await store.get((await store.list())[0])).toString());
  const row = doc.tables.ledger.find((r) => r.kind === 'deposit');
  row.delta = Number(row.delta) + 1e6;
  const tampered = zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
  const fresh = await openDb({ url: '' });
  try {
    const out = await bk.restoreBackup(fresh, tampered);
    assert.equal(out.check.balancesMatch, false);
    assert.equal(out.check.chainOk, false);
  } finally {
    await fresh.close();
  }
  await assert.rejects(async () => bk.readBackup(zlib.gzipSync(Buffer.from('{"hello":1}'))), /not an MCP backup/);
  await assert.rejects(async () => bk.readBackup(Buffer.from('plain text')), /not a backup file/);
});

test('kept: everything from the last 48 hours, then the first copy of each day for 30 days', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const keys = [];
  for (let h = 0; h < 40 * 24; h += 2) keys.push(bk.backupKey(now - h * 3600e3 - 17 * 60e3));
  const doomed = new Set(bk.toDelete(keys, now));
  const kept = keys.filter((k) => !doomed.has(k));
  assert.ok(kept.filter((k) => now - bk.keyTime(k) <= 48 * 3600e3).length === 24, 'all 24 copies of the last 2 days');
  const older = kept.filter((k) => now - bk.keyTime(k) > 48 * 3600e3);
  const days = older.map((k) => k.slice(2, 12));
  assert.equal(new Set(days).size, days.length, 'one per day');
  assert.ok(older.every((k) => now - bk.keyTime(k) <= 30 * 86400e3), 'nothing older than 30 days');
  assert.ok(older.length >= 27 && older.length <= 29);
  assert.ok(older.every((k) => k.slice(13, 15) === '00' || k.slice(13, 15) === '01'), 'the first copy of its day');
  assert.deepEqual(bk.toDelete(['b/whatever', 'notes.txt'], now), [], 'other names are never touched');
});

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
  const raw = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } }).then(keep);
  const start = await raw('/login/site?return=%2Fadmin');
  const id = new URL(start.headers.get('location'), base).searchParams.get('req');
  await raw('/login/dev', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${id}&handle=${handle}` });
  return raw;
}

test('/admin: only the owner lists, makes and downloads backups', async () => {
  const site = { 'X-MCP-Site': '1', origin: 'http://localhost', 'content-type': 'application/json' };
  const stranger = await browser('nosy');
  assert.equal((await stranger('/api/admin/backups')).status, 403);
  assert.equal((await stranger('/api/admin/backups/file?key=' + encodeURIComponent((await store.list())[0]))).status, 403);
  assert.equal((await fetch(base + '/api/admin/backups')).status, 401);
  const boss = await browser('boss');
  assert.equal((await boss('/api/admin/backups', { method: 'POST' })).status, 403, 'a change needs the site header');
  const made = await (await boss('/api/admin/backups', { method: 'POST', headers: site, body: '{}' })).json();
  assert.equal(made.ok, true);
  const list = await (await boss('/api/admin/backups')).json();
  assert.equal(list.last.key, made.key);
  assert.equal(list.items[0].key, made.key, 'newest first');
  const r = await boss('/api/admin/backups/file?key=' + encodeURIComponent(made.key));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/gzip');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="mcp-backup-.*\.json\.gz"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(bk.readBackup(Buffer.from(await r.arrayBuffer())).format, 'mcp-backup');
  for (const bad of ['../etc/passwd', 'b/../../x.json.gz', 'b/2026-10-28T12-17-00Z.json']) {
    assert.equal((await boss('/api/admin/backups/file?key=' + encodeURIComponent(bad))).status, 400, bad);
  }
  assert.equal((await boss('/api/admin/backups/file?key=' + encodeURIComponent('b/2020-01-01T00-00-00Z.json.gz'))).status, 404);
});

test('a failed backup is noted for /admin and logged as an ALERT, and nothing is stored', async () => {
  const broken = { ...memoryBackupStore(), put: async () => { throw new Error('blobs are down'); } };
  const lines = [];
  const status = await bk.runBackup(db, broken, { log: { error: (l) => lines.push(l) } });
  assert.equal(status.ok, false);
  assert.match(status.error, /blobs are down/);
  assert.match(lines[0], /^ALERT backup failed/);
  assert.equal((await bk.lastBackup(db)).ok, false);
});
