// The explorer: MCP addresses, the hash chain and its anchors on Solana, proof of reserves, the public API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TEST_MODE = '1';
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { entryHash, GENESIS } = await import('../src/explorer.js');
const m = await import('../src/market.js');
const { fakeChain, testDepositConfig, testWithdrawConfig, seedPool, TEST_HOT, DEV_USDC, FAKE_USDT, randomAddress } = await import('./fakechain.js');

let db, chain, app, server, base, explorer, deposits, withdrawals;
const RESERVE = randomAddress();
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  await seedPool(db);
  chain = fakeChain();
  chain.fund(TEST_HOT.publicKey, DEV_USDC, 100e6); // the payout wallet: 100 USDC, 1 SOL
  ({ app, explorer, deposits, withdrawals } = await createApp({
    db, publicUrl: 'http://localhost', devLogin: true, rpc: chain.rpc, helius: chain.helius,
    depositConfig: testDepositConfig(), withdrawConfig: testWithdrawConfig(),
    explorerConfig: { anchorEveryMs: 3600e3, reservesEveryMs: 0, reserveWallets: [RESERVE, RESERVE, TEST_HOT.publicKey] },
  }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
let n = 0;
async function user(handle = `u${++n}`, dollars = 50) {
  const u = await m.upsertUser(db, { xId: `dev:${handle}`, handle });
  if (dollars) await m.credit(db, u.id, dollars * 1e6, 'deposit', `USDC ${crypto.randomBytes(64).toString('hex').slice(0, 88).replace(/[0lIO]/g, 'x')} ${randomAddress()}`);
  return u;
}
// the whole chain from the API, recomputed from genesis the way the explorer page does it
async function verify() {
  let prev = GENESIS;
  let after = 0;
  let count = 0;
  for (;;) {
    const { body: page } = await get(`/api/explorer/chain?after=${after}&limit=1000`);
    if (!page.length) break;
    for (const e of page) {
      if (e.seq !== after + 1) return { ok: false, at: e.seq, why: 'gap' };
      if (entryHash(prev, e) !== e.hash) return { ok: false, at: e.seq, why: 'hash' };
      prev = e.hash;
      after = e.seq;
      count++;
    }
  }
  return { ok: true, count, head: prev };
}

test('every account gets an MCP address that is never a Solana address', async () => {
  const a = await user('alice');
  assert.match(a.public_id, /^mcp_[1-9A-HJ-NP-Za-km-z]{12}$/);
  assert.equal(m.isPublicId(a.public_id), true);
  const again = await m.upsertUser(db, { xId: 'dev:alice', handle: 'alice' });
  assert.equal(again.public_id, a.public_id, 'signing in again keeps the address');
  // accounts from before MCP addresses get one
  await db.query("insert into users (x_id, handle) values ('dev:old', 'old')");
  assert.equal(await m.ensurePublicIds(db), 1);
  const [old] = await db.query("select public_id from users where handle = 'old'");
  assert.equal(m.isPublicId(old.public_id), true);
});

test('a buy is one transaction: buyer, seller and the fee, under MCP addresses only', async () => {
  const seller = await user('seller');
  const buyer = await user('buyer');
  const nft = await m.mint(db, seller.id);
  await m.list(db, seller.id, nft.id, 10e6);
  await m.buy(db, buyer.id, nft.id, 10e6);
  const { body: list } = await get(`/api/explorer/txs?addr=${buyer.public_id}`);
  const buy = list.find((t) => t.type === 'buy');
  assert.equal(buy.entries.length, 3);
  assert.deepEqual(buy.entries.map((e) => [e.account, e.amount, e.kind]), [
    [buyer.public_id, -10, 'buy'], [seller.public_id, 9.75, 'sale'], ['treasury', 0.25, 'fee']]);
  assert.deepEqual(buy.nft, { id: nft.id, name: m.nftName(nft.id) });
  assert.equal(list.find((t) => t.type === 'deposit').solana.url.startsWith('https://solscan.io/tx/'), true);
  // nothing public names the X handles
  for (const p of ['/api/explorer/txs', `/api/explorer/address/${seller.public_id}`, `/api/nfts/${nft.id}`, '/api/explorer/summary', '/api/explorer/chain']) {
    const text = await fetch(base + p).then((r) => r.text());
    assert.doesNotMatch(text, /"(seller|buyer)"|@seller|@buyer|dev:/, p);
  }
  // until the user chooses to show it
  await m.setShowHandle(db, seller.id, true);
  const { body: addr } = await get(`/api/explorer/address/${seller.public_id}`);
  assert.equal(addr.name, 'seller');
  assert.equal(addr.nfts.length, 0, 'sold');
  const { body: tx } = await get(`/api/explorer/tx/${buy.id}`);
  assert.equal(tx.entries.find((e) => e.kind === 'sale').name, 'seller');
  assert.equal(tx.entries.find((e) => e.kind === 'buy').name, null);
});

test('the chain: every row sealed in order, recomputable, and a changed row is caught', async () => {
  await explorer.seal();
  let v = await verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  const [{ c }] = await db.query('select count(*)::int as c from ledger');
  assert.equal(v.count, c, 'every row is in the chain');
  const { body: s } = await get('/api/explorer/summary');
  assert.equal(s.chain.head_seq, c);
  assert.equal(s.chain.head_hash, v.head);
  assert.equal(s.chain.unsealed, 0);

  // new rows continue the chain
  const u = await user();
  await m.mint(db, u.id);
  await explorer.seal();
  v = await verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, c + 3);

  // the database refuses to change or delete ledger rows
  await assert.rejects(db.query('update ledger set delta = delta + 1 where seq = 2'), /sealed/);
  await assert.rejects(db.query('delete from ledger where seq = 2'), /can not be deleted/);
  // someone with full database access does it anyway: the chain shows where
  await db.query('alter table ledger disable trigger ledger_guard');
  await db.query('update ledger set delta = delta + 1000000 where seq = 2');
  await db.query('alter table ledger enable trigger ledger_guard');
  v = await verify();
  assert.deepEqual(v, { ok: false, at: 2, why: 'hash' });
  await db.query('alter table ledger disable trigger ledger_guard');
  await db.query('update ledger set delta = delta - 1000000 where seq = 2');
  await db.query('alter table ledger enable trigger ledger_guard');
  assert.equal((await verify()).ok, true);
});

test('anchors: the newest hash goes to Solana as a memo from the payout wallet', async () => {
  await explorer.seal();
  const head = (await get('/api/explorer/summary')).body.chain;
  const r = await explorer.anchor();
  assert.equal(r.anchored, head.head_seq, JSON.stringify(r));
  // what an anchor says can't be changed afterwards
  await assert.rejects(db.query("update chain_anchors set hash = 'x'"), /only its status can change/);
  await assert.rejects(db.query('delete from chain_anchors'), /can not be deleted/);
  const memo = `mcp:anchor:devnet:${head.head_seq}:${head.head_hash}`;
  const landed = chain.executed.find((x) => x.signature === r.signature);
  assert.equal(landed.memo, memo);
  assert.deepEqual(landed.transfers, [], 'an anchor moves no tokens');
  assert.equal(chain.tokenBalance(TEST_HOT.publicKey, DEV_USDC), 100_000_000n);
  // nothing new: nothing to anchor; new rows: not before the hour is up, unless forced
  assert.equal((await explorer.anchor()).skipped, 'up to date');
  await m.mint(db, (await user()).id);
  await explorer.seal();
  assert.equal((await explorer.anchor()).skipped, 'not due');
  // confirmed, then finalized after enough blocks
  await explorer.confirmAnchors();
  let { body: anchors } = await get('/api/explorer/anchors');
  assert.equal(anchors[0].status, 'confirmed');
  assert.equal(anchors[0].memo, memo);
  assert.match(anchors[0].url, /^https:\/\/solscan\.io\/tx\/\w+\?cluster=devnet$/);
  chain.advance(40);
  await explorer.confirmAnchors();
  ({ body: anchors } = await get('/api/explorer/anchors'));
  assert.equal(anchors[0].status, 'finalized');
  const forced = await explorer.anchor({ force: true });
  assert.ok(forced.anchored > head.head_seq);
  // the anchored hash matches the recomputed chain at that point
  const page = (await get(`/api/explorer/chain?after=${forced.anchored - 1}&limit=1`)).body;
  assert.equal(chain.executed.find((x) => x.signature === forced.signature).memo, `mcp:anchor:devnet:${forced.anchored}:${page[0].hash}`);
});

test('a lost anchor is marked dropped and done again', async () => {
  await m.mint(db, (await user()).id);
  await explorer.seal();
  // an explorer whose anchor is due (an hour since the last one)
  const due = (await import('../src/explorer.js')).createExplorer(db, { deposits, withdrawals, rpc: chain.rpc, config: { anchorEveryMs: 0 } });
  chain.behave.drop = 1;
  const r = await due.anchor();
  assert.ok(r.signature, JSON.stringify(r));
  chain.advance(400); // well past its last valid block height
  await due.confirmAnchors();
  const [row] = await db.query('select status from chain_anchors where signature = $1', [r.signature]);
  assert.equal(row.status, 'dropped');
  const again = await due.anchor();
  assert.ok(again.signature && again.signature !== r.signature, JSON.stringify(again));
});

test('proof of reserves: owed to users next to what is held on Solana', async () => {
  // one depositor whose deposit address really holds the money, plus a reserve wallet of the owner
  const d = await user('depositor', 0);
  const w = await deposits.wallet(d.id);
  const usdcAta = w.accounts.find((a) => a.token === 'USDC').address;
  chain.fund(w.address, DEV_USDC, 30e6, null);
  chain.fund(w.address, FAKE_USDT, 5e6, null);
  chain.fund(RESERVE, DEV_USDC, 200e6, null);
  // a token account that claims to be ours but belongs to someone else does not count
  await db.query('insert into deposit_accounts (address, user_id, wallet, token, mint) values ($1, $2, $3, $4, $5)',
    [chain.fund(randomAddress(), DEV_USDC, 999e6, null), d.id, w.address, 'USDC', DEV_USDC]);
  const r = await explorer.reserves();
  assert.ok(r.coverage > 0);
  const { body: s } = await get('/api/explorer/summary');
  const res = s.reserves;
  const [{ owed }] = await db.query('select sum(balance)::bigint as owed from users');
  assert.equal(res.owed_balances, String(owed));
  assert.equal(res.ledger_matches, true);
  assert.equal(res.held.USDC, String(30e6 + 100e6 + 200e6)); // deposit address + payout wallet + reserve wallet
  assert.equal(res.held.USDT, String(5e6));
  assert.equal(res.coverage, Math.floor((335e6 * 10000) / Number(owed)) / 10000);
  assert.ok(res.accounts.some((a) => a.kind === 'deposit' && a.token_account === usdcAta && a.amount === String(30e6)));
  assert.ok(res.accounts.some((a) => a.kind === 'reserve' && a.wallet === RESERVE));
  assert.ok(res.accounts.some((a) => a.kind === 'payout' && a.wallet === TEST_HOT.publicKey));
  assert.ok(!res.accounts.some((a) => a.amount === String(999e6)), 'a token account of another owner is ignored');
  assert.equal(res.accounts.filter((a) => a.wallet === RESERVE).length, 2, 'a reserve wallet listed twice counts once (USDC + USDT)');
  assert.ok(!res.accounts.some((a) => a.kind === 'reserve' && a.wallet === TEST_HOT.publicKey), 'the payout wallet is not also a reserve');
  assert.equal(new Set(res.accounts.map((a) => a.token_account)).size, res.accounts.length, 'no token account twice');
  // a withdrawal waiting to be paid is still owed
  await withdrawals.bindAddress(d.id, randomAddress());
  await m.credit(db, d.id, 10e6, 'deposit', 'manual support ref 123');
  const wd = await withdrawals.request(d.id, 6e6);
  await explorer.reserves();
  const res2 = (await get('/api/explorer/summary')).body.reserves;
  assert.equal(BigInt(res2.owed_withdrawals) >= BigInt(wd.amount), true);
  // manual support references are not published, only a digest
  const { body: txs } = await get(`/api/explorer/txs?addr=${d.public_id}`);
  assert.ok(txs.some((t) => t.entries.some((e) => /^manual:[0-9a-f]{16}$/.test(e.ref))));
  const manual = txs.find((t) => t.manual);
  assert.equal(manual.solana, undefined, 'a manual credit links to nothing');
  assert.doesNotMatch(JSON.stringify(txs), /support ref/);
  const wtx = txs.find((t) => t.type === 'withdrawal');
  assert.equal(wtx.withdrawal.id, Number(wd.id));
  assert.deepEqual(wtx.entries.map((e) => e.kind).sort(), ['withdraw', 'withdraw_fee', 'withdraw_fee']);
});

test('the public API is read-only and cheap; anchors stop while payouts are paused', async () => {
  const u = await user();
  await m.mint(db, u.id);
  const before = (await db.query('select count(*)::int as n from ledger where seq is null'))[0].n;
  await get('/api/explorer/summary');
  await get('/api/explorer/txs');
  assert.equal((await db.query('select count(*)::int as n from ledger where seq is null'))[0].n, before, 'page views seal nothing');
  assert.equal((await get('/api/explorer/summary')).body.chain.unsealed, before);
  const { body: a } = await get(`/api/explorer/address/${u.public_id}`);
  assert.match(a.joined, /^\d{4}-\d{2}-\d{2}$/, 'the day only');
  const paused = (await import('../src/explorer.js')).createExplorer(db, { deposits, withdrawals: { ...withdrawals, config: { ...withdrawals.config, paused: true } }, rpc: chain.rpc });
  assert.match((await paused.anchor({ force: true })).skipped, /paused/);
});

test('the scheduled run seals, anchors and refreshes reserves; the API checks its input', async () => {
  await m.mint(db, (await user()).id);
  const out = await explorer.tick();
  assert.deepEqual(out.errors, []);
  assert.ok(out.seal.sealed >= 3);
  assert.equal((await get('/api/explorer/txs?addr=alice')).status, 400);
  assert.equal((await get('/api/explorer/address/mcp_000')).status, 404);
  assert.equal((await get('/api/explorer/tx/999999')).status, 404);
  assert.equal((await get('/api/explorer/address/treasury')).status, 200);
  const { body: page1 } = await get('/api/explorer/txs?limit=2');
  const { body: page2 } = await get(`/api/explorer/txs?limit=2&before=${page1[1].id}`);
  assert.equal(page1.length, 2);
  assert.ok(page2[0].id < page1[1].id, 'pages go back in time');
  const { body: tre } = await get('/api/explorer/txs?addr=treasury&limit=100');
  assert.ok(tre.length && tre.every((t) => t.entries.some((e) => e.account === 'treasury')));
  assert.equal((await verify()).ok, true);
});
