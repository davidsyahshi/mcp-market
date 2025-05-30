// The HTTP app: the MCP endpoint for AI chats, OAuth sign-in, the public preview API, the Helius deposit
// webhook, the manual credit endpoint and (locally) the preview site. Runs as a normal Node server (index.js) or as one Netlify function (lambda.js).
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createAuth } from './auth.js';
import { buildMcpServer } from './mcp.js';
import { findRoot } from './paths.js';
import * as m from './market.js';
import { toMicro, units, MoneyError } from './money.js';
import { createDeposits } from './deposits.js';
import { createWithdrawals } from './withdrawals.js';
import { withdrawUi } from './ui.js';
import { createExplorer } from './explorer.js';

const sameSecret = (given, key) => {
  if (!key || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
};

export async function createApp(opts) {
  const { db } = opts;
  if (!db) throw new Error('createApp needs a db');
  const publicUrl = (opts.publicUrl || process.env.PUBLIC_URL || process.env.URL || 'http://localhost:3000').replace(/\/$/, '');
  const root = opts.root || findRoot();
  const collectionDir = opts.collectionDir || path.join(root, 'collection');
  const serveStatic = opts.serveStatic ?? true;
  await m.seedCollection(db, path.join(collectionDir, 'collection.json'));
  const deposits = opts.deposits || createDeposits(db, { publicUrl, rpc: opts.rpc, helius: opts.helius, config: opts.depositConfig });
  const withdrawals = opts.withdrawals || createWithdrawals(db, { rpc: opts.rpc, config: opts.withdrawConfig });
  const explorer = opts.explorer || createExplorer(db, { deposits, withdrawals, rpc: opts.rpc, config: opts.explorerConfig });
  await m.ensurePublicIds(db);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    // behind a Netlify rewrite the function may see its own path; route by the public path
    if (req.url.startsWith('/.netlify/functions/api')) req.url = req.url.slice('/.netlify/functions/api'.length) || '/';
    // rate limits key on the client address: Netlify's edge header first, never undefined
    const ip = req.get('x-nf-client-connection-ip') || req.ip || String(req.get('x-forwarded-for') || '').split(',')[0].trim() || '0.0.0.0';
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  const { provider, router: loginRouter } = createAuth(db, {
    publicUrl,
    xClientId: process.env.X_CLIENT_ID,
    xClientSecret: process.env.X_CLIENT_SECRET,
    devLogin: opts.devLogin ?? process.env.DEV_LOGIN === '1',
  });
  const mcpUrl = new URL('/mcp', publicUrl);
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl: mcpUrl, scopesSupported: ['market'], resourceName: 'MCP market' }));
  app.use(loginRouter);

  // the MCP endpoint: stateless, one server per request, bound to the user behind the bearer token
  const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  const thumbsDir = path.join(collectionDir, 'thumbs');
  app.post('/mcp', auth, express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildMcpServer(db, req.auth.extra.userId, { publicUrl, thumbsDir, deposits, withdrawals });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      transport.close().catch(() => {});
      server.close().catch(() => {});
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all('/mcp', auth, (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

  // public read-only API for the preview site
  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // amounts in the public API are plain numbers of $MCP (1 $MCP = $1)
  const num = units;
  const shape = (n) => ({ ...n, price: num(n.price), image: `/img/${n.id}.png`, thumb: `/thumb/${n.id}.png` });
  const str = (v) => (typeof v === 'string' ? v : undefined);
  // whether this deploy can build the withdrawal form (it needs the bundled MCP Apps SDK file)
  const formInfo = () => {
    try {
      const f = withdrawUi();
      return { uri: f.uri, bytes: Buffer.byteLength(f.html) };
    } catch (e) {
      return { error: e.message.slice(0, 200) };
    }
  };
  api.get('/stats', async (req, res) => {
    const s = await m.stats(db);
    res.json({
      ...s, floor: num(s.floor), volume: num(s.volume), mint_price: num(s.mint_price), currency: 'MCP', usd_per_mcp: 1,
      deposits: deposits.enabled ? { network: deposits.cluster === 'mainnet' ? 'solana' : `solana-${deposits.cluster}`, tokens: deposits.tokens.map((t) => t.symbol) } : null,
      mcp_url: mcpUrl.toString(), test_mode: m.CONFIG.testMode,
      withdrawals: withdrawals.enabled ? { network: withdrawals.cluster, form: formInfo() } : null,
    });
  });
  api.get('/nfts', async (req, res) => {
    const q = Object.fromEntries(['status', 'sort', 'character', 'rarity'].map((k) => [k, str(req.query[k])]));
    const owner = str(req.query.owner); // an MCP address
    res.json((await m.browse(db, { ...q, ownerAddr: owner && m.isPublicId(owner) ? owner : undefined })).map(shape));
  });
  api.get('/nfts/:id', async (req, res) => {
    const id = Number(req.params.id);
    const n = Number.isInteger(id) ? await m.getNft(db, id) : null;
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json({ ...shape(n), history: n.history.map((h) => ({ ...h, price: num(h.price) })) });
  });
  // only accounts that chose to show their X handle can be found by it
  api.get('/users/:handle', async (req, res) => {
    const [u] = await db.query('select handle, name, avatar, created_at, public_id from users where handle = $1 and show_handle', [req.params.handle.toLowerCase()]);
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json({ ...u, nfts: (await m.browse(db, { ownerAddr: u.public_id })).map(shape) });
  });
  api.get('/sales', async (req, res) => {
    const rows = await db.query(`select s.nft_id, s.price, s.created_at, ${m.PUBLIC_NAME('se', 'seller')}, ${m.PUBLIC_NAME('b', 'buyer')} from sales s
      join users se on se.id = s.seller_id join users b on b.id = s.buyer_id order by s.id desc limit 20`);
    res.json(rows.map((r) => ({ ...r, price: num(r.price) })));
  });

  // the explorer: public, read-only. Everything is shown under MCP addresses (see explorer.js).
  const ex = express.Router();
  const intOr = (v, d = null) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : d);
  const addrOk = (a) => a === 'treasury' || m.isPublicId(a);
  // read-only: sealing, anchors, totals and reserves are done by the scheduled run
  ex.get('/summary', async (req, res) => res.json(await explorer.summary()));
  ex.get('/txs', async (req, res) => {
    const addr = str(req.query.addr);
    if (addr && !addrOk(addr)) return res.status(400).json({ error: 'not an MCP address' });
    res.json(await explorer.txs({ before: intOr(req.query.before), addr, limit: intOr(req.query.limit, 30) }));
  });
  ex.get('/tx/:id', async (req, res) => {
    const t = intOr(req.params.id) != null ? await explorer.tx(intOr(req.params.id)) : null;
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });
  ex.get('/address/:addr', async (req, res) => {
    const a = addrOk(req.params.addr) ? await explorer.address(req.params.addr) : null;
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json({ ...a, nfts: a.address === 'treasury' ? [] : (await m.browse(db, { ownerAddr: a.address })).map(shape) });
  });
  ex.get('/chain', async (req, res) => res.json(await explorer.chain({ after: intOr(req.query.after, 0), limit: intOr(req.query.limit, 1000) })));
  ex.get('/anchors', async (req, res) => res.json(await explorer.anchors(50)));
  api.use('/explorer', ex);
  app.use('/api', api);

  // Helius calls this when a transaction touches one of our deposit token accounts (see deposits.js).
  // It always answers 200 once authorized: Helius switches off webhooks that fail often, and anything
  // missed here is picked up by the scheduled scan.
  app.post('/hooks/helius', express.json({ limit: '5mb' }), async (req, res) => {
    if (!deposits.enabled || !sameSecret(req.get('authorization'), deposits.webhookSecret)) return res.status(401).json({ error: 'unauthorized' });
    try {
      res.json(await deposits.handleWebhook(req.body));
    } catch (e) {
      console.error('helius webhook', e.message);
      res.json({ ok: false });
    }
  });

  // Manual credit for support cases (e.g. a deposit made the wrong way). Off (always 401) until ADMIN_TOKEN is set.
  // Body: { handle, amount ($MCP), tx }. One tx is credited once.
  app.post('/admin/deposit', express.json(), async (req, res) => {
    if (!sameSecret(String(req.get('authorization') || '').replace(/^Bearer /, ''), process.env.ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
    const { handle, amount } = req.body || {};
    // a Solana signature, also when pasted as an explorer link; anything else is a free-form support reference
    let tx = String(req.body?.tx || '').trim();
    const sig = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.exec(tx)?.[0] || /\/tx\/([1-9A-HJ-NP-Za-km-z]{64,90})/.exec(tx)?.[1];
    if (sig) {
      tx = sig;
      const [done] = await db.query("select user_id from deposits where signature = $1 and status = 'credited' limit 1", [sig]);
      if (done) return res.status(409).json({ error: 'this transaction was already credited automatically', user_id: done.user_id });
    }
    const [u] = await db.query('select id from users where handle = $1', [String(handle || '').toLowerCase()]);
    let micro;
    try {
      micro = toMicro(amount, { decimals: 6 });
    } catch (e) {
      if (!(e instanceof MoneyError)) throw e;
    }
    if (!u || !micro || !tx) return res.status(400).json({ error: 'need handle, amount in $MCP, tx' });
    res.json(await m.credit(db, u.id, micro, 'deposit', `manual ${String(tx).slice(0, 120)}`));
  });

  // on Netlify the CDN serves these from dist/ (see scripts/build.js); locally Express does
  if (serveStatic) {
    app.use('/img', express.static(path.join(collectionDir, 'images'), { maxAge: '1d' }));
    app.use('/thumb', express.static(thumbsDir, { maxAge: '1d' }));
    app.use(express.static(path.join(root, 'site')));
  }
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => {
    console.error('http error', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'internal error' });
  });
  return { app, db, deposits, withdrawals, explorer };
}
