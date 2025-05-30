// Races on real Postgres: trading, minting, uploads and the owner's actions running at the same moment.
// PGlite has one connection, so these only run with TEST_DATABASE_URL (a Postgres database), for example:
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/races node --test server/test/races.test.js
// Each step can be held at one statement (gated) to force the worst interleaving.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
const URL = process.env.TEST_DATABASE_URL;
const { openDb } = await import('../src/db.js');
const m = await import('../src/market.js');
const lp = await import('../src/launchpad.js');
const { memoryStorage, sniffImage } = await import('../src/storage.js');

const opts = { skip: URL ? false : 'needs TEST_DATABASE_URL (PGlite runs one connection at a time)' };
const run = Math.random().toString(36).slice(2, 7); // names unique per run, so a database can be reused
let db, creator;
before(async () => {
  if (!URL) return;
  db = await openDb({ url: URL });
  creator = await user('creator');
});
after(async () => { await db?.close(); });

// a database whose transactions stop right after the first statement matching re, until released
function gated(re) {
  let release; const gate = new Promise((r) => (release = r));
  let reached; const at = new Promise((r) => (reached = r));
  let hit = false;
  return { release, at, db: { ...db, tx: (fn) => db.tx((t) => fn({ ...t, query: async (q, p) => {
    const r = await t.query(q, p);
    if (!hit && re.test(q)) { hit = true; reached(); await gate; }
    return r;
  } })) } };
}
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const pending = async (p) => { const s = Symbol('pending'); return (await Promise.race([p, new Promise((r) => setTimeout(() => r(s), 400))])) === s; };
const bal = async (id) => Number((await db.query('select balance from users where id = $1', [id]))[0].balance);
async function user(h, money) {
  const u = await m.upsertUser(db, { xId: `dev:${h}-${run}`, handle: `${h}-${run}` });
  if (money) await m.credit(db, u.id, money, 'deposit', `seed ${h}-${run}`);
  return u;
}
async function liveCollection(slug, creatorId) {
  const [c] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
    values ($1, $1, $2, 1, 2000000, 5, 1000, 'live', 7) returning id`, [slug, creatorId]);
  const [n] = await db.query("insert into nfts (id, name, collection_id, edition) values (nextval('nft_ids'), $2, $1, 1) returning id", [c.id, `${slug} #1`]);
  return { cid: c.id, nftId: n.id };
}
const ledgerOk = async () => {
  const [r] = await db.query(`select (select coalesce(sum(delta),0) from ledger where user_id is not null)::bigint l, (select coalesce(sum(balance),0) from users)::bigint b`);
  return r.l === r.b;
};
const refundTo = async (nftId) => (await db.query("select user_id from ledger where kind = 'mint_refund' and ref = $1", [String(nftId)])).map((r) => r.user_id);
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n - 8)]);

test('list and buy started while a freeze is in progress wait for it, then see the freeze', opts, async () => {
  const alt = await user('alt1', 10e6); const victim = await user('victim1', 10e6);
  const { cid, nftId } = await liveCollection('frogs-' + run, creator.id);
  await m.mint(db, alt.id, { collection: 'frogs-' + run });
  const F = gated(/update nfts set price = null/);
  const pf = settle(lp.freeze(F.db, cid, 'scam'));
  await F.at;
  const pl = settle(m.list(db, alt.id, nftId, 7e6));
  const pb = settle(m.buy(db, victim.id, nftId, 7e6));
  assert.ok(await pending(pl), 'list waits for the freeze');
  assert.ok(await pending(pb), 'buy waits for the freeze');
  F.release();
  assert.ok((await pf).ok);
  const [l, b] = [await pl, await pb];
  assert.match(l.e.message, /frozen/);
  assert.match(b.e.message, /frozen/);
  assert.equal(await bal(victim.id), 10e6);
  assert.deepEqual(await refundTo(nftId), [alt.id]);
  assert.equal(await bal(alt.id), 10e6, 'alt got the mint back');
  const [n] = await db.query('select price from nfts where id = $1', [nftId]);
  assert.equal(n.price, null, 'nothing listed in a frozen collection');
  assert.ok(await ledgerOk());
});

test('a sale in progress when the freeze starts: the freeze waits, then refunds the buyer', opts, async () => {
  const alt = await user('alt2', 10e6); const victim = await user('victim2', 10e6);
  const { cid, nftId } = await liveCollection('toads-' + run, creator.id);
  await m.mint(db, alt.id, { collection: 'toads-' + run });
  await m.list(db, alt.id, nftId, 7e6);
  const B = gated(/for share/);
  const pb = settle(m.buy(B.db, victim.id, nftId, 7e6));
  await B.at;
  const pf = settle(lp.freeze(db, cid, 'scam'));
  assert.ok(await pending(pf), 'the freeze waits for the sale');
  B.release();
  assert.ok((await pb).ok);
  const f = await pf;
  assert.ok(f.ok, f.e?.message);
  assert.deepEqual(await refundTo(nftId), [victim.id], 'the buyer, who holds it now, gets the refund');
  assert.equal(await bal(victim.id), 3e6 + 2e6);
  assert.ok(await ledgerOk());
});

test('parallel uploads can\'t pass the quota together', opts, async () => {
  const [c] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
    values ('quota-' || $2, 'quota', $1, 100, 1000000, 1, 1000, 'draft', 7) returning *`, [creator.id, run]);
  const img = png(1000);
  const keep = lp.LAUNCH.maxBytes;
  lp.LAUNCH.maxBytes = 2500;
  const storage = memoryStorage();
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map((e) => lp.addItems(db, storage, sniffImage, creator.id, c.id, [{ edition: e, image: img, thumb: img }])));
  lp.LAUNCH.maxBytes = keep;
  const [{ bytes }] = await db.query('select bytes from collections where id = $1', [c.id]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(Number(bytes), 2000);
  assert.equal(storage.size(), 2, 'refused batches wrote nothing');
});

test('an upload in progress holds off a submit; an upload after the submit writes nothing', opts, async () => {
  const [c] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
    values ('race-sub-' || $2, 'race-sub', $1, 1, 1000000, 1, 1000, 'draft', 7) returning *`, [creator.id, run]);
  const img = png(100);
  const storage = memoryStorage();
  const U = gated(/for share/);
  const pu = settle(lp.addItems(U.db, storage, sniffImage, creator.id, c.id, [{ edition: 1, image: img, thumb: img }]));
  await U.at;
  const ps = settle(lp.submit(db, creator.id, c.id));
  assert.ok(await pending(ps), 'the submit waits for the upload');
  U.release();
  assert.ok((await pu).ok);
  const s = await ps;
  assert.ok(s.ok, s.e?.message);
  const before = storage.size();
  const late = await settle(lp.addItems(db, storage, sniffImage, creator.id, c.id, [{ edition: 1, image: img, thumb: img }]));
  assert.match(late.e.message, /in review/);
  assert.equal(storage.size(), before);
  const [{ bytes }] = await db.query('select bytes from collections where id = $1', [c.id]);
  assert.equal(Number(bytes), 200, 'a refused upload gives its bytes back');
});

test('a PATCH racing a submit can\'t change the terms after the submit checked them', opts, async () => {
  const [c] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
    values ('race-patch-' || $2, 'race-patch', $1, 1, 1000000, 1, 1000, 'draft', 7) returning *`, [creator.id, run]);
  await db.query("insert into nfts (id, name, collection_id, edition) values (nextval('nft_ids'), 'x', $1, 1)", [c.id]);
  const S = gated(/count\(\*\)::int as n, min\(edition\)/);
  const ps = settle(lp.submit(S.db, creator.id, c.id));
  await S.at;
  const pp = settle(lp.updateDraft(db, creator.id, c.id, { supply: 50 }));
  assert.ok(await pending(pp), 'the change waits for the submit');
  S.release();
  assert.ok((await ps).ok);
  assert.match((await pp).e.message, /in review/);
  const [row] = await db.query('select supply, status from collections where id = $1', [c.id]);
  assert.deepEqual([row.supply, row.status], [1, 'review']);
});

test('mints and a freeze in parallel: every mint either refunded or refused, money adds up', opts, async () => {
  const { cid } = await (async () => {
    const [c] = await db.query(`insert into collections (slug, name, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
      values ('busy-' || $2, 'busy', $1, 40, 2000000, 5, 1000, 'live', 7) returning id`, [creator.id, run]);
    for (let e = 1; e <= 40; e++) await db.query("insert into nfts (id, name, collection_id, edition) values (nextval('nft_ids'), 'b', $1, $2)", [c.id, e]);
    return { cid: c.id };
  })();
  const fans = [];
  for (let i = 0; i < 8; i++) fans.push(await user(`fan6_${i}`, 20e6));
  const jobs = [];
  for (const f of fans) for (let k = 0; k < 4; k++) jobs.push(settle(m.mint(db, f.id, { collection: 'busy-' + run })));
  jobs.splice(10, 0, settle(lp.freeze(db, cid, 'scam')));
  const out = await Promise.all(jobs);
  const deadlocks = out.filter((o) => !o.ok && /deadlock/.test(o.e.message));
  assert.equal(deadlocks.length, 0);
  for (const f of fans) assert.equal(await bal(f.id), 20e6, 'every fan whole again');
  const [{ open }] = await db.query('select count(*)::int as open from mint_holds where collection_id = $1 and refunded_at is null', [cid]);
  assert.equal(open, 0);
  assert.ok(await ledgerOk());
});
