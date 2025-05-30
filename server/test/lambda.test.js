// The suite against the serverless handler, fed Netlify-style events through a tiny local HTTP shim.
// This is the exact code path production runs (serverless-http + Express inside one function).
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open'; // these tests trade MCP NFTs long before 5,000 are minted
process.env.ADMIN_TOKEN = 'admin-secret';
const { createHandler } = await import('../src/lambda.js');
const { openDb } = await import('../src/db.js');
const { runSuite } = await import('./suite.js');
const { fakeChain, testDepositConfig, testWithdrawConfig, seedPool, TEST_HOT, DEV_USDC } = await import('./fakechain.js');
const { createCronHandler } = await import('../src/cron.js');

// turn a real HTTP request into a Netlify Functions (Lambda v1) event and back
function shim(handler) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://local');
    const headers = {};
    const multiValueHeaders = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      headers[k] = headers[k] ? `${headers[k]}, ${req.rawHeaders[i + 1]}` : req.rawHeaders[i + 1];
      (multiValueHeaders[k] ||= []).push(req.rawHeaders[i + 1]);
    }
    headers['x-nf-client-connection-ip'] = '203.0.113.7';
    multiValueHeaders['x-nf-client-connection-ip'] = ['203.0.113.7'];
    const event = {
      // as seen behind the "/* -> /.netlify/functions/api/:splat" rewrite
      path: '/.netlify/functions/api' + url.pathname,
      httpMethod: req.method,
      headers,
      multiValueHeaders,
      queryStringParameters: Object.fromEntries(url.searchParams),
      multiValueQueryStringParameters: [...url.searchParams.keys()].reduce((o, k) => ({ ...o, [k]: url.searchParams.getAll(k) }), {}),
      body: body.length ? body.toString('base64') : null,
      isBase64Encoded: body.length > 0,
      rawUrl: `http://local${req.url}`,
      rawQuery: url.search.slice(1),
    };
    try {
      const r = await handler(event, {});
      for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
      for (const [k, v] of Object.entries(r.multiValueHeaders || {})) res.setHeader(k, v);
      res.writeHead(r.statusCode);
      res.end(r.body ? Buffer.from(r.body, r.isBase64Encoded ? 'base64' : 'utf8') : undefined);
    } catch (e) {
      console.error(e);
      res.writeHead(502).end('lambda crashed');
    }
  });
}

const s = runSuite(async () => {
  const db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  const port = 3990 + Math.floor(Math.random() * 9);
  const base = `http://127.0.0.1:${port}`;
  const chain = fakeChain();
  await seedPool(db);
  chain.fund(TEST_HOT.publicKey, DEV_USDC, 1000e6); // the payout hot wallet
  const chainOpts = { rpc: chain.rpc, helius: chain.helius, depositConfig: testDepositConfig(), withdrawConfig: testWithdrawConfig() };
  const handler = createHandler({ db, publicUrl: base, devLogin: true, ...chainOpts });
  const server = shim(handler);
  await new Promise((r) => server.listen(port, r));
  const cronHandler = createCronHandler({ db, publicUrl: base, ...chainOpts });
  const cron = async () => JSON.parse((await cronHandler({}, {})).body);
  return { base, db, chain, cron, close: async () => { server.close(); await db.close(); } };
});

test('serverless: static files are left to the CDN', async () => {
  assert.equal((await fetch(`${s.base}/img/1.png`)).status, 404);
});
