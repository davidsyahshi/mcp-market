// The withdrawal form's tools, against the MCP server directly (in-memory transport, fake chain).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TEST_MODE = '1';
const { openDb } = await import('../src/db.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { createWithdrawals } = await import('../src/withdrawals.js');
const m = await import('../src/market.js');
const { fakeChain, testWithdrawConfig, seedPool, TEST_HOT, DEV_USDC, randomAddress } = await import('./fakechain.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let db, chain, withdrawals;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  await seedPool(db);
  chain = fakeChain();
  chain.fund(TEST_HOT.publicKey, DEV_USDC, 1000e6);
  withdrawals = createWithdrawals(db, { rpc: chain.rpc, config: testWithdrawConfig() });
});
after(async () => { await db?.close(); });

let n = 0;
async function user(balance = 50) {
  const handle = `form${++n}`;
  const [u] = await db.query("insert into users (x_id, handle) values ($1, $2) returning id", [`dev:${handle}`, handle]);
  if (balance) await m.credit(db, u.id, balance * 1e6, 'deposit', `seed ${handle}`);
  return u.id;
}
async function client(userId, opts = {}) {
  const server = buildMcpServer(db, userId, { publicUrl: 'http://localhost', thumbsDir: '/nonexistent', deposits: { enabled: false }, withdrawals, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { ...r, text: (r.content || []).map((x) => x.text).join('\n') };
  };
  return { c, call };
}
const key = () => crypto.randomBytes(16).toString('hex');
const balance = async (id) => Number((await db.query('select balance from users where id = $1', [id]))[0].balance);

test('without a working form there are no form buttons at all, never ones the AI could call', async () => {
  const id = await user();
  const { c, call } = await client(id, { ui: null });
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('withdraw_form'));
  for (const x of ['withdraw_form_state', 'withdraw_form_bind', 'withdraw_form_submit']) assert.ok(!names.includes(x), x);
  assert.match((await call('withdraw_form')).text, /temporarily unavailable/);
});

test('with the form: every form button is marked for the form only', async () => {
  const { c } = await client(await user());
  const tools = (await c.listTools()).tools;
  for (const t of tools.filter((x) => x.name.startsWith('withdraw_form_'))) assert.deepEqual(t._meta.ui.visibility, ['app'], t.name);
});

test('an error after the withdrawal was made is not reported as a failure', async () => {
  const id = await user();
  const broken = { ...withdrawals, list: async () => { throw new Error('connection terminated unexpectedly'); } };
  const { call } = await client(id, { withdrawals: broken });
  const form = await call('withdraw_form').catch(() => null); // the form itself may fail to open: that's fine
  const token = form?._meta?.['mcp-market/form-token'] || withdrawals.formToken(id);
  const to = randomAddress();
  await withdrawals.bindAddress(id, to);
  const r = await call('withdraw_form_submit', { amount: 10, request_key: key(), form_token: token });
  assert.notEqual(r.isError, true, r.text);
  assert.equal(r.structuredContent.withdrawal.status, 'sent');
  assert.equal(r.structuredContent.state, null);
  assert.equal(chain.tokenBalance(to, DEV_USDC), 10_000_000n);
  assert.equal(await balance(id), 50e6 - 10.5e6);
});

test('a repeated request is answered with the first one before any other check', async () => {
  const id = await user();
  const { call } = await client(id);
  const token = (await call('withdraw_form'))._meta['mcp-market/form-token'];
  await withdrawals.bindAddress(id, randomAddress());
  const k = key();
  const first = await call('withdraw_form_submit', { amount: 5, request_key: k, form_token: token });
  assert.equal(first.structuredContent.withdrawal.status, 'sent');
  // later: withdrawals paused and the form's pass expired; the retry still gets the truth, nothing new
  const paused = createWithdrawals(db, { rpc: chain.rpc, config: testWithdrawConfig({ paused: true }) });
  const { call: later } = await client(id, { withdrawals: paused });
  const again = await later('withdraw_form_submit', { amount: 7, request_key: k, form_token: 'expired' });
  assert.notEqual(again.isError, true, again.text);
  assert.equal(again.structuredContent.withdrawal.id, first.structuredContent.withdrawal.id);
  assert.equal(again.structuredContent.withdrawal.amount, 5, 'the real amount, not the retried one');
  assert.equal(await balance(id), 50e6 - 5.5e6);
  // a new key while paused: a definite refusal
  const no = await later('withdraw_form_submit', { amount: 5, request_key: key(), form_token: paused.formToken(id) });
  assert.equal(no.structuredContent.refused, true);
  assert.match(no.text, /paused/);
});

test('form passes: per user, expire, can not be made up', async () => {
  const a = await user();
  const b = await user();
  const t = withdrawals.formToken(a);
  assert.equal(withdrawals.formTokenOk(a, t), true);
  assert.equal(withdrawals.formTokenOk(b, t), false);
  const [exp, mac] = t.split('.');
  assert.equal(withdrawals.formTokenOk(a, `${Number(exp) + 1}.${mac}`), false);
  assert.equal(withdrawals.formTokenOk(a, `${Date.now() + 10 * 3600e3}.${mac}`), false, 'no long-lived passes');
  assert.equal(withdrawals.formTokenOk(a, ''), false);
  const other = createWithdrawals(db, { rpc: chain.rpc, config: testWithdrawConfig({ macKey: 'ab'.repeat(32) }) });
  assert.equal(other.formTokenOk(a, t), false, 'another key');
});
