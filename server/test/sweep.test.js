// The sweep script, end to end: a real child process talking JSON-RPC over HTTP to the in-memory chain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { deriveAddress, deriveKeypair, associatedTokenAddress } from '../src/solana.js';
import { decodeTransaction } from '../src/tx.js';
import { fakeChain, TEST_SEED, TEST_MNEMONIC, DEV_USDC, randomAddress } from './fakechain.js';

const D = (n) => Math.round(n * 1e6);
const script = path.resolve(import.meta.dirname, '../scripts/sweep.js');
let chain, server, url;
const sent = [];

before(async () => {
  chain = fakeChain();
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    if (method === 'sendTransaction') sent.push(decodeTransaction(Buffer.from(params[0], 'base64')));
    try {
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await chain.rpc(method, params) }));
    } catch (e) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: e.code || -32000, message: e.message.replace(/^\w+: /, '') } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const run = (...a) => new Promise((resolve) => {
  const p = execFile(process.execPath, [script, '--network', 'devnet', '--count', '6', '--rpc', url, ...a], { encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  p.stdin.end(TEST_MNEMONIC);
});

test('sweep: looks first, needs fee SOL, then moves every deposit to one address, fees paid by the fees wallet', async () => {
  const w0 = deriveAddress(TEST_SEED, 0);
  const w3 = deriveAddress(TEST_SEED, 3);
  const fees = deriveKeypair(TEST_SEED, 2147483647).publicKey;
  chain.fund(w0, DEV_USDC, D(25.5), null); // deposit wallets hold no SOL
  chain.fund(w3, DEV_USDC, D(100), null);
  chain.fund(deriveAddress(TEST_SEED, 4), DEV_USDC, D(0.5), null); // under --min 1: left alone
  const dest = randomAddress();

  // never into one of the pool's own addresses (the server would credit that user) or the fees wallet
  const intoPool = await run('--to', w0);
  assert.notEqual(intoPool.code, 0);
  assert.match(intoPool.out, /is deposit wallet #0 of this pool \(in Phantom: "Account 1"\)/);
  assert.match((await run('--to', deriveAddress(TEST_SEED, 9000))).out, /deposit wallet #9000/);
  assert.match((await run('--to', fees)).out, /fees wallet/);

  // a token account is not a valid destination
  const bad = await run('--to', chain.fund(randomAddress(), DEV_USDC, 1));
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /token account, not a wallet/);

  // looking: totals, nothing sent; the fees wallet has no SOL yet
  const look = await run('--to', dest);
  assert.match(look.out, /#0 \w+: 25\.50 USDC/);
  assert.match(look.out, /#3 \w+: 100 USDC/);
  assert.doesNotMatch(look.out, /#4 /);
  assert.match(look.out, /2 wallet\(s\) to move: 125\.50 USDC/);
  assert.match(look.out, new RegExp(`Send at least .* SOL to the fees wallet ${fees}`));
  assert.equal(sent.length, 0);
  assert.doesNotMatch(look.out, /abandon/, 'the phrase is never printed');

  chain.lamports.set(fees, 50_000_000);
  const dry = await run('--to', dest);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Nothing was sent\. Run again with --send/);
  assert.equal(sent.length, 0);
  const noYes = await run('--to', dest, '--send');
  assert.match(noYes.out, /add --yes/);
  assert.equal(sent.length, 0);

  const go = await run('--to', dest, '--send', '--yes');
  assert.equal(go.code, 0, go.out);
  assert.match(go.out, /Moved 2 of 2/);
  assert.equal(chain.tokenBalance(dest, DEV_USDC), BigInt(D(125.5)));
  assert.equal(chain.tokenBalance(w0, DEV_USDC), 0n);
  assert.equal(chain.tokenBalance(deriveAddress(TEST_SEED, 4), DEV_USDC), BigInt(D(0.5)));
  assert.ok(chain.tokens.has(associatedTokenAddress(w0, DEV_USDC)), 'token accounts stay open for future deposits');
  assert.equal(sent.length, 2);
  for (const t of sent) {
    assert.ok(t.verified);
    assert.equal(t.signers[0], fees, 'the fees wallet pays');
    assert.equal(t.signers.length, 2);
  }
  assert.ok(chain.lamports.get(fees) < 50_000_000);

  // nothing left: running again sends nothing
  const again = await run('--to', dest, '--send', '--yes');
  assert.match(again.out, /Nothing to move/);
  assert.equal(sent.length, 2);
});
