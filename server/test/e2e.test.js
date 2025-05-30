// The suite against a plain Express server (how `npm start` runs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open'; // these tests trade MCP NFTs long before 5,000 are minted
process.env.ADMIN_TOKEN = 'admin-secret';
const { createApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { runSuite } = await import('./suite.js');
const { fakeChain, testDepositConfig, testWithdrawConfig, seedPool, TEST_HOT, DEV_USDC } = await import('./fakechain.js');
const { createCronHandler } = await import('../src/cron.js');

const s = runSuite(async () => {
  const db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  const port = 3900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const chain = fakeChain();
  await seedPool(db);
  chain.fund(TEST_HOT.publicKey, DEV_USDC, 1000e6); // the payout hot wallet
  const chainOpts = { rpc: chain.rpc, helius: chain.helius, depositConfig: testDepositConfig(), withdrawConfig: testWithdrawConfig() };
  const { app } = await createApp({ db, publicUrl: base, devLogin: true, ...chainOpts });
  const server = await new Promise((r) => { const sv = app.listen(port, () => r(sv)); });
  const cronHandler = createCronHandler({ db, publicUrl: base, ...chainOpts });
  const cron = async () => JSON.parse((await cronHandler({}, {})).body);
  return { base, db, chain, cron, close: async () => { server.close(); await db.close(); } };
});

test('local server also serves the site and images', async () => {
  const html = await fetch(`${s.base}/`).then((r) => r.text());
  assert.match(html, /MCP Market/);
  const img = await fetch(`${s.base}/img/1.png`);
  assert.equal(img.headers.get('content-type'), 'image/png');
});
