// The HTTP app: the MCP endpoint for AI chats, OAuth sign-in, the public preview API, the Helius deposit
// webhook, the manual credit endpoint and (locally) the preview site. Runs as a normal Node server (index.js) or as one Netlify function (lambda.js).
import fs from 'node:fs';
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
import { createExplorer, TX_TYPES } from './explorer.js';
import * as claims from './claims.js';
import * as lp from './launchpad.js';
import { defaultStorage, defaultBackupStore, sniffImage } from './storage.js';
import { runBackup, lastBackup, keyTime, KEY_RE } from './backup.js';
import { bigImage } from './assets.js';

const sameSecret = (given, key) => {
  if (!key || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
};

// the website's own pages: index.html draws them (site/index.html, route()); keep in step with netlify.toml
export const SITE_PAGES = /^\/(market|mint|lost-deposit|collections|connect|explorer|launch|admin|(c|nft|tx|a|u)\/[A-Za-z0-9_-]{1,64})\/?$/;

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
  const storage = opts.storage || await defaultStorage();
  // database backups (backup.js): made every 2 hours by netlify/functions/backup.mjs, downloaded from /admin
  const backups = opts.backupStore || await defaultBackupStore();
  // the market's owner(s), by X account id (it never changes, unlike a handle someone else could take later):
  // they review collections and release payouts. /api/me shows a signed-in account its own id.
  const admins = new Set(String(opts.adminXIds ?? process.env.ADMIN_X_IDS ?? '').split(',').map((h) => h.trim()).filter(Boolean));
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

  const { provider, router: loginRouter, siteUser } = createAuth(db, {
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
  // /img/<id>.png is the full picture (28x28 pixel art at its native size when pixel is true), /thumb/<id>.png 252 px,
  // big: the picture to download, /big/<id>.png (1008 px) for the market's own pixel NFTs, otherwise /img (already full size)
  const bigOf = (n) => (n.pixel && n.collection === m.OWN_COLLECTION ? `/big/${n.id}.png` : `/img/${n.id}.png`);
  const shape = (n) => ({ ...n, price: num(n.price), image: `/img/${n.id}.png`, thumb: `/thumb/${n.id}.png`, big: bigOf(n),
    ...(n.activity ? { activity: n.activity.map((a) => ({ ...a, price: num(a.price) })) } : {}) });
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const intOr = (v, d = null) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : d);
  // an NFT's number: a Postgres int
  const nftIdOr = (v) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);
  // ?trait=Chassis:Bunny&trait=Lid:Beanie
  const traitsOf = (q) => [].concat(q.trait || []).filter((t) => typeof t === 'string').slice(0, 40)
    .map((t) => [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)]).filter(([k, v]) => k && v);
  const nftQuery = (q) => ({
    ...Object.fromEntries(['status', 'sort', 'rarity', 'collection'].map((k) => [k, str(q[k])])),
    traits: traitsOf(q),
    limit: intOr(q.limit, 200),
    offset: intOr(q.offset, 0),
  });
  const colView = ({ id, ...c }) => ({ ...c, mint_price: num(c.mint_price), floor: num(c.floor), volume: num(c.volume),
    trading_open: !c.trade_after_sold_out || c.minted >= c.supply,
    cover: c.cover_nft ? `/img/${c.cover_nft}.png` : `/covers/${c.slug}.png` });
  const isAdmin = (u) => !!u && admins.has(String(u.x_id));
  // a collection that is not public (draft, review, rejected) shows only to its creator and the owner
  const visible = async (req, slug) => {
    const pub = (await m.collections(db, { statuses: ['live', 'paused', 'frozen'] })).find((x) => x.slug === slug);
    if (pub) return pub;
    const u = await siteUser(req);
    if (!u) return null;
    const all = await m.collections(db, { statuses: ['draft', 'review', 'rejected'] });
    const c = all.find((x) => x.slug === slug);
    const [own] = c ? await db.query('select creator_id from collections where id = $1', [c.id]) : [];
    return c && (isAdmin(u) || own?.creator_id === u.id) ? c : null;
  };
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
    const s = await m.stats(db, { collection: str(req.query.collection) });
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({
      ...s, floor: num(s.floor), volume: num(s.volume), mint_price: num(s.mint_price), currency: 'MCP', usd_per_mcp: 1,
      deposits: deposits.enabled ? { network: deposits.cluster === 'mainnet' ? 'solana' : `solana-${deposits.cluster}`, tokens: deposits.tokens.map((t) => t.symbol) } : null,
      mcp_url: mcpUrl.toString(), test_mode: m.CONFIG.testMode,
      withdrawals: withdrawals.enabled ? { network: withdrawals.cluster, form: formInfo() } : null,
    });
  });
  // The mint page (the site's home): progress and the newest mints, polled every few seconds by every open page.
  // One URL for everyone, cached a couple of seconds by the CDN, so the function runs about once per 2 s however
  // many people watch. The browser itself does not cache it.
  const cdn = (res, seconds) => res.set({
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`,
  });
  const feedItem = (n) => ({ ...n, image: `/img/${n.id}.png`, thumb: `/thumb/${n.id}.png` });
  api.get('/mint/live', async (req, res) => {
    const c = (await m.collections(db)).find((x) => x.slug === m.OWN_COLLECTION);
    if (!c) return res.status(404).json({ error: 'not found' });
    const recent = await m.mintFeed(db, { collection: c.slug, limit: 60 });
    cdn(res, 2).json({
      collection: c.slug, name: c.name, supply: c.supply, minted: c.minted, left: c.supply - c.minted,
      mint_price: num(c.mint_price), mint_limit: c.mint_limit, status: c.status, trading_open: colView(c).trading_open,
      recent: recent.map(feedItem),
    });
  });
  // older mints, page by page, for scrolling down the mint page
  api.get('/mint/feed', async (req, res) => {
    const items = await m.mintFeed(db, { collection: m.OWN_COLLECTION, cursor: str(req.query.cursor), limit: intOr(req.query.limit, 48) });
    cdn(res, 5).json(items.map(feedItem));
  });
  api.get('/collections', async (req, res) => res.json((await m.collections(db)).map(colView)));
  api.get('/collections/:slug', async (req, res) => {
    const c = await visible(req, String(req.params.slug).toLowerCase());
    if (!c) return res.status(404).json({ error: 'not found' });
    const full = await m.getCollection(db, c.slug);
    const s = await m.stats(db, { collection: c.slug, anyStatus: true }); // visible() decided who may see it
    // traits: [{type, values: [{value, count, percent}]}], most common first
    const rank = (t) => { const i = (full.trait_order || []).indexOf(t); return i < 0 ? 1e6 : i; };
    const traits = Object.entries(full.traits || {}).sort(([a], [b]) => rank(a) - rank(b)).map(([type, vals]) => ({
      type,
      values: Object.entries(vals).map(([value, count]) => ({ value, count, percent: Math.round((count / full.supply) * 10000) / 100 }))
        .sort((a, b) => b.count - a.count),
    }));
    res.json({ ...colView(c), holders: s.holders, sales: s.sales, traits });
  });
  api.get('/collections/:slug/nfts', async (req, res) => {
    if (!await visible(req, String(req.params.slug).toLowerCase())) return res.status(404).json({ error: 'not found' });
    const q = { ...nftQuery(req.query), collection: String(req.params.slug), anyStatus: true };
    const [items, total] = await Promise.all([m.browse(db, q), m.browseCount(db, q)]);
    res.json({ total, items: items.map(shape) });
  });
  api.get('/nfts', async (req, res) => {
    const owner = str(req.query.owner); // an MCP address
    const q = { ...nftQuery(req.query), ownerAddr: owner && m.isPublicId(owner) ? owner : undefined };
    // ?count=1: how many match in all, for paging
    if (req.query.count === '1') res.set('X-Total-Count', String(await m.browseCount(db, q)));
    res.json((await m.browse(db, q)).map(shape));
  });
  api.get('/nfts/:id', async (req, res) => {
    const id = nftIdOr(req.params.id);
    let n = id != null ? await m.getNft(db, id) : null;
    if (!n && id != null) {
      // an NFT of a collection in review: only for its creator and the owner
      const u = await siteUser(req);
      const hidden = u ? await m.getNft(db, id, { anyStatus: true }) : null;
      if (hidden && (isAdmin(u) || hidden.collection_creator === u.id)) n = hidden;
    }
    if (!n) return res.status(404).json({ error: 'not found' });
    delete n.collection_creator;
    res.json({ ...shape(n), history: n.history.map((h) => ({ ...h, price: num(h.price) })) });
  });
  // ---------- the launchpad (site sessions; every change needs the site's header and origin) ----------
  const siteOrigin = new URL(publicUrl).origin;
  // signed in on the site; changes also need the site's own header and origin, so another site can't make them
  const guard = async (req, res, next) => {
    if (req.method !== 'GET' && (req.get('x-mcp-site') !== '1' || (req.get('origin') && req.get('origin') !== siteOrigin))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.user = await siteUser(req);
    if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
    next();
  };
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ error: e.message });
      throw e;
    }
  };
  const idOf = (req) => nftIdOr(req.params.id) ?? -1;
  const draftView = (c) => ({ ...c, mint_price: num(c.mint_price), traits: undefined, trait_order: undefined });
  api.get('/me', guard, wrap(async (req) => ({ handle: req.user.handle, public_id: req.user.public_id, x_id: req.user.x_id, admin: isAdmin(req.user) })));
  const launch = express.Router();
  launch.use(guard, express.json({ limit: '5mb' }));
  launch.get('/mine', wrap(async (req) => {
    const rows = await db.query(`select c.*, (select count(*)::int from nfts where collection_id = c.id) as uploaded,
      (select count(*)::int from nfts where collection_id = c.id and minted_at is not null) as minted
      from collections c where c.creator_id = $1 order by c.id desc`, [req.user.id]);
    return Promise.all(rows.map(async (c) => ({ ...draftView(c), earnings: await lp.earnings(db, c.id) })));
  }));
  launch.post('/', wrap(async (req) => draftView(await lp.createDraft(db, req.user.id, req.body || {}))));
  launch.patch('/:id', wrap(async (req) => draftView(await lp.updateDraft(db, req.user.id, idOf(req), req.body || {}))));
  launch.post('/:id/items', wrap(async (req) => {
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).map((it) => ({
      ...it, image: Buffer.from(String(it?.image || ''), 'base64'), thumb: Buffer.from(String(it?.thumb || ''), 'base64'),
    }));
    return lp.addItems(db, storage, sniffImage, req.user.id, idOf(req), items);
  }));
  launch.post('/:id/cover', wrap(async (req) => ({ cover_nft: await lp.setCover(db, req.user.id, idOf(req), req.body?.edition) })));
  launch.post('/:id/submit', wrap(async (req) => draftView(await lp.submit(db, req.user.id, idOf(req)))));
  launch.delete('/:id', wrap(async (req) => ({ deleted: await lp.removeCollection(db, storage, req.user.id, idOf(req)) })));
  api.use('/launch', launch);
  // the owner's review queue and money actions
  const admin = express.Router();
  admin.use(guard, express.json({ limit: '16kb' }), (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only the owner of the market can do this.' })));
  admin.get('/collections', wrap(async () => {
    const rows = await db.query(`select c.*, u.handle as creator_handle, u.public_id as creator_addr,
      (select count(*)::int from nfts where collection_id = c.id and minted_at is not null) as minted
      from collections c join users u on u.id = c.creator_id where c.status <> 'draft' order by (c.status = 'review') desc, c.id desc`);
    return Promise.all(rows.map(async (c) => ({ ...draftView(c), earnings: await lp.earnings(db, c.id) })));
  }));
  admin.post('/collections/:id/approve', wrap(async (req) => draftView(await lp.review(db, idOf(req), { approve: true }))));
  admin.post('/collections/:id/reject', wrap(async (req) => draftView(await lp.review(db, idOf(req), { approve: false, note: req.body?.note }))));
  admin.post('/collections/:id/pause', wrap(async (req) => draftView(await lp.setPaused(db, idOf(req), true))));
  admin.post('/collections/:id/resume', wrap(async (req) => draftView(await lp.setPaused(db, idOf(req), false))));
  admin.post('/collections/:id/release', wrap(async (req) => lp.release(db, idOf(req))));
  admin.post('/collections/:id/freeze', wrap(async (req) => lp.freeze(db, idOf(req), req.body?.note)));
  // free MCP NFTs for the team or a giveaway: to the owner's own account, or to the MCP address given
  admin.post('/team-mint', wrap(async (req) => {
    const count = Number(req.body?.count);
    const to = String(req.body?.to || '').trim();
    let userId = req.user.id;
    if (to) {
      if (!m.isPublicId(to)) throw new m.MarketError('That is not an MCP address (mcp_…).');
      const [u] = await db.query('select id from users where public_id = $1', [to]);
      if (!u) throw new m.MarketError(`No account has the address ${to}.`);
      userId = u.id;
    }
    const r = await m.teamMint(db, userId, count);
    const [u] = await db.query('select public_id from users where id = $1', [userId]);
    return { ...r, to: u.public_id };
  }));
  // promo codes: one free MCP per account that types the code in the chat, up to the code's number of uses
  admin.get('/promo', wrap(async () => m.promos(db)));
  const links = (b) => ({ follow_url: typeof b?.follow_url === 'string' ? b.follow_url : undefined, tweet_url: typeof b?.tweet_url === 'string' ? b.tweet_url : undefined });
  admin.post('/promo', wrap(async (req) => m.createPromo(db, { code: req.body?.code, uses: req.body?.uses, ...links(req.body) })));
  admin.post('/promo/:code', wrap(async (req) => m.updatePromo(db, req.params.code, { status: req.body?.status, uses: req.body?.uses, ...links(req.body) })));
  // database backups: the list, one more now, and a download (the file holds every account: owner only)
  admin.get('/backups', wrap(async () => ({
    last: await lastBackup(db),
    items: (await backups.list()).reverse().map((key) => ({ key, at: new Date(keyTime(key)).toISOString() })),
  })));
  admin.post('/backups', wrap(async () => runBackup(db, backups)));
  admin.get('/backups/file', async (req, res) => {
    const key = String(req.query.key || '');
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'bad key' });
    try {
      const data = await backups.get(key);
      if (!data) return res.status(404).json({ error: 'no such backup' });
      res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="mcp-backup-${key.slice(2)}"`, 'Cache-Control': 'no-store' });
      res.send(data);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  admin.get('/deposit-claims', wrap(async (req) => claims.listClaims(db, { status: str(req.query.status) || null })));
  admin.post('/deposit-claims/:id', wrap(async (req) => claims.updateClaim(db, idOf(req), { status: req.body?.status, note: req.body?.note })));
  api.use('/admin', admin);

  // only accounts that chose to show their X handle can be found by it
  api.get('/users/:handle', async (req, res) => {
    const [u] = await db.query('select handle, name, avatar, created_at, public_id from users where handle = $1 and show_handle', [req.params.handle.toLowerCase()]);
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json({ ...u, nfts: (await m.browse(db, { ownerAddr: u.public_id })).map(shape) });
  });
  api.get('/sales', async (req, res) => {
    const rows = await db.query(`select s.nft_id, n.name as nft_name, s.price, s.created_at, ${m.PUBLIC_NAME('se', 'seller')}, ${m.PUBLIC_NAME('b', 'buyer')} from sales s
      join nfts n on n.id = s.nft_id join users se on se.id = s.seller_id join users b on b.id = s.buyer_id order by s.id desc limit 20`);
    res.json(rows.map((r) => ({ ...r, price: num(r.price) })));
  });

  // a lost deposit, reported on the site's /lost-deposit page; no sign-in needed (it is attached if there is one), but
  // the site's header and origin are, and a few reports per hour from one address. The owner checks them in /admin.
  api.post('/deposit-claims', express.json({ limit: '4kb' }), async (req, res) => {
    if (req.get('x-mcp-site') !== '1' || (req.get('origin') && req.get('origin') !== siteOrigin)) return res.status(403).json({ error: 'forbidden' });
    try {
      const u = await siteUser(req).catch(() => null);
      const c = await claims.createClaim(db, { ...(req.body || {}), ip: req.ip, userId: u?.id ?? null });
      res.json({ received: true, id: c.id, duplicate: c.duplicate }); // nothing about how it is going: anyone may know a signature
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  // the explorer: public, read-only. Everything is shown under MCP addresses (see explorer.js).
  const ex = express.Router();
  const addrOk = (a) => a === 'treasury' || a === 'escrow' || m.isPublicId(a);
  // read-only: sealing, anchors, totals and reserves are done by the scheduled run
  ex.get('/summary', async (req, res) => res.json(await explorer.summary()));
  ex.get('/txs', async (req, res) => {
    const addr = str(req.query.addr);
    if (addr && !addrOk(addr)) return res.status(400).json({ error: 'not an MCP address' });
    const type = str(req.query.type);
    if (type && !Object.hasOwn(TX_TYPES, type)) return res.status(400).json({ error: `type: one of ${Object.keys(TX_TYPES).join(', ')}` });
    res.json(await explorer.txs({ before: intOr(req.query.before), addr, limit: intOr(req.query.limit, 30), type: type || null }));
  });
  ex.get('/tx/:id', async (req, res) => {
    const t = intOr(req.params.id) != null ? await explorer.tx(intOr(req.params.id)) : null;
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });
  ex.get('/address/:addr', async (req, res) => {
    const a = addrOk(req.params.addr) ? await explorer.address(req.params.addr) : null;
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json({ ...a, nfts: ['treasury', 'escrow'].includes(a.address) ? [] : (await m.browse(db, { ownerAddr: a.address })).map(shape) });
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
    // the 1008 px pictures: built into dist/big for the CDN, made on the fly here
    app.get(/^\/big\/(\d{1,9})\.png$/, async (req, res, next) => {
      let png;
      try {
        png = bigImage(await fs.promises.readFile(path.join(collectionDir, 'images', `${Number(req.params[0])}.png`)));
      } catch {
        return next();
      }
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(png);
    });
    app.use(express.static(path.join(root, 'site')));
    // the site's pages (/c/mcp, /nft/42, ...) are all index.html; on Netlify netlify.toml does the same
    app.get(SITE_PAGES, (req, res) => res.sendFile(path.join(root, 'site', 'index.html')));
  }
  // pictures of launchpad collections (the market's own come from the CDN, or from the folders above locally)
  app.get(/^\/(img|thumb)\/(\d{1,9})\.png$/, async (req, res) => {
    const [kind, id] = [req.params[0], Number(req.params[1])];
    const [n] = await db.query('select n.edition, c.id as cid, c.status, c.creator_id from nfts n join collections c on c.id = n.collection_id where n.id = $1', [id]);
    if (!n || n.creator_id == null) return res.status(404).json({ error: 'not found' });
    if (n.status === 'frozen') return res.status(410).json({ error: 'this collection was frozen' });
    const isPublic = ['live', 'paused'].includes(n.status);
    if (!isPublic) {
      const u = await siteUser(req);
      if (!u || (u.id !== n.creator_id && !isAdmin(u))) return res.status(404).json({ error: 'not found' });
    }
    const f = await storage.get(`c${n.cid}/${kind}/${n.edition}`);
    if (!f) return res.status(404).json({ error: 'not found' });
    res.set({
      'Content-Type': f.type,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': isPublic ? 'public, max-age=300' : 'private, no-store',
      ...(isPublic ? { 'Netlify-CDN-Cache-Control': 'public, durable, max-age=300', 'Netlify-Cache-Tag': `c${n.cid}` } : {}),
    });
    res.send(f.data);
  });
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => {
    console.error('http error', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'internal error' });
  });
  return { app, db, deposits, withdrawals, explorer };
}
