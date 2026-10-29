// Launch features: the owner's free team mint (/admin) and the mint page's live feed (/api/mint/*).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
process.env.ADMIN_X_IDS = 'dev:chief';
const { openDb } = await import('../src/db.js');
const { createApp, SITE_PAGES } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { entryHash, GENESIS } = await import('../src/explorer.js');
const m = await import('../src/market.js');

let db, app, server, base, explorer;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app, explorer } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

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
  const call = async (method, path, body) => {
    const r = await raw('/api' + path, { method, headers: { 'content-type': 'application/json', 'X-MCP-Site': '1', origin: 'http://localhost' }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const me = (await call('GET', '/me')).body;
  return { call, me };
}
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: await r.json() }; };
const ledgerMatches = async () => {
  const bad = await db.query(`select u.handle from users u left join (select user_id, sum(delta) s from ledger group by user_id) l on l.user_id = u.id
    where u.balance <> coalesce(l.s, 0)`);
  assert.deepEqual(bad, []);
};

test('team mint: owner only, free, random, outside the mint limit, public as "team mint"', async () => {
  const boss = await browser('chief');
  const fan = await browser('fan');
  assert.equal(boss.me.admin, true);
  assert.equal((await fan.call('POST', '/admin/team-mint', { count: 3 })).status, 403, 'not the owner');

  for (const bad of [{ count: 0 }, { count: 501 }, { count: 2.5 }, { count: 'ten' }, {}, { count: 1, to: 'mcp_nope' }, { count: 1, to: 'mcp_111111111111' }]) {
    const r = await boss.call('POST', '/admin/team-mint', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await db.query('select count(*)::int as n from nfts where minted_at is not null'))[0].n, 0, 'nothing minted by the refusals');

  const r = await boss.call('POST', '/admin/team-mint', { count: 120 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.minted.length, 120);
  assert.equal(new Set(r.body.minted.map((x) => x.id)).size, 120);
  assert.equal(r.body.to, boss.me.public_id);
  assert.equal(r.body.left, 5000 - 120);
  const [u] = await db.query("select id, balance from users where handle = 'chief'");
  assert.equal(Number(u.balance), 0, 'free');
  const owned = await db.query('select count(*)::int as n, count(minted_by)::int as by from nfts where owner_id = $1', [u.id]);
  assert.deepEqual([owned[0].n, owned[0].by], [120, 0], 'owned, and not counted against the mint limit');

  // the owner can still mint the usual 5 with money
  await m.credit(db, u.id, 50e6, 'deposit', 'seed chief');
  for (let i = 0; i < 5; i++) await m.mint(db, u.id);
  await assert.rejects(m.mint(db, u.id), /Mint limit reached/);

  // to someone else's MCP address, for a giveaway
  const gift = await boss.call('POST', '/admin/team-mint', { count: 2, to: fan.me.public_id });
  assert.equal(gift.body.to, fan.me.public_id);
  const [f] = await db.query("select id from users where handle = 'fan'");
  assert.equal((await db.query('select count(*)::int as n from nfts where owner_id = $1', [f.id]))[0].n, 2);

  // the explorer: chunks of 50 per transaction, each "team mint" to the owner's address, the chain still checks out
  await ledgerMatches();
  await explorer.seal();
  const txs = await get('/api/explorer/txs?limit=100');
  const team = txs.body.filter((t) => t.type === 'team mint');
  assert.deepEqual(team.map((t) => t.team.count).sort((a, b) => a - b), [2, 20, 50, 50]);
  assert.ok(team.filter((t) => t.team.count > 2).every((t) => t.team.account === boss.me.public_id && t.nft?.id));
  assert.ok(team.every((t) => t.entries.every((e) => e.amount === 0)));
  const chain = (await get('/api/explorer/chain')).body;
  let prev = GENESIS;
  for (const e of chain) { assert.equal(entryHash(prev, e), e.hash, `entry ${e.seq}`); prev = e.hash; }

  // the NFT's own page says so
  const one = (await get(`/api/nfts/${r.body.minted[0].id}`)).body;
  assert.equal(one.owner_addr, boss.me.public_id);
  assert.deepEqual(one.activity.map((a) => [a.type, !!a.team, a.price]), [['mint', true, 0]]);
});

test('team mint stops at the sell-out and says so', async () => {
  const boss = await browser('chief');
  const [{ left }] = await db.query("select count(*)::int as left from nfts n join collections c on c.id = n.collection_id where c.slug = 'mcp' and n.minted_at is null");
  // mint all but 3 straight in the database (fast), then ask the API for 10
  await db.query(`update nfts set minted_at = now(), owner_id = (select id from users where handle = 'chief') where id in (
    select id from nfts where minted_at is null and collection_id = (select id from collections where slug = 'mcp') order by id limit $1)`, [left - 3]);
  const r = await boss.call('POST', '/admin/team-mint', { count: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.body.minted.length, 3);
  assert.equal(r.body.left, 0);
  const again = await boss.call('POST', '/admin/team-mint', { count: 1 });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /sold out/);
  // put them back for the next test: everything not minted through the ledger is unminted again
  await db.query(`update nfts set minted_at = null, owner_id = null where minted_at is not null
    and id::text not in (select ref from ledger where kind in ('mint', 'team_mint'))`);
});

test('mint page API: progress and the newest mints, cached briefly by the CDN; paging gives every mint once', async () => {
  const live = await get('/api/mint/live');
  assert.equal(live.status, 200);
  const minted = (await db.query("select count(*)::int as n from nfts n join collections c on c.id = n.collection_id where c.slug = 'mcp' and minted_at is not null"))[0].n;
  assert.equal(live.body.minted, minted);
  assert.equal(live.body.supply, 5000);
  assert.equal(live.body.left, 5000 - minted);
  assert.equal(live.body.mint_price, 5);
  assert.equal(live.body.recent.length, 60);
  assert.match(live.headers.get('netlify-cdn-cache-control'), /s-maxage=2/);
  assert.match(live.headers.get('cache-control'), /max-age=0/);
  const ats = live.body.recent.map((n) => new Date(n.at).getTime());
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a), 'newest first');
  assert.ok(live.body.recent.every((n) => n.thumb && n.image && n.name && n.cursor));

  // walk the whole feed with the cursor: team mints share one timestamp, nothing may be skipped or repeated
  const seen = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const page = (await get(`/api/mint/feed?limit=48${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).body;
    seen.push(...page.map((n) => n.id));
    if (page.length < 48) break;
    cursor = page.at(-1).cursor;
  }
  assert.equal(seen.length, minted);
  assert.equal(new Set(seen).size, minted);
  assert.deepEqual(seen.slice(0, 60), live.body.recent.map((n) => n.id));
  // a garbled cursor is ignored, not an error
  assert.equal((await get('/api/mint/feed?cursor=x%27;drop')).status, 200);
});

test('site: the home page is the mint page, the market moved to /market', () => {
  assert.ok(SITE_PAGES.test('/market'));
  assert.ok(!SITE_PAGES.test('/marketx'));
});

test('team mint: a failure after some chunks reports what was minted, and why it stopped', async () => {
  const [u] = await db.query("select id from users where handle = 'chief'");
  let calls = 0;
  const flaky = { ...db, tx: (fn) => (++calls === 2 ? Promise.reject(new Error('connection reset')) : db.tx(fn)) };
  const r = await m.teamMint(flaky, u.id, 120);
  assert.equal(r.minted.length, 50, 'the first chunk is kept and reported');
  assert.match(r.stopped, /try again/);
  // a failure on the first chunk is an error as before
  calls = 1;
  await assert.rejects(m.teamMint(flaky, u.id, 10), /connection reset/);
  await ledgerMatches();
});

test('explorer: a page stays full after big team mints (a team mint chunk is one 50-row transaction)', async () => {
  const boss = await browser('chief');
  const [u] = await db.query("select id from users where handle = 'chief'");
  for (let i = 0; i < 40; i++) await m.credit(db, u.id, 1e6, 'deposit', `small ${i}`);
  assert.equal((await boss.call('POST', '/admin/team-mint', { count: 500 })).status, 200);
  await explorer.seal();
  const page1 = (await get('/api/explorer/txs?limit=30')).body;
  assert.equal(page1.length, 30, 'a full page');
  assert.ok(page1.filter((t) => t.type === 'team mint').length >= 10);
  // paging reaches everything, each transaction once
  const all = new Set(page1.map((t) => t.id));
  let before = page1.at(-1).id;
  for (let i = 0; i < 50; i++) {
    const p = (await get(`/api/explorer/txs?limit=30&before=${before}`)).body;
    p.forEach((t) => { assert.ok(!all.has(t.id), `#${t.id} once`); all.add(t.id); });
    if (p.length < 30) break;
    before = p.at(-1).id;
  }
  const [{ n }] = await db.query('select count(distinct xact)::int as n from ledger');
  assert.equal(all.size, n);
  // the same for one address
  const mine = (await get(`/api/explorer/txs?limit=30&addr=${boss.me.public_id}`)).body;
  assert.equal(mine.length, 30);
});
