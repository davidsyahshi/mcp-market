// Promo codes: the owner makes a code in /admin, people redeem it in the chat for one free MCP each, up to the
// code's limit. No money moves; the explorer shows each one as a "free mint".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
process.env.ADMIN_X_IDS = 'dev:chief';
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { entryHash, GENESIS } = await import('../src/explorer.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { COMMANDS, usage } = await import('../src/commands.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
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

// someone in their AI chat: the MCP tools, signed in as this account
const chats = new Map();
async function chat(handle) {
  if (chats.has(handle)) return chats.get(handle);
  const [u] = await db.query(`insert into users (x_id, handle, public_id) values ($1, $2, $3)
    on conflict (x_id) do update set handle = excluded.handle returning id`, [`dev:${handle}`, handle, m.newPublicId()]);
  const srv = buildMcpServer(db, u.id, { publicUrl: 'https://mcp.example', thumbsDir: '/nonexistent', deposits: { enabled: false }, ui: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') };
  };
  const one = { id: u.id, client: c, call, redeem: (code) => call('redeem_code', { code }) };
  chats.set(handle, one);
  return one;
}

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const ledgerMatches = async () => {
  const bad = await db.query(`select u.handle from users u left join (select user_id, sum(delta) s from ledger group by user_id) l on l.user_id = u.id
    where u.balance <> coalesce(l.s, 0)`);
  assert.deepEqual(bad, []);
};
const owned = async (userId) => db.query('select id, minted_by from nfts where owner_id = $1 order by id', [userId]);

test('admin: only the owner makes and lists codes; bad codes and limits are refused', async () => {
  const boss = await browser('chief');
  const fan = await browser('fan');
  assert.equal((await fan.call('POST', '/admin/promo', { code: 'NOPE1', uses: 5 })).status, 403);
  assert.equal((await fan.call('GET', '/admin/promo')).status, 403);
  for (const bad of [{}, { code: 'ab', uses: 5 }, { code: 'has space', uses: 5 }, { code: 'X'.repeat(33), uses: 5 }, { code: 'OK123' },
    { code: 'OK123', uses: 0 }, { code: 'OK123', uses: 5001 }, { code: 'OK123', uses: 2.5 }, { code: '<b>', uses: 5 }]) {
    const r = await boss.call('POST', '/admin/promo', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const r = await boss.call('POST', '/admin/promo', { code: ' first200 ', uses: 200 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.code, r.body.max_uses, r.body.used, r.body.status], ['FIRST200', 200, 0, 'active']);
  const dup = await boss.call('POST', '/admin/promo', { code: 'First200', uses: 10 });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists/);
  const list = await boss.call('GET', '/admin/promo');
  assert.deepEqual(list.body.map((p) => p.code), ['FIRST200']);
});

test('redeem: one free random MCP per account, nothing paid, outside the mint limit', async () => {
  const a = await chat('alice');
  const r = await a.redeem('FIRST200');
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^Free mint! Code FIRST200 gave you MCP #\d+/);
  assert.match(r.text, /Nothing was taken from your balance/);
  assert.match(r.text, /199 of 200 free mints left on FIRST200/);
  assert.match(r.text, /https:\/\/mcp\.example\/nft\/\d+/);
  const mine = await owned(a.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].minted_by, null, 'not counted against the paid limit');
  const [u] = await db.query('select balance from users where id = $1', [a.id]);
  assert.equal(Number(u.balance), 0);

  // the same account again, in any spelling: refused, and told which NFT it got
  for (const again of ['FIRST200', 'first200', ' "First200" ']) {
    const r2 = await a.redeem(again);
    assert.equal(r2.error, true);
    assert.match(r2.text, new RegExp(`already used FIRST200: it gave you MCP #${mine[0].id}`));
  }
  assert.equal((await owned(a.id)).length, 1);

  // still 5 paid mints on top
  await m.credit(db, a.id, 30e6, 'deposit', 'seed alice');
  for (let i = 0; i < 5; i++) await m.mint(db, a.id);
  await assert.rejects(m.mint(db, a.id), /Mint limit reached/);
  assert.equal((await owned(a.id)).length, 6);
  await ledgerMatches();
});

test('redeem: unknown, malformed, paused, used up', async () => {
  const b = await chat('bob');
  for (const [code, why] of [['NOSUCH', /no code "NOSUCH"/], ['', /not a valid code/], ['a b c', /not a valid code/], ['x'.repeat(41), /not a valid code/]]) {
    const r = await b.call('redeem_code', { code });
    assert.equal(r.error, true, code);
    assert.match(r.text, why, code);
  }
  const boss = await browser('chief');
  assert.equal((await boss.call('POST', '/admin/promo', { code: 'DUO', uses: 2 })).status, 200);
  assert.equal((await boss.call('POST', '/admin/promo/duo', { status: 'paused' })).body.status, 'paused');
  const paused = await b.redeem('DUO');
  assert.equal(paused.error, true);
  assert.match(paused.text, /DUO is paused/);
  assert.equal((await boss.call('POST', '/admin/promo/DUO', { status: 'active' })).body.status, 'active');
  assert.equal((await b.redeem('duo')).error, false);
  assert.equal((await (await chat('carol')).redeem('DUO')).error, false);
  const late = await (await chat('dave')).redeem('DUO');
  assert.equal(late.error, true);
  assert.match(late.text, /All 2 free mints of DUO are taken.*\/mint-mcp/);
  // more uses: never below what is already used
  assert.equal((await boss.call('POST', '/admin/promo/DUO', { uses: 1 })).status, 400);
  assert.equal((await boss.call('POST', '/admin/promo/DUO', { uses: 3 })).body.max_uses, 3);
  assert.equal((await (await chat('dave')).redeem('DUO')).error, false);
  assert.equal((await boss.call('POST', '/admin/promo/NOSUCH', { status: 'paused' })).status, 400);
  assert.equal((await boss.call('POST', '/admin/promo/DUO', { status: 'gone' })).status, 400);
  const list = (await boss.call('GET', '/admin/promo')).body;
  assert.deepEqual(list.find((p) => p.code === 'DUO').used, 3);
  await ledgerMatches();
});

test('redeem: many at once never go past the limit, and one account never gets two', async () => {
  const boss = await browser('chief');
  assert.equal((await boss.call('POST', '/admin/promo', { code: 'RUSH', uses: 3 })).status, 200);
  const people = await Promise.all(Array.from({ length: 8 }, (_, i) => chat(`rush${i}`)));
  const results = await Promise.all(people.map((p) => p.redeem('RUSH')));
  assert.equal(results.filter((r) => !r.error).length, 3);
  const greedy = await chat('greedy');
  assert.equal((await boss.call('POST', '/admin/promo', { code: 'TWICE', uses: 10 })).status, 200);
  const both = await Promise.all([greedy.redeem('TWICE'), greedy.redeem('TWICE'), greedy.redeem('twice')]);
  assert.equal(both.filter((r) => !r.error).length, 1);
  assert.equal((await owned(greedy.id)).length, 1);
  const [{ n }] = await db.query("select count(*)::int as n from promo_redemptions where code = 'RUSH'");
  assert.equal(n, 3);
});

test('explorer and NFT page: a free mint, amount 0, the chain still checks out; the code is not published', async () => {
  const a = await chat('alice');
  const [{ nft_id: id }] = await db.query("select nft_id from promo_redemptions where code = 'FIRST200' and user_id = $1", [a.id]);
  await explorer.seal();
  const txs = (await get('/api/explorer/txs?limit=100')).body;
  const free = txs.filter((t) => t.type === 'free mint');
  assert.equal(free.length, 8, 'FIRST200 1, DUO 3, RUSH 3, TWICE 1');
  const mineTx = free.find((t) => t.nft?.id === Number(id));
  assert.ok(mineTx, 'with its NFT');
  assert.ok(mineTx.entries.every((e) => e.amount === 0 && e.kind === 'free_mint'));
  assert.ok(!JSON.stringify(txs).includes('FIRST200'), 'the code stays out of public pages');
  const chain = (await get('/api/explorer/chain')).body;
  let prev = GENESIS;
  for (const e of chain) { assert.equal(entryHash(prev, e), e.hash, `entry ${e.seq}`); prev = e.hash; }
  const page = (await get(`/api/nfts/${id}`)).body;
  assert.deepEqual(page.activity.map((x) => [x.type, !!x.free, x.price]), [['mint', true, 0]]);
  // the account's recent activity in the chat says so too
  const acc = await a.call('account');
  assert.match(acc.text, new RegExp(`free mint MCP #${id} \\(code\\)`));
  await ledgerMatches();
});

test('redeem: sold out says so, and the code is not spent', async () => {
  const boss = await browser('chief');
  assert.equal((await boss.call('POST', '/admin/promo', { code: 'LATE', uses: 5 })).status, 200);
  await db.query(`update nfts set minted_at = now(), owner_id = (select id from users where handle = 'chief')
    where minted_at is null and collection_id = (select id from collections where slug = 'mcp')`);
  const r = await (await chat('erin')).redeem('LATE');
  assert.equal(r.error, true);
  assert.match(r.text, /sold out/);
  const list = (await boss.call('GET', '/admin/promo')).body;
  assert.equal(list.find((p) => p.code === 'LATE').used, 0);
  // put them back: everything not minted through the ledger is unminted again
  await db.query(`update nfts set minted_at = null, owner_id = null where minted_at is not null
    and id::text not in (select ref from ledger where kind in ('mint', 'team_mint', 'free_mint'))`);
});

test('redeem: guessing is limited to a few wrong codes an hour per account', async () => {
  const g = await chat('guesser');
  for (let i = 0; i < 10; i++) assert.match((await g.redeem(`GUESS${i}`)).text, /no code/);
  const r = await g.redeem('LATE');
  assert.equal(r.error, true);
  assert.match(r.text, /Too many wrong codes/);
  assert.equal((await owned(g.id)).length, 0);
  // someone else is not affected
  assert.equal((await (await chat('honest')).redeem('LATE')).error, false);
  // an hour later it works again
  await db.query("update promo_misses set created_at = now() - interval '61 minutes' where user_id = $1", [g.id]);
  assert.equal((await g.redeem('LATE')).error, false);
});

test('commands: /mcpcredit <code> and /code-mcp <code> redeem; the tool names them', async () => {
  const code = COMMANDS.find((x) => x.name === 'code-mcp');
  assert.equal(code.tool, 'redeem_code');
  assert.equal(usage(code), '/code-mcp <code>');
  assert.equal(usage(COMMANDS.find((x) => x.name === 'mcpcredit')), '/mcpcredit [code]');
  const c = (await chat('zed')).client;
  const t = (await c.listTools()).tools.find((x) => x.name === 'redeem_code');
  assert.match(t.description, /Chat command: \/code-mcp <code>\./);
  const start = (await c.listTools()).tools.find((x) => x.name === 'mcpcredit');
  assert.match(start.description, /If a code follows the command .* call redeem_code with that code instead/);
  assert.equal(t.annotations.readOnlyHint, false);
  const ins = c.getInstructions();
  assert.match(ins, /- \/mcpcredit \[code\]: .*redeem_code/);
  assert.match(ins, /call redeem_code only with a code the user typed in their own message/);
});
