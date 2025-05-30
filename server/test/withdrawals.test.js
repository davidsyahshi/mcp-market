// Payouts against the in-memory chain: every way a payout can go wrong, and the rule that matters most:
// no withdrawal is ever paid twice and none is paid without being requested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { upsertUser, credit } from '../src/market.js';
import { createWithdrawals, withdrawConfig } from '../src/withdrawals.js';
import { MarketError } from '../src/market.js';
import { decodeTransaction, keypairFromSecret, keypairFromSeed, signTransaction, ix, MEMO_PROGRAM, COMPUTE_BUDGET_PROGRAM } from '../src/tx.js';
import { associatedTokenAddress, TOKEN_PROGRAM, ATA_PROGRAM, makeRpc } from '../src/solana.js';
import { base58 } from '@scure/base';
import { fakeChain, testWithdrawConfig, TEST_HOT, TEST_HOT_SECRET, TEST_POOL_KEY, DEV_USDC, randomAddress } from './fakechain.js';

const D = (n) => Math.round(n * 1e6);
const quiet = () => {};

async function setup({ config = {}, hotUsdc = 1000, hotSol = 1e9, spy } = {}) {
  const db = await openDb({ url: '' });
  const chain = fakeChain();
  if (hotUsdc != null) chain.fund(TEST_HOT.publicKey, DEV_USDC, D(hotUsdc), hotSol);
  const logs = [];
  const rpc = spy ? async (m, p) => { spy(m, p); return chain.rpc(m, p); } : chain.rpc;
  const w = createWithdrawals(db, { config: testWithdrawConfig(config), rpc, log: (...a) => logs.push(a.join(' ')) });
  const user = async (handle, balance = 500) => {
    const u = await upsertUser(db, { xId: `dev:${handle}`, handle });
    if (balance) await credit(db, u.id, D(balance), 'deposit', `seed-${handle}`);
    const address = randomAddress();
    await w.bindAddress(u.id, address);
    return { ...u, address };
  };
  const bal = async (id) => Number((await db.query('select balance from users where id = $1', [id]))[0].balance);
  const row = async (id) => (await db.query('select * from withdrawals where id = $1', [id]))[0];
  const received = (address) => Number(chain.tokenBalance(address, DEV_USDC));
  const ledgerOk = async () => {
    const bad = await db.query(`select u.handle from users u left join (select user_id, sum(delta) s from ledger group by user_id) l on l.user_id = u.id
      where u.balance <> coalesce(l.s, 0)`);
    assert.deepEqual(bad, [], 'every balance equals its ledger');
  };
  return { db, chain, w, user, bal, row, received, logs, ledgerOk };
}

test('config: keys, networks, defaults', () => {
  const env = (o) => createWithdrawals(null, { config: withdrawConfig({ DEPOSIT_POOL_KEY: TEST_POOL_KEY, ...o }), rpc: async () => {}, log: quiet });
  assert.equal(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET }).enabled, true);
  assert.equal(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET }).hotWallet, TEST_HOT.publicKey);
  assert.match(env({ TEST_MODE: '1' }).problem, /WITHDRAW_WALLET_KEY is not set/);
  assert.match(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: 'nope' }).problem, /WITHDRAW_WALLET_KEY/);
  assert.match(env({ TEST_MODE: '1', SOLANA_CLUSTER: 'mainnet', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET }).problem, /only pays out on devnet/);
  assert.match(env({ SOLANA_CLUSTER: 'devnet', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET }).problem, /only pays out on mainnet/);
  assert.match(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET, DEPOSIT_POOL_KEY: '' }).problem, /DEPOSIT_POOL_KEY \(or WITHDRAW_MAC_KEY\)/);
  assert.match(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET, WITHDRAW_PRIORITY_FEE: 'high' }).problem, /WITHDRAW_PRIORITY_FEE/);
  assert.equal(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET, WITHDRAW_PRIORITY_FEE: '20000' }).enabled, true);
  assert.equal(env({ TEST_MODE: '1', WITHDRAW_WALLET_KEY: TEST_HOT_SECRET }).config.walletKey, undefined, 'no secrets in the public settings');
  const prod = withdrawConfig({});
  assert.equal(prod.mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'mainnet pays USDC');
  assert.deepEqual([prod.fee, prod.min, prod.autoMax, prod.userDaily, prod.daily, prod.hardDaily, prod.addressDelayHours], [D(0.5), D(5), D(100), D(300), D(1000), D(2000), 24]);
  assert.equal(withdrawConfig({ TEST_MODE: '1' }).addressDelayHours, 0);
  // all secret key formats give the same wallet: Phantom export (base58), solana-keygen (JSON), a bare seed
  assert.equal(keypairFromSecret(JSON.stringify([...TEST_HOT.seed, ...base58.decode(TEST_HOT.publicKey)])).publicKey, TEST_HOT.publicKey);
  assert.equal(keypairFromSecret(JSON.stringify([...TEST_HOT.seed])).publicKey, TEST_HOT.publicKey);
  assert.equal(keypairFromSecret(` ${TEST_HOT_SECRET}\n`).publicKey, TEST_HOT.publicKey);
  assert.throws(() => keypairFromSecret(TEST_HOT_SECRET.slice(0, -2) + '11'), /do not match|64 bytes|not a Solana/);
});

test('the RPC client never repeats a sendTransaction by itself', async () => {
  let calls = 0;
  const down = async () => { calls++; throw new TypeError('fetch failed'); };
  const rpc = makeRpc('http://x.invalid', { fetchImpl: down });
  await assert.rejects(rpc('sendTransaction', ['AA==']), (e) => e.network === true);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(rpc('getBalance', ['x']));
  assert.equal(calls, 2, 'reads are retried once');
  const busy = makeRpc('http://x.invalid', { fetchImpl: async () => { calls++; return new Response('{}', { status: 503 }); } });
  calls = 0;
  await assert.rejects(busy('sendTransaction', ['AA==']));
  assert.equal(calls, 1);
});

test('binding the address: wallets only, once', async () => {
  const { db, chain, w } = await setup();
  const u = await upsertUser(db, { xId: 'dev:b', handle: 'b' });
  await assert.rejects(w.bindAddress(u.id, 'not-an-address'), /not a Solana address/);
  await assert.rejects(w.bindAddress(u.id, TEST_HOT.publicKey), /payout wallet/);
  const tokenAccount = chain.fund(randomAddress(), DEV_USDC, 5);
  await assert.rejects(w.bindAddress(u.id, tokenAccount), /token account, not a wallet/);
  await db.query("insert into deposit_pool (network, idx, address, mac) values ('devnet', 0, $1, $2)", ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'x']);
  await assert.rejects(w.bindAddress(u.id, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), /deposit address of this market/);
  const addr = randomAddress();
  await w.bindAddress(u.id, addr);
  await assert.rejects(w.bindAddress(u.id, randomAddress()), /already bound/);
  // the network can't be reached: refuse rather than bind blind
  const blind = createWithdrawals(db, { config: testWithdrawConfig(), rpc: async () => { throw new Error('down'); }, log: quiet });
  const v = await upsertUser(db, { xId: 'dev:v', handle: 'v' });
  await assert.rejects(blind.bindAddress(v.id, randomAddress()), /Could not check/);
});

test('a payout: amount arrives, fee on top, one transaction with a memo, ledger adds up', async () => {
  const { w, chain, user, bal, row, received, ledgerOk } = await setup();
  const u = await user('pay', 100);
  await assert.rejects(w.request(u.id, D(4.99)), /Minimum withdrawal is 5 \$MCP/);
  await assert.rejects(w.request(u.id, D(99.6)), /plus the 0.50 \$MCP fee is 100.10 \$MCP.*up to 99.50 \$MCP/);
  const r = await w.request(u.id, D(50));
  assert.equal(r.status, 'pending');
  assert.equal(await bal(u.id), D(49.5), 'amount + fee reserved at once');
  const s = await w.send(r.id);
  assert.equal(s.status, 'sent');
  assert.equal(received(u.address), D(50));
  assert.equal(Number(chain.tokenBalance(TEST_HOT.publicKey, DEV_USDC)), D(950));
  assert.equal(chain.executed.length, 1);
  assert.equal(chain.executed[0].memo, `mcp:w:devnet:${r.id}`);
  assert.equal(chain.executed[0].signature, (await row(r.id)).tx);
  assert.equal((await w.send(r.id)).status, 'sent', 'sending again does nothing');
  assert.equal(chain.executed.length, 1);
  // the recipient had no USDC account: it was created in the same transaction, paid by the hot wallet
  assert.ok(chain.tokens.has(associatedTokenAddress(u.address, DEV_USDC)));
  await ledgerOk();
});

test('never twice: lost responses, dropped, late and expired transactions, parallel senders, a reset row', async () => {
  const { db, w, chain, user, row, received, ledgerOk } = await setup();
  const u = await user('twice', 1000);
  const expire = () => chain.advance(400); // past last valid height + margin

  // the node took it but the answer was lost: stays "sending", the next check finds it confirmed
  chain.behave.lostResponse = 1;
  const a = await w.request(u.id, D(10));
  assert.equal((await w.send(a.id)).status, 'sending');
  await w.tick();
  assert.equal((await row(a.id)).status, 'sent');
  assert.equal(received(u.address), D(10));

  // accepted, then dropped on the way: the same bytes are rebroadcast while they are still valid
  chain.behave.drop = 1;
  const b = await w.request(u.id, D(10));
  assert.equal((await w.send(b.id, { waitMs: 0 })).status, 'sending');
  await w.tick();
  assert.equal((await row(b.id)).status, 'sent');
  assert.equal(received(u.address), D(20));

  // dropped every time until its blockhash expired: only then a new transaction is made
  chain.behave.drop = 2;
  const c = await w.request(u.id, D(10));
  const first = (await w.send(c.id, { waitMs: 0 })).tx;
  await w.tick(); // still valid: rebroadcast, dropped again
  assert.equal((await row(c.id)).status, 'sending');
  expire();
  await w.tick(); // dead -> queued -> paid with a new transaction
  const done = await row(c.id);
  assert.equal(done.status, 'sent');
  assert.notEqual(done.tx, first);
  assert.equal(received(u.address), D(30));

  // slow: the rebroadcast lands it; the slow copy arriving later changes nothing
  chain.behave.delay = 1;
  const slow = await w.request(u.id, D(10));
  await w.send(slow.id, { waitMs: 0 });
  await w.tick();
  chain.flush();
  await w.tick();
  assert.equal((await row(slow.id)).status, 'sent');
  assert.equal(received(u.address), D(40));

  // slow, and it lands in the very last valid block, long after it was sent: found, not paid again
  chain.behave.delay = 1;
  const late = await w.request(u.id, D(10));
  const lateTx = (await w.send(late.id, { waitMs: 0 })).tx;
  chain.advance(150); // exactly its last valid height
  chain.flush();
  expire();
  await w.tick();
  assert.equal((await row(late.id)).status, 'sent');
  assert.equal((await row(late.id)).tx, lateTx);
  assert.equal(received(u.address), D(50));

  // slow and outlives its blockhash: it can't land any more, a new one is made
  chain.behave.delay = 1;
  const slow2 = await w.request(u.id, D(10));
  await w.send(slow2.id, { waitMs: 0 });
  expire();
  chain.flush();
  await w.tick();
  assert.equal((await row(slow2.id)).status, 'sent');
  assert.equal(received(u.address), D(60));

  // the chat's send is refused by a lagging node while the scheduled run looks at the same withdrawal:
  // the scheduled run rebroadcasts the very same transaction instead of making a second one
  chain.behave.reject = 1;
  const race = await w.request(u.id, D(10));
  const raced = await w.send(race.id, { waitMs: 0 });
  assert.equal(raced.status, 'sending', 'a refusal is "maybe received", never "not sent"');
  await w.tick();
  await w.tick();
  expire();
  await w.tick();
  assert.equal((await row(race.id)).status, 'sent');
  assert.equal(received(u.address), D(70));

  // two senders at once (the chat and the scheduled run): one transaction
  const d = await w.request(u.id, D(10));
  await Promise.all([w.send(d.id), w.send(d.id), w.tick()]);
  assert.equal((await row(d.id)).status, 'sent');
  assert.equal(received(u.address), D(80));

  // the table editor refuses to reopen a paid withdrawal or to touch its stored transactions
  await assert.rejects(db.query("update withdrawals set status = 'pending' where id = $1", [d.id]), /is sent, which is final/);
  await assert.rejects(db.query('delete from withdrawal_attempts where withdrawal_id = $1', [d.id]), /can not be changed or deleted/);
  // someone with full control of the database switches that off and reopens every paid row, after lots of
  // other activity on chain: the stored transactions still show they were paid
  for (let i = 0; i < 30; i++) chain.fund(randomAddress(), DEV_USDC, 1);
  await db.query('alter table withdrawals disable trigger withdrawals_guard');
  await db.query("update withdrawals set status = 'pending', tx = null, attempts = 0 where user_id = $1", [u.id]);
  await db.query('alter table withdrawals enable trigger withdrawals_guard');
  await w.tick();
  await w.tick();
  assert.deepEqual((await db.query('select distinct status from withdrawals where user_id = $1', [u.id])).map((r) => r.status), ['sent']);
  assert.equal(received(u.address), D(80), 'not paid again');

  const ids = chain.executed.map((x) => x.memo);
  assert.equal(new Set(ids).size, ids.length, 'one payout per withdrawal');
  assert.equal(chain.executed.length, 8);
  await ledgerOk();
});

test("an outsider's transaction with our memo marks nothing as paid", async () => {
  const { w, chain, user, row, received } = await setup();
  const attacker = keypairFromSeed(Buffer.alloc(32, 42));
  chain.lamports.set(attacker.publicKey, 1e12);
  const { value: bh } = await chain.rpc('getLatestBlockhash', [{}]);
  const hotAta = associatedTokenAddress(TEST_HOT.publicKey, DEV_USDC);
  const t = signTransaction({ payer: attacker.publicKey, recentBlockhash: bh.blockhash, signers: [attacker], instructions: [
    ix.createAtaIdempotent({ payer: attacker.publicKey, ata: hotAta, owner: TEST_HOT.publicKey, mint: DEV_USDC }),
    ix.memo(Array.from({ length: 30 }, (_, i) => `mcp:w:devnet:${i + 1}`).join(' '))] });
  await chain.rpc('sendTransaction', [t.base64, {}]);
  const u = await user('victim', 100);
  const r = await w.request(u.id, D(50));
  const s = await w.send(r.id);
  assert.equal(s.status, 'sent');
  assert.notEqual((await row(r.id)).tx, t.signature);
  assert.equal(received(u.address), D(50), 'really paid');
});

test('failures: refused by the node, failed on chain, empty hot wallet, too many attempts', async () => {
  const { db, w, chain, user, row, received, logs } = await setup({ hotUsdc: 15 });
  const u = await user('fail', 1000);
  const expire = () => chain.advance(400);

  // refused: still "maybe received"; the scheduled run rebroadcasts the same bytes, which land once
  chain.behave.reject = 1;
  const a = await w.request(u.id, D(5));
  const r = await w.send(a.id);
  assert.equal(r.status, 'sending');
  assert.match((await row(a.id)).error, /simulation failed/);
  await w.tick();
  assert.equal((await row(a.id)).status, 'sent');
  assert.equal(received(u.address), D(5));
  // landed but failed: once that is finalized it moved nothing and can never land again, so a new one is made
  chain.behave.landFailed = 1;
  const a2 = await w.request(u.id, D(5));
  assert.equal((await w.send(a2.id)).status, 'sending');
  assert.equal(received(u.address), D(5));
  await w.tick();
  assert.equal((await row(a2.id)).status, 'sending', 'failed but only confirmed: could still be rolled back, wait');
  chain.advance(40);
  await w.tick();
  assert.equal((await row(a2.id)).status, 'sent');
  assert.equal(received(u.address), D(10));
  expire();

  // the hot wallet has 5 USDC left: the next one waits and the owner is told
  const b = await w.request(u.id, D(10));
  const waiting = await w.send(b.id);
  assert.equal(waiting.waiting, true);
  assert.match((await row(b.id)).error, /topped up/);
  assert.ok(logs.some((l) => /ALERT: hot wallet .* is low/.test(l)));
  const t1 = await w.tick();
  assert.ok(t1.errors.some((e) => /queued payouts need 10/.test(e)));
  chain.fund(TEST_HOT.publicKey, DEV_USDC, D(100), 0);
  await w.tick();
  assert.equal((await row(b.id)).status, 'sent');

  // no SOL for fees: waits too
  chain.lamports.set(TEST_HOT.publicKey, 1000);
  const c = await w.request(u.id, D(5));
  assert.equal((await w.send(c.id)).waiting, true);
  chain.lamports.set(TEST_HOT.publicKey, 1e9);

  // refused again and again: after 5 transactions it goes to manual review instead of trying forever
  chain.behave.reject = 100;
  for (let i = 0; i < 8; i++) { await w.tick(); expire(); }
  const gaveUp = await row(c.id);
  assert.equal(gaveUp.status, 'review');
  assert.match(gaveUp.error, /after 5 attempts/);
  assert.equal(Number((await db.query('select count(*) from withdrawal_attempts where withdrawal_id = $1', [c.id]))[0].count), 5);
  chain.behave.reject = 0;
  await db.query("update withdrawals set status = 'pending', attempts = 0 where id = $1", [c.id]); // the owner approves it again
  await w.tick();
  assert.equal((await row(c.id)).status, 'sent');
});

test('limits: over 100 at once, 300 a day per user, 1000 a day in total go to review; approve and reject', async () => {
  const { db, w, chain, user, bal, row, received, ledgerOk } = await setup({ hotUsdc: 5000 });
  const u = await user('big', 2000);
  const big = await w.request(u.id, D(150));
  assert.equal(big.status, 'review');
  await w.tick();
  assert.equal(received(u.address), 0, 'not paid automatically');
  for (const n of [100, 100, 100]) assert.equal((await w.request(u.id, D(n))).status, 'pending');
  assert.equal((await w.request(u.id, D(5))).status, 'review', '300 a day per user');
  await w.tick();
  assert.equal(received(u.address), D(300));

  // the owner approves the big one in the database: it goes out on the next run
  await db.query("update withdrawals set status = 'pending' where id = $1", [big.id]);
  await w.tick();
  assert.equal(received(u.address), D(450));

  // and rejects the small one: amount and fee come back, once
  const small = (await db.query("select id from withdrawals where status = 'review' and user_id = $1", [u.id]))[0];
  const before = await bal(u.id);
  await db.query("update withdrawals set status = 'rejected' where id = $1", [small.id]);
  await w.tick();
  await w.tick();
  assert.equal(await bal(u.id), before + D(5.5));
  assert.ok((await row(small.id)).refunded_at);

  // 1000 a day for everyone together
  const others = [];
  for (let i = 0; i < 4; i++) others.push(await user(`o${i}`, 500));
  const st = [];
  for (const o of others) for (const n of [100, 100]) st.push((await w.request(o.id, D(n))).status);
  // 450 already paid today + 8 x 100: the last ones go over 1000
  assert.deepEqual(st, ['pending', 'pending', 'pending', 'pending', 'pending', 'review', 'review', 'review']);
  await ledgerOk();
  assert.ok(chain.executed.length >= 4);
});

test('forged and altered rows are never paid or refunded', async () => {
  const { db, w, chain, user, bal, row, logs } = await setup({ hotUsdc: 5000 });
  const u = await user('victim', 100);
  const thief = randomAddress();
  // a row written straight into the database
  const [f] = await db.query(`insert into withdrawals (user_id, amount, fee, address, status, network, mac)
    values ($1, $2, 0, $3, 'pending', 'devnet', $4) returning id`, [u.id, D(900), thief, 'ab'.repeat(32)]);
  await w.tick();
  assert.equal((await row(f.id)).status, 'review');
  assert.match((await row(f.id)).error, /signature check failed/);
  assert.equal(chain.tokenBalance(thief, DEV_USDC), 0n);
  assert.ok(logs.some((l) => /ALERT: withdrawal #\d+ fails its signature check/.test(l)));

  // a real request whose amount or address is changed afterwards: the table refuses; with that switched
  // off, the signature check catches it
  const r = await w.request(u.id, D(10));
  await assert.rejects(db.query('update withdrawals set amount = $1 where id = $2', [D(1000), r.id]), /can not be changed/);
  await db.query('alter table withdrawals disable trigger withdrawals_guard');
  await db.query('update withdrawals set amount = $1 where id = $2', [D(1000), r.id]);
  await w.tick();
  assert.equal((await row(r.id)).status, 'review');
  await db.query('update withdrawals set amount = $1, address = $2 where id = $3', [D(10), thief, r.id]);
  await db.query("update withdrawals set status = 'pending' where id = $1", [r.id]);
  await w.tick();
  await db.query('alter table withdrawals enable trigger withdrawals_guard');
  assert.equal(chain.tokenBalance(thief, DEV_USDC), 0n, 'address change detected');

  // a forged "rejected" row would refund money that was never taken
  const before = await bal(u.id);
  await db.query(`insert into withdrawals (user_id, amount, fee, address, status, network, mac)
    values ($1, $2, 0, $3, 'rejected', 'devnet', $4)`, [u.id, D(500), thief, 'cd'.repeat(32)]);
  await w.tick();
  assert.equal(await bal(u.id), before);

  // a paid withdrawal marked rejected afterwards: refused by the table; forced anyway, the stored
  // transaction shows it was paid, no refund
  const p = await w.request(u.id, D(5));
  await w.send(p.id);
  assert.equal((await row(p.id)).status, 'sent');
  await assert.rejects(db.query("update withdrawals set status = 'rejected' where id = $1", [p.id]), /final/);
  await db.query('alter table withdrawals disable trigger withdrawals_guard');
  await db.query("update withdrawals set status = 'rejected', tx = null where id = $1", [p.id]);
  await db.query('alter table withdrawals enable trigger withdrawals_guard');
  const before2 = await bal(u.id);
  await w.tick();
  assert.equal(await bal(u.id), before2);
  assert.equal((await row(p.id)).status, 'sent');

  // the binding or the balance changed straight in the database: no withdrawals until someone looks
  const v = await user('bound', 100);
  await db.query('update users set withdraw_address = $1 where id = $2', [thief, v.id]);
  await assert.rejects(w.request(v.id, D(10)), /on hold for a security check/);
  const x = await user('rich', 100);
  await db.query('update users set balance = balance + $1 where id = $2', [D(10000), x.id]);
  await assert.rejects(w.request(x.id, D(500)), /on hold for a security check/);
  assert.ok(logs.some((l) => /binding fails its signature check/.test(l)) && logs.some((l) => /does not match the ledger/.test(l)));
  // bound before signed bindings existed: allowed, but every withdrawal waits for a person
  const y = await user('legacy', 100);
  await db.query('update users set withdraw_mac = null where id = $1', [y.id]);
  assert.equal((await w.request(y.id, D(10))).status, 'review');

  // a big withdrawal approved after waiting days in review is paid, not sent back
  const old = await w.request(u.id, D(5));
  await db.query("update withdrawals set created_at = now() - interval '4 days' where id = $1", [old.id]);
  await w.tick();
  assert.equal((await row(old.id)).status, 'sent');
});

test('switches: paused, waiting period after binding, closed', async () => {
  const paused = await setup({ config: { paused: true } });
  const u = await paused.user('p', 100);
  await assert.rejects(paused.w.request(u.id, D(10)), /paused/);

  const delayed = await setup({ config: { addressDelayHours: 24 } });
  const v = await delayed.user('d', 100);
  await assert.rejects(delayed.w.request(v.id, D(10)), /open 24 hours after binding: from \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  // moving the binding time back in the database doesn't help: the binding is signed
  await delayed.db.query("update users set withdraw_address_set_at = now() - interval '25 hours' where id = $1", [v.id]);
  await assert.rejects(delayed.w.request(v.id, D(10)), /on hold for a security check/);
  // once the waiting time has really passed, it opens
  const short = await setup({ config: { addressDelayHours: 0.0001 } }); // 0.36 seconds
  const z = await short.user('z', 100);
  await assert.rejects(short.w.request(z.id, D(10)), /after binding/);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await short.w.request(z.id, D(10))).status, 'pending');

  const db = await openDb({ url: '' });
  const closed = createWithdrawals(db, { config: testWithdrawConfig({ walletKey: '' }), rpc: async () => null, log: quiet });
  assert.equal(closed.enabled, false);
  await assert.rejects(closed.request(1, D(10)), (e) => e instanceof MarketError && /not open yet/.test(e.message));
  assert.deepEqual((await closed.tick()).skipped, 'WITHDRAW_WALLET_KEY is not set');
});

test('refunds: only once nothing can land any more, and only once', async () => {
  const { db, w, chain, user, bal, row, received, logs } = await setup();
  const u = await user('ref', 100);
  // the owner rejects a withdrawal whose transaction is still in flight: no refund yet
  chain.behave.drop = 1;
  const a = await w.request(u.id, D(10));
  await w.send(a.id, { waitMs: 0 });
  await db.query("update withdrawals set status = 'rejected' where id = $1", [a.id]);
  await w.tick();
  assert.equal(await bal(u.id), D(89.5), 'not refunded while it could still land');
  chain.advance(400);
  await w.tick();
  assert.equal(await bal(u.id), D(100), 'refunded once it can never land');
  assert.equal(received(u.address), 0);

  // ...and if the in-flight one lands after all, it counts as paid, with no refund
  chain.behave.delay = 1;
  const b = await w.request(u.id, D(10));
  await w.send(b.id, { waitMs: 0 });
  await db.query("update withdrawals set status = 'rejected' where id = $1", [b.id]);
  chain.flush();
  await w.tick();
  assert.equal((await row(b.id)).status, 'sent');
  assert.equal(await bal(u.id), D(89.5));
  assert.equal(received(u.address), D(10));

  assert.equal((await row(a.id)).status, 'refunded');
  // refunded is final: it can't be approved for payment afterwards...
  await assert.rejects(db.query("update withdrawals set status = 'pending' where id = $1", [a.id]), /is refunded, which is final/);
  // ...and even forced, it isn't paid, and it isn't refunded a second time
  await db.query('alter table withdrawals disable trigger withdrawals_guard');
  await db.query("update withdrawals set status = 'pending', refunded_at = null where id = $1", [a.id]);
  await w.tick();
  assert.equal((await row(a.id)).status, 'review');
  assert.match((await row(a.id)).error, /already refunded/);
  await db.query("update withdrawals set status = 'rejected', refunded_at = null where id = $1", [a.id]);
  await w.tick();
  await db.query('alter table withdrawals enable trigger withdrawals_guard');
  assert.equal(await bal(u.id), D(89.5));
  assert.equal(received(u.address), D(10));
  assert.equal((await row(a.id)).status, 'refunded');
  assert.ok(logs.some((l) => /already refunded once/.test(l)));
});

test('a lagging status lookup right after expiry does not cause a second payout (margin)', async () => {
  const { w, chain, user, row, received } = await setup();
  const u = await user('lag', 100);
  chain.behave.delay = 1;
  const a = await w.request(u.id, D(10));
  const tx = (await w.send(a.id, { waitMs: 0 })).tx;
  chain.advance(150); // its last valid block
  chain.flush(); // it lands there
  chain.advance(60); // finalized height now just past it (by less than the margin)
  chain.behave.statusLag = 1000; // the node answering status lookups hasn't seen it yet
  await w.tick();
  await w.tick();
  assert.equal(chain.executed.filter((e) => e.memo === `mcp:w:devnet:${a.id}`).length, 1, 'no second transaction inside the margin');
  chain.behave.statusLag = 0;
  chain.advance(400);
  await w.tick();
  assert.equal((await row(a.id)).status, 'sent');
  assert.equal((await row(a.id)).tx, tx);
  assert.equal(received(u.address), D(10));
});

test('a withdrawal set back to pending while its transaction is still in flight is not paid again', async () => {
  const { db, w, chain, user, row, received } = await setup();
  const u = await user('flip', 100);
  chain.behave.delay = 1;
  const a = await w.request(u.id, D(10));
  await w.send(a.id, { waitMs: 0 });
  chain.behave.drop = 100; // nothing new lands for a while: rebroadcasts are lost too
  await db.query("update withdrawals set status = 'pending' where id = $1", [a.id]); // someone flips it by hand
  await w.tick();
  assert.equal((await row(a.id)).status, 'sending', 'back to in flight, no second transaction');
  assert.equal(Number((await db.query('select count(*) from withdrawal_attempts where withdrawal_id = $1', [a.id]))[0].count), 1);
  chain.behave.drop = 0;
  chain.flush(); // the first one lands after all
  await w.tick();
  assert.equal((await row(a.id)).status, 'sent');
  assert.equal(received(u.address), D(10));
});

test('chaos: three instances, random drops, delays, refusals, lost answers and failed landings; each withdrawal paid exactly once', async () => {
  const { db, chain, user, received, ledgerOk } = await setup({ hotUsdc: 100000 });
  const inst = [0, 1, 2].map(() => createWithdrawals(db, { config: testWithdrawConfig({ userDaily: 1e12, daily: 1e12 }), rpc: chain.rpc, log: quiet }));
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const users = [];
  for (let i = 0; i < 6; i++) users.push(await user(`chaos${i}`, 1000));
  const ws = [];
  for (let i = 0; i < 30; i++) {
    const u = users[rnd(users.length)];
    ws.push({ u, w: await inst[rnd(3)].request(u.id, D(5 + rnd(20))) });
  }
  for (let round = 0; round < 120; round++) {
    const b = chain.behave;
    b.drop = rnd(3); b.delay = rnd(3); b.reject = rnd(2); b.lostResponse = rnd(2); b.landFailed = rnd(2); b.statusLag = rnd(3);
    const some = ws.filter(() => rnd(4) === 0).map((x) => inst[rnd(3)].send(x.w.id, { waitMs: 0 }));
    await Promise.all([...inst.map((x) => x.tick({ waitMs: 0 })), ...some]);
    if (rnd(3) === 0) chain.flush();
    chain.advance(rnd(250));
    const left = await db.query("select count(*)::int as n from withdrawals where status <> 'sent'");
    if (!left[0].n && round > 20) break;
  }
  Object.assign(chain.behave, { drop: 0, delay: 0, reject: 0, lostResponse: 0, landFailed: 0, statusLag: 0 });
  for (let i = 0; i < 6; i++) { chain.flush(); chain.advance(400); await Promise.all(inst.map((x) => x.tick({ waitMs: 0 }))); }
  // some may have given up into review after 5 refused tries: approve them, as the owner would
  await db.query("update withdrawals set status = 'pending', attempts = 0 where status = 'review'");
  for (let i = 0; i < 4; i++) { chain.advance(400); await Promise.all(inst.map((x) => x.tick({ waitMs: 0 }))); }

  const statuses = await db.query('select status, count(*)::int as n from withdrawals group by status');
  assert.deepEqual(statuses, [{ status: 'sent', n: 30 }]);
  const memos = chain.executed.map((e) => e.memo);
  assert.equal(memos.length, 30, 'thirty payouts');
  assert.equal(new Set(memos).size, 30, 'no withdrawal paid twice');
  for (const u of users) {
    const want = ws.filter((x) => x.u.id === u.id).reduce((s, x) => s + Number(x.w.amount), 0);
    assert.equal(received(u.address), want);
  }
  await ledgerOk();
});

test('a stale decision never stores a second transaction (claim checks status and transaction count)', async () => {
  const { db, chain, user, row, received } = await setup();
  const u = await user('stale', 100);
  let release;
  const gate = new Promise((r) => { release = r; });
  let gated = true;
  const slowRpc = async (m, p) => { if (m === 'getLatestBlockhash' && gated) { gated = false; await gate; } return chain.rpc(m, p); };
  const a = createWithdrawals(db, { config: testWithdrawConfig(), rpc: slowRpc, log: quiet });
  const b = createWithdrawals(db, { config: testWithdrawConfig(), rpc: chain.rpc, log: quiet });
  const w = await b.request(u.id, D(10));
  const slow = a.send(w.id, { waitMs: 0 }); // looks at the chain (nothing yet), then stalls before signing
  await new Promise((r) => setTimeout(r, 50));
  chain.behave.delay = 1;
  await b.send(w.id, { waitMs: 0 }); // meanwhile another instance signs and sends one
  await db.query("update withdrawals set status = 'pending' where id = $1", [w.id]); // and someone flips it back by hand
  release();
  await slow;
  assert.equal(Number((await db.query('select count(*) from withdrawal_attempts where withdrawal_id = $1', [w.id]))[0].count), 1, 'the stale instance stored nothing');
  chain.flush();
  await b.tick();
  await b.tick();
  assert.equal((await row(w.id)).status, 'sent');
  assert.equal(received(u.address), D(10));
});

test('a status node that is behind the rest counts as not knowing: nothing expires', async () => {
  const { db, w, chain, user, row, received } = await setup();
  const u = await user('behind', 100);
  chain.behave.delay = 1;
  const a = await w.request(u.id, D(10));
  await w.send(a.id, { waitMs: 0 });
  chain.flush();
  chain.advance(500); // long expired by height...
  chain.behave.staleStatusNode = true; // ...but statuses come from a node far behind
  chain.behave.statusLag = 1000;
  await w.tick();
  await w.tick();
  assert.equal(Number((await db.query('select count(*) from withdrawal_attempts where withdrawal_id = $1', [a.id]))[0].count), 1);
  chain.behave.staleStatusNode = false;
  chain.behave.statusLag = 0;
  await w.tick();
  assert.equal((await row(a.id)).status, 'sent');
  assert.equal(received(u.address), D(10));
});

test('the hard daily cap holds even for approved withdrawals; a new hot wallet keeps queued ones payable', async () => {
  const { db, chain, w, user, row, received } = await setup({ hotUsdc: 5000, config: { hardDaily: D(250) } });
  const u = await user('cap', 1000);
  const big = await w.request(u.id, D(200));
  await db.query("update withdrawals set status = 'pending' where id = $1", [big.id]); // approved
  await w.tick();
  assert.equal((await row(big.id)).status, 'sent');
  const more = await w.request(u.id, D(60));
  const r = await w.send(more.id);
  assert.equal(r.waiting, true);
  assert.match((await row(more.id)).error, /daily payout cap/);
  assert.equal(received(u.address), D(200));

  // the hot wallet is replaced (say, after a scare): queued rows and bindings stay valid
  const newHot = keypairFromSeed(Buffer.alloc(32, 77));
  const secret = base58.encode(Buffer.concat([newHot.seed, Buffer.from(base58.decode(newHot.publicKey))]));
  chain.fund(newHot.publicKey, DEV_USDC, D(500), 1e9);
  const w2 = createWithdrawals(db, { config: testWithdrawConfig({ walletKey: secret }), rpc: chain.rpc, log: quiet });
  const next = await w2.request(u.id, D(20));
  await db.query("update withdrawals set status = 'rejected' where id = $1", [more.id]);
  await w2.tick();
  assert.equal((await row(next.id)).status, 'sent');
  assert.equal(chain.executed.at(-1).transfers[0].from, associatedTokenAddress(newHot.publicKey, DEV_USDC));
  assert.equal((await row(more.id)).status, 'refunded');
});

test('transactions: signed by the hot wallet only, the exact amount to the bound address', async () => {
  const seen = [];
  const { w, chain, user } = await setup({ spy: (m, p) => { if (m === 'sendTransaction') seen.push(decodeTransaction(Buffer.from(p[0], 'base64'))); } });
  const u = await user('tx', 100);
  const r = await w.request(u.id, D(12.345678));
  await w.send(r.id);
  const t = seen[0];
  assert.ok(t.verified);
  assert.deepEqual(t.signers, [TEST_HOT.publicKey], 'only the hot wallet signs');
  assert.deepEqual(t.instructions.map((i) => i.programId), [COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM]);
  const hotAta = associatedTokenAddress(TEST_HOT.publicKey, DEV_USDC);
  const userAta = associatedTokenAddress(u.address, DEV_USDC);
  const transfer = t.instructions[3];
  assert.deepEqual(transfer.accounts, [hotAta, DEV_USDC, userAta, TEST_HOT.publicKey]);
  assert.equal(transfer.data[0], 12, 'TransferChecked');
  assert.equal(transfer.data.readBigUInt64LE(1), 12_345_678n);
  assert.equal(transfer.data[9], 6);
  assert.deepEqual(t.instructions[2].accounts.slice(0, 4), [TEST_HOT.publicKey, userAta, u.address, DEV_USDC]);
  assert.equal(t.instructions[4].data.toString(), `mcp:w:devnet:${r.id}`);
  assert.equal(chain.executed.at(-1).transfers[0].amount, 12_345_678n);
});
