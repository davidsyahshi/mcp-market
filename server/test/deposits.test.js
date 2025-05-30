// Deposits without HTTP: money math, address derivation, the offline address pool and its HMAC, configuration
// guards, the Helius webhook sync, the scheduled scan, and the one-time switch of old $MCP amounts to dollars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mcp, amount, toMicro, tokenToMicro, MoneyError } from '../src/money.js';
import { seedFromMnemonic, deriveAddress, associatedTokenAddress, isAddress, STABLECOINS } from '../src/solana.js';
import { createDeposits, depositConfig } from '../src/deposits.js';
import { poolKeyFromSeed, poolRowValid, parsePoolCsv } from '../src/pool.js';
import { createCronHandler } from '../src/cron.js';
import { openDb } from '../src/db.js';
import { migrate } from '../src/schema.js';
import { upsertUser, credit } from '../src/market.js';
import { fakeChain, testDepositConfig, seedPool, randomAddress, TEST_MNEMONIC, TEST_SEED, TEST_POOL_KEY, DEV_USDC } from './fakechain.js';

const D = (dollars) => Math.round(dollars * 1e6);
const quiet = () => {};

test('money: formatting and parsing $MCP amounts', () => {
  assert.equal(mcp(0), '0 $MCP');
  assert.equal(mcp(5_000_000), '5 $MCP');
  assert.equal(mcp(1_234_500_000), '1,234.50 $MCP');
  assert.equal(mcp(249_750), '0.24975 $MCP');
  assert.equal(mcp(-20_000), '-0.02 $MCP');
  assert.equal(mcp('900'), '0.0009 $MCP');
  assert.equal(amount(7_800_000), '7.80');
  assert.equal(toMicro('12.5 MCP'), 12_500_000);
  assert.equal(toMicro('12.5 $MCP'), 12_500_000);
  assert.equal(toMicro(12.5), 12_500_000);
  assert.equal(toMicro('19.99'), 19_990_000);
  assert.equal(toMicro('$3'), 3_000_000);
  assert.equal(toMicro(0.1 + 0.2), 300_000, 'float noise is fine when the cents are clear');
  assert.equal(toMicro(1.234567, { decimals: 6 }), 1_234_567);
  assert.throws(() => toMicro(8.005), MoneyError);
  assert.throws(() => toMicro(0), MoneyError);
  assert.throws(() => toMicro(-1), MoneyError);
  assert.throws(() => toMicro(NaN), MoneyError);
  assert.throws(() => toMicro('abc'), MoneyError);
  assert.throws(() => toMicro(1e20), MoneyError);
  assert.equal(tokenToMicro('2500000', 6), 2_500_000n);
  assert.equal(tokenToMicro('25', 0), 25_000_000n);
  assert.equal(tokenToMicro('123456789', 9), 123_456n);
});

test('solana: wallets match Phantom/Solflare derivation, token accounts match the ATA program', () => {
  // m/44'/501'/i'/0' for the BIP39 test phrase; cross-checked against @solana/web3.js + ed25519-hd-key
  // and @solana/spl-token when this was written
  const seed = seedFromMnemonic(TEST_MNEMONIC);
  assert.equal(deriveAddress(seed, 0), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  const w1 = deriveAddress(seed, 1);
  assert.equal(w1, 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb');
  assert.equal(associatedTokenAddress(w1, STABLECOINS.mainnet[0].mint), '8X8ts1CnpZmtqApE2rREA97xEJuSRcomPGVcMFdS2cgY');
  assert.equal(associatedTokenAddress(w1, STABLECOINS.mainnet[1].mint), 'BZnBhSRppxtYwkMzjn6brVCEVqPgx7zeRhGuJaPmuv2V');
  assert.equal(associatedTokenAddress(w1, STABLECOINS.devnet[0].mint), '9jwVhvtmyVeodF199kr7eHWxKuNmpmkBjkc87pPZhbPf');
  assert.equal(seedFromMnemonic(`  ${TEST_MNEMONIC.toUpperCase()}  `).equals(seed), true, 'case and spacing do not matter');
  assert.throws(() => seedFromMnemonic('abandon '.repeat(12).trim()), /not a valid/);
  assert.throws(() => deriveAddress(seed, -1));
  assert.ok(isAddress(w1));
  assert.ok(!isAddress('0OIl' + w1.slice(4)));
  assert.ok(!isAddress('1111'));
});

test('config: test money and real money never mix', async () => {
  const db = await openDb({ url: '' });
  const off = (over) => createDeposits(db, { config: testDepositConfig(over), log: quiet });
  assert.equal(off({}).enabled, true);
  assert.match(off({ cluster: 'mainnet' }).problem, /TEST_MODE=1 only takes devnet/);
  assert.match(off({ testMode: false }).problem, /real server only takes mainnet/);
  assert.match(off({ poolKey: 'abc' }).problem, /64-character key/);
  assert.match(off({ poolKey: '' }).problem, /DEPOSIT_POOL_KEY is not set/);
  assert.match(off({ rpcUrl: '' }).problem, /HELIUS_API_KEY/);
  assert.match(off({ cluster: 'testnet' }).problem, /mainnet or devnet/);
  assert.equal(off({ testMode: false, cluster: 'mainnet', tokens: STABLECOINS.mainnet }).enabled, true);

  // defaults from the environment
  const prod = depositConfig({ DEPOSIT_POOL_KEY: TEST_POOL_KEY.toUpperCase(), HELIUS_API_KEY: 'k' });
  assert.equal(prod.poolKey, TEST_POOL_KEY);
  assert.equal(prod.cluster, 'mainnet');
  assert.deepEqual(prod.tokens.map((t) => t.symbol), ['USDC', 'USDT']);
  assert.match(prod.rpcUrl, /^https:\/\/mainnet\.helius-rpc\.com\/\?api-key=k$/);
  const testSrv = depositConfig({ TEST_MODE: '1', HELIUS_API_KEY: 'k' });
  assert.equal(testSrv.cluster, 'devnet');
  assert.deepEqual(testSrv.tokens, STABLECOINS.devnet);
  assert.match(testSrv.rpcUrl, /^https:\/\/devnet\.helius-rpc\.com/);
  const custom = depositConfig({ TEST_MODE: '1', DEPOSIT_TOKENS: `usdc:${DEV_USDC}`, SOLANA_RPC_URL: 'https://rpc.example', MIN_DEPOSIT_USD: '1' });
  assert.deepEqual(custom.tokens, [{ symbol: 'USDC', mint: DEV_USDC }]);
  assert.equal(custom.rpcUrl, 'https://rpc.example');
  assert.equal(custom.minDeposit, 1_000_000);

  await db.close();
});

test('pool: made offline by the script, imported as CSV, one address per user, never a forged one', async () => {
  // the owner runs the script on their own computer; here the phrase is piped in
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const script = path.resolve(import.meta.dirname, '../scripts/deposit-pool.js');
  const run = (...a) => spawnSync(process.execPath, [script, ...a, '--out', dir], { input: TEST_MNEMONIC, encoding: 'utf8' });
  const r = run('--network', 'devnet', '--count', '4');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`DEPOSIT_POOL_KEY=${TEST_POOL_KEY}`));
  assert.match(r.stdout, /wallet #0 is HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk/);
  assert.doesNotMatch(r.stdout + r.stderr, /abandon/, 'the phrase is never printed back');
  const csv = fs.readFileSync(path.join(dir, 'deposit-pool-devnet-0-3.csv'), 'utf8');
  assert.doesNotMatch(csv, /abandon/);
  const rows = parsePoolCsv(csv);
  assert.equal(rows.length, 4);
  rows.forEach((row, i) => {
    assert.equal(row.idx, i);
    assert.equal(row.address, deriveAddress(TEST_SEED, i));
    assert.ok(poolRowValid(TEST_POOL_KEY, row));
  });
  // the next batch from the same phrase: same key, continues the numbering
  const next = run('--network', 'devnet', '--start', '4', '--count', '2');
  assert.match(next.stdout, new RegExp(`DEPOSIT_POOL_KEY=${TEST_POOL_KEY}`));
  assert.deepEqual(parsePoolCsv(fs.readFileSync(path.join(dir, 'deposit-pool-devnet-4-5.csv'), 'utf8')).map((x) => x.idx), [4, 5]);
  assert.notEqual(run('--network', 'devnet', '--count', '4').status, 0, 'never overwrites a file');
  assert.match(spawnSync(process.execPath, [script, '--network', 'devnet', '--out', dir], { input: 'not a phrase', encoding: 'utf8' }).stderr, /Nothing was saved/);
  assert.notEqual(spawnSync(process.execPath, [script, '--out', dir], { input: TEST_MNEMONIC, encoding: 'utf8' }).status, 0, 'network is required');
  // the key is tied to the phrase and the network
  assert.ok(!poolRowValid(TEST_POOL_KEY, { ...rows[0], network: 'mainnet' }));
  assert.ok(!poolRowValid(poolKeyFromSeed(Buffer.alloc(64, 1)), rows[0]), 'another phrase, another key');

  const db = await openDb({ url: '' });
  for (const row of rows) await db.query('insert into deposit_pool (network, idx, address, mac) values ($1, $2, $3, $4)', [row.network, row.idx, row.address, row.mac]);
  const logs = [];
  const dep = createDeposits(db, { config: testDepositConfig(), rpc: fakeChain().rpc, log: (...a) => logs.push(a.join(' ')) });
  const users = [];
  for (const h of ['u1', 'u2', 'u3', 'u4', 'u5']) users.push(await upsertUser(db, { xId: `dev:${h}`, handle: h }));

  // in order, one each, the same one every time
  assert.equal((await dep.wallet(users[0].id)).address, rows[0].address);
  assert.equal((await dep.wallet(users[0].id)).address, rows[0].address);
  assert.equal(await dep.currentAddress(users[0].id), rows[0].address);
  assert.equal(await dep.currentAddress(users[1].id), null, 'nothing handed out until asked');

  // someone with database access swaps in their own address: it is set aside, never shown
  const evil = randomAddress();
  await db.query("update deposit_pool set address = $1 where network = 'devnet' and idx = 1", [evil]);
  const w2 = await dep.wallet(users[1].id);
  assert.equal(w2.address, rows[2].address, 'skipped the forged row');
  assert.ok(logs.some((l) => /ALERT.*devnet#1/.test(l)));
  assert.deepEqual((await db.query("select network from deposit_pool where address = $1", [evil])).map((x) => x.network), ['rejected-devnet']);
  // ...or changes an address that is already handed out: refused, and nothing credited to it
  await db.query("update deposit_pool set address = $1 where network = 'devnet' and idx = 0", [randomAddress()]);
  await assert.rejects(dep.wallet(users[0].id), /failed verification/);
  assert.equal(await dep.currentAddress(users[0].id), null);

  // the pool runs out
  await dep.wallet(users[2].id);
  await assert.rejects(dep.wallet(users[3].id), /pool is empty/);

  // a mainnet server never hands out devnet rows
  const live = createDeposits(db, { config: testDepositConfig({ testMode: false, cluster: 'mainnet' }), rpc: fakeChain().rpc, log: quiet });
  await assert.rejects(live.wallet(users[4].id), /pool is empty/);
  await db.close();
});

test('crediting: only into token accounts of a verified pool address', async () => {
  const db = await openDb({ url: '' });
  const chain = fakeChain();
  await seedPool(db, { count: 3 });
  const dep = createDeposits(db, { config: testDepositConfig(), rpc: chain.rpc, log: quiet });
  const u = await upsertUser(db, { xId: 'dev:cred', handle: 'cred' });
  const w = await dep.wallet(u.id);
  const ata = w.accounts[0].address;
  const bal = async () => Number((await db.query('select balance from users where id = $1', [u.id]))[0].balance);

  chain.transfer({ mint: DEV_USDC, to: ata, owner: w.address, amount: D(1) });
  assert.equal((await dep.check(u.id)).credited.length, 1);
  assert.equal(await bal(), D(1));

  // a token account smuggled into deposit_accounts for the user, owned by someone else's wallet
  const other = randomAddress();
  const fake = associatedTokenAddress(other, DEV_USDC);
  await db.query("insert into deposit_accounts (address, user_id, wallet, token, mint) values ($1, $2, $3, 'USDC', $4)", [fake, u.id, other, DEV_USDC]);
  chain.transfer({ mint: DEV_USDC, to: fake, owner: other, amount: D(100) });
  await dep.check(u.id);
  assert.equal(await bal(), D(1), 'not a pool address');

  // ...or claiming the user's pool address while it isn't that address's token account
  const fake2 = randomAddress();
  await db.query("insert into deposit_accounts (address, user_id, wallet, token, mint) values ($1, $2, $3, 'USDC', $4)", [fake2, u.id, w.address, DEV_USDC]);
  chain.transfer({ mint: DEV_USDC, to: fake2, owner: w.address, amount: D(100) });
  await dep.check(u.id);
  assert.equal(await bal(), D(1), 'not the associated token account');

  // someone with database access points the user's pool row at their own wallet and pays themselves,
  // hoping to get credited: the row's HMAC no longer matches, so nothing is credited
  const own = randomAddress();
  const ownAta = associatedTokenAddress(own, DEV_USDC);
  const [row] = await db.query('select network, idx from deposit_pool where address = $1', [w.address]);
  await db.query('update deposit_pool set address = $1 where network = $2 and idx = $3', [own, row.network, row.idx]);
  await db.query("insert into deposit_accounts (address, user_id, wallet, token, mint) values ($1, $2, $3, 'USDC', $4)", [ownAta, u.id, own, DEV_USDC]);
  chain.transfer({ mint: DEV_USDC, to: ownAta, owner: own, amount: D(500) });
  await dep.scanUser(u.id, { force: true });
  assert.equal(await bal(), D(1), 'forged pool row');
  await db.query('update deposit_pool set address = $1 where network = $2 and idx = $3', [w.address, row.network, row.idx]);

  // money moved between two of our own pool addresses (the owner sweeping by mistake into a pool address)
  // is not a deposit
  const other2 = await upsertUser(db, { xId: 'dev:other2', handle: 'other2' });
  const w2 = await dep.wallet(other2.id);
  const from = w2.accounts[0].address;
  chain.addTx({
    accountKeys: [randomAddress(), from, ata],
    pre: [{ accountIndex: 1, mint: DEV_USDC, owner: w2.address, uiTokenAmount: { amount: String(D(70)), decimals: 6 } },
      { accountIndex: 2, mint: DEV_USDC, owner: w.address, uiTokenAmount: { amount: String(D(1)), decimals: 6 } }],
    post: [{ accountIndex: 1, mint: DEV_USDC, owner: w2.address, uiTokenAmount: { amount: '0', decimals: 6 } },
      { accountIndex: 2, mint: DEV_USDC, owner: w.address, uiTokenAmount: { amount: String(D(71)), decimals: 6 } }],
  });
  await dep.scanUser(u.id, { force: true });
  assert.equal(await bal(), D(1), 'internal transfer');

  // support credited a deposit by hand; when the scanner finds the same transaction later, it doesn't credit again
  const sig = chain.transfer({ mint: DEV_USDC, to: ata, owner: w.address, amount: D(3), before: D(71) });
  await credit(db, u.id, D(3), 'deposit', `manual ${sig}`);
  await dep.scanUser(u.id, { force: true });
  assert.equal(await bal(), D(4), 'credited once, by support');
  assert.equal((await db.query('select status from deposits where signature = $1', [sig]))[0].status, 'manual');
  // a manual credit for one user doesn't swallow another user's part of the same transaction
  const third = await upsertUser(db, { xId: 'dev:third', handle: 'third' });
  const w3 = await dep.wallet(third.id);
  const both = chain.batch(DEV_USDC, [{ to: w3.accounts[0].address, owner: w3.address, amount: D(2) }, { to: ata, owner: w.address, amount: D(1) }]);
  await credit(db, u.id, D(1), 'deposit', `manual ${both}`);
  await dep.scanUser(third.id, { force: true });
  await dep.scanUser(u.id, { force: true });
  assert.equal(Number((await db.query('select balance from users where id = $1', [third.id]))[0].balance), D(2));
  assert.equal(await bal(), D(5));
  // a pool row that fails its signature doesn't make a sender "ours": that deposit is credited normally
  const fakeOwner = randomAddress();
  await db.query("insert into deposit_pool (network, idx, address, mac) values ('devnet', 500, $1, $2)", [fakeOwner, 'ab'.repeat(32)]);
  chain.addTx({
    accountKeys: [randomAddress(), randomAddress(), ata],
    pre: [{ accountIndex: 1, mint: DEV_USDC, owner: fakeOwner, uiTokenAmount: { amount: String(D(9)), decimals: 6 } },
      { accountIndex: 2, mint: DEV_USDC, owner: w.address, uiTokenAmount: { amount: String(D(1)), decimals: 6 } }],
    post: [{ accountIndex: 1, mint: DEV_USDC, owner: fakeOwner, uiTokenAmount: { amount: '0', decimals: 6 } },
      { accountIndex: 2, mint: DEV_USDC, owner: w.address, uiTokenAmount: { amount: String(D(10)), decimals: 6 } }],
  });
  await dep.scanUser(u.id, { force: true });
  assert.equal(await bal(), D(14));

  // the pool row reassigned to another user in the database: the deposit is not credited to either
  const v = await upsertUser(db, { xId: 'dev:victim', handle: 'victim' });
  await db.query("update deposit_pool set user_id = $1 where address = $2", [v.id, w.address]);
  chain.transfer({ mint: DEV_USDC, to: ata, owner: w.address, amount: D(5), before: D(1) });
  await dep.scanUser(u.id, { force: true });
  assert.equal(await bal(), D(14));
  await db.close();
});

test('webhook sync: created once, updated when addresses change, recreated if deleted, switched back on', async () => {
  const db = await openDb({ url: '' });
  const chain = fakeChain();
  const dep = createDeposits(db, { config: testDepositConfig(), rpc: chain.rpc, helius: chain.helius, publicUrl: 'https://mcp.example', log: quiet });
  assert.equal(await dep.syncWebhook(), 'no addresses yet');
  assert.deepEqual(chain.heliusCalls, []);

  await seedPool(db, { count: 5 });
  const a = await upsertUser(db, { xId: 'dev:a', handle: 'a' });
  await dep.wallet(a.id); // no webhook yet: wallet() never creates one, it only updates
  assert.deepEqual(chain.heliusCalls, []);
  assert.equal(await dep.syncWebhook(), 'created, 2 addresses');
  const [hook] = chain.webhooks.values();
  assert.equal(hook.webhookURL, 'https://mcp.example/hooks/helius');
  assert.equal(hook.webhookType, 'rawDevnet');
  assert.equal(hook.authHeader, dep.webhookSecret);
  assert.equal(hook.txnStatus, 'success');
  assert.equal(hook.accountAddresses.length, 2);

  chain.heliusCalls.length = 0;
  assert.equal(await dep.syncWebhook(), 'up to date');
  assert.deepEqual(chain.heliusCalls, [], 'nothing changed: no paid API calls');

  // a new user's addresses go to the existing webhook right away
  const b = await upsertUser(db, { xId: 'dev:b', handle: 'b' });
  await dep.wallet(b.id);
  assert.deepEqual(chain.heliusCalls, ['update']);
  assert.equal(chain.webhooks.get(hook.webhookID).accountAddresses.length, 4);

  // every 6 hours: check it still exists and is on
  chain.webhooks.get(hook.webhookID).active = false;
  await db.query(`update app_meta set value = jsonb_set(value::jsonb, '{checkedAt}', '0')::text where key = 'helius_webhook'`);
  chain.heliusCalls.length = 0;
  await dep.syncWebhook();
  assert.deepEqual(chain.heliusCalls, ['get', 'activate', 'update']);
  assert.equal(chain.webhooks.get(hook.webhookID).active, true);

  // deleted in the Helius dashboard: forget it, then make a new one
  chain.webhooks.clear();
  await db.query(`update app_meta set value = jsonb_set(value::jsonb, '{checkedAt}', '0')::text where key = 'helius_webhook'`);
  assert.match(await dep.syncWebhook(), /will recreate/);
  assert.equal(await dep.syncWebhook(), 'created, 4 addresses');
  assert.equal(chain.webhooks.size, 1);

  // the same URL already registered (e.g. app_meta was wiped): adopt it instead of making a duplicate
  await db.query("delete from app_meta where key = 'helius_webhook'");
  await dep.syncWebhook();
  assert.equal(chain.webhooks.size, 1);

  // mainnet uses a mainnet webhook
  const live = createDeposits(db, {
    config: testDepositConfig({ testMode: false, cluster: 'mainnet' }), rpc: chain.rpc, helius: chain.helius, publicUrl: 'https://mcp.example', log: quiet,
  });
  await live.syncWebhook();
  assert.equal([...chain.webhooks.values()][0].webhookType, 'raw');
  await db.close();
});

test('scheduled scan: credits deposits nobody asked about, through the cron entry point', async () => {
  const db = await openDb({ url: '' });
  const chain = fakeChain();
  const dep = createDeposits(db, { config: testDepositConfig(), rpc: chain.rpc, helius: chain.helius, publicUrl: 'https://mcp.example', log: quiet });
  await seedPool(db, { count: 5 });
  const users = [];
  for (const h of ['p1', 'p2', 'p3']) {
    const u = await upsertUser(db, { xId: `dev:${h}`, handle: h });
    users.push({ ...u, ...(await dep.wallet(u.id)) });
  }
  // nobody is waiting for a deposit any more, so only the rotation finds these
  await db.query('update users set deposit_watch_until = null');
  for (const u of users) chain.transfer({ mint: DEV_USDC, to: u.accounts[0].address, owner: u.address, amount: D(2) });
  const handler = createCronHandler({ db, deposits: dep });
  const res = await handler({}, {});
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.webhook, 'created, 6 addresses');
  assert.equal(out.credited, 3);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.pool, { total: 5, free: 2 });
  const bal = await db.query('select balance from users order by id');
  assert.deepEqual(bal.map((r) => Number(r.balance)), [D(2), D(2), D(2)]);

  // runs again: nothing new, no double credit
  assert.equal(JSON.parse((await handler({}, {})).body).credited, 0);

  // two scans of the same account at once still credit once
  chain.transfer({ mint: DEV_USDC, to: users[0].accounts[0].address, owner: users[0].address, amount: D(4), before: D(2) });
  await db.query('update deposit_accounts set cursor = null');
  await Promise.all([dep.scanUser(users[0].id, { force: true }), dep.scanUser(users[0].id, { force: true })]);
  assert.equal(Number((await db.query('select balance from users where id = $1', [users[0].id]))[0].balance), D(6));
  const [{ n }] = await db.query("select count(*)::int as n from deposits where status = 'credited'");
  assert.equal(n, 4);

  // the network failing is reported, never thrown at the scheduler
  const broken = createDeposits(db, {
    config: testDepositConfig(), rpc: async () => { throw new Error('getSignaturesForAddress: HTTP 503'); }, helius: chain.helius, publicUrl: 'https://mcp.example', log: quiet,
  });
  const r = await broken.tick();
  assert.equal(r.credited, 0);
  assert.ok(r.errors.some((e) => /503/.test(e)));

  // deposits off: the scheduled function just says why
  const offHandler = createCronHandler({ db, deposits: createDeposits(db, { config: testDepositConfig({ poolKey: '' }), log: quiet }) });
  assert.match(JSON.parse((await offHandler({}, {})).body).skipped, /DEPOSIT_POOL_KEY/);
  await db.close();
});

test('migration: old whole-$MCP amounts become dollars once (1 old unit = 1 cent)', async () => {
  const db = await openDb({ url: '' });
  const u = await upsertUser(db, { xId: 'dev:old', handle: 'old' });
  // pretend this database was written by the previous version: plain integer $MCP and no migration marker
  await db.query("update users set balance = 1680 where id = $1", [u.id]);
  await db.query("insert into ledger (user_id, delta, kind, ref) values ($1, 2000, 'faucet', 'test'), ($1, -500, 'mint', '1'), (null, 500, 'mint', '1'), ($1, 180, 'sale', '2')", [u.id]);
  await db.query("insert into nfts (id, name, character, shape, palette, rarity, owner_id, price) values (9001, 'x', 'Scarf', 's', 'p', 'common', $1, 999)", [u.id]);
  await db.query("insert into withdrawals (user_id, amount, address) values ($1, 100, 'addr')", [u.id]);
  await db.query("delete from app_meta where key in ('data:usd-micro', 'data:withdraw-v2')");
  await db.query("update app_meta set value = 'old' where key = 'schema'");

  assert.equal(await migrate(db), true);
  // 16.80 in dollars, plus the 1.00 withdrawal that was queued before payouts existed, refunded
  assert.equal(Number((await db.query('select balance from users where id = $1', [u.id]))[0].balance), D(17.8));
  assert.equal(Number((await db.query('select price from nfts where id = 9001'))[0].price), D(9.99));
  const [wr] = await db.query('select amount, status from withdrawals');
  assert.deepEqual([Number(wr.amount), wr.status], [D(1), 'refunded']);
  const [{ s }] = await db.query('select sum(delta)::bigint as s from ledger where user_id = $1', [u.id]);
  assert.equal(Number(s), D(17.8));

  // never twice
  await db.query("update app_meta set value = 'old' where key = 'schema'");
  await migrate(db);
  assert.equal(Number((await db.query('select balance from users where id = $1', [u.id]))[0].balance), D(17.8));
  await db.close();
});
