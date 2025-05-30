// Deposits: every user gets a personal Solana address from the deposit pool (see pool.js). The pool is made
// offline from a seed phrase the server never sees, so this code can watch the addresses and credit deposits
// but can't move funds out of them. We watch each address's USDC and USDT token accounts and credit whatever
// arrives, 1 token = 1 $MCP. Three things look for deposits, and each one is safe to repeat:
//   1. the Helius webhook (POST /hooks/helius) the moment a transaction touches one of our token accounts;
//   2. the deposit tool, when the user asks;
//   3. a scheduled function every few minutes, for anything the first two missed.
// Nothing is credited from what a webhook says: the transaction is always fetched from the chain and checked.
// Each (transaction, token account) pair is credited once, enforced by a unique key in the database.
import crypto from 'node:crypto';
import * as sol from './solana.js';
import { toMicro, tokenToMicro } from './money.js';
import { POOL_KEY, poolRowValid, poolStats, poolLow } from './pool.js';

const WATCH = "interval '2 hours'";  // after someone asks for their address, the scheduled scan checks them often
const RECHECK_MS = 10_000;           // on-demand scans of one token account at most this often (config.recheckMs)
const PAGE = 1000;
const MAX_PAGES = 20;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export class PoolError extends Error {}

export function depositConfig(env = process.env) {
  const testMode = env.TEST_MODE === '1';
  const cluster = String(env.SOLANA_CLUSTER || (testMode ? 'devnet' : 'mainnet')).toLowerCase();
  let tokens = sol.STABLECOINS[cluster] || [];
  if (env.DEPOSIT_TOKENS) {
    // e.g. "USDC:<mint>,USDT:<mint>" to test with your own devnet tokens
    tokens = env.DEPOSIT_TOKENS.split(',').map((pair) => {
      const [symbol, mint] = pair.trim().split(':');
      return { symbol: symbol.toUpperCase(), mint };
    });
  }
  return {
    testMode,
    cluster,
    tokens,
    poolKey: String(env.DEPOSIT_POOL_KEY || '').trim().toLowerCase(),
    heliusKey: env.HELIUS_API_KEY || '',
    rpcUrl: env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? sol.heliusRpcUrl(cluster, env.HELIUS_API_KEY) : ''),
    webhookSecret: env.HELIUS_WEBHOOK_SECRET || '',
    minDeposit: toMicro(env.MIN_DEPOSIT_USD || '0.01'),
    recheckMs: RECHECK_MS,
  };
}

// the password Helius sends with every webhook call, derived from the pool key unless HELIUS_WEBHOOK_SECRET is set
export const webhookSecretFor = (poolKey) => crypto.createHmac('sha256', Buffer.from(poolKey, 'hex')).update('mcp/helius-webhook').digest('hex');

// Why deposits can't run with this configuration, or null when they can.
function problemWith(cfg) {
  if (!['mainnet', 'devnet'].includes(cfg.cluster)) return 'SOLANA_CLUSTER must be mainnet or devnet';
  // free test money and real money must never share one balance
  if (cfg.testMode && cfg.cluster === 'mainnet') return 'TEST_MODE=1 only takes devnet deposits';
  if (!cfg.testMode && cfg.cluster !== 'mainnet') return 'the real server only takes mainnet deposits';
  if (!cfg.poolKey) return 'DEPOSIT_POOL_KEY is not set';
  if (!POOL_KEY.test(cfg.poolKey)) return 'DEPOSIT_POOL_KEY must be the 64-character key printed by deposit-pool.js';
  if (!cfg.rpcUrl) return 'HELIUS_API_KEY (or SOLANA_RPC_URL) is not set';
  if (!cfg.tokens.length || !cfg.tokens.every((t) => /^[A-Z]{2,10}$/.test(t.symbol) && sol.isAddress(t.mint))) return 'bad token list';
  return null;
}

export function createDeposits(db, opts = {}) {
  const cfg = opts.config || depositConfig();
  const log = opts.log || ((...a) => console.error('[deposits]', ...a));
  const publicUrl = String(opts.publicUrl || process.env.PUBLIC_URL || process.env.URL || '').replace(/\/$/, '');
  const webhookUrl = publicUrl ? `${publicUrl}/hooks/helius` : '';
  const mints = new Map(cfg.tokens.map((t) => [t.mint, t]));
  const mintList = [...mints.keys()];

  const problem = problemWith(cfg);
  if (problem && (cfg.poolKey || cfg.heliusKey)) log('deposits are off:', problem);
  const enabled = !problem;
  const network = cfg.cluster;
  // the webhook password: set explicitly, or derived from the pool key so there is one secret less to manage
  const webhookSecret = cfg.webhookSecret || (enabled ? webhookSecretFor(cfg.poolKey) : '');
  const rpc = enabled ? (opts.rpc || sol.makeRpc(cfg.rpcUrl)) : null;
  const helius = enabled ? (opts.helius || (cfg.heliusKey ? sol.makeHeliusApi(cfg.heliusKey) : null)) : null;
  const valid = (row) => poolRowValid(cfg.poolKey, row);

  // the user's pool row on this network, or null; never a row that fails its HMAC
  async function poolRowOf(userId, q = db.query) {
    const [row] = await q('select network, idx, address, mac from deposit_pool where network = $1 and user_id = $2', [network, userId]);
    if (!row) return null;
    if (!valid(row)) {
      log(`ALERT: deposit_pool row ${network}#${row.idx} (user ${userId}) fails its HMAC: the database was changed outside the app`);
      throw new PoolError('deposit address failed verification');
    }
    return row;
  }

  // gives the user the next free pool address, once
  async function assign(userId) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await db.tx(async (t) => {
          const mine = await poolRowOf(userId, t.query);
          if (mine) return mine;
          const [free] = await t.query(`select network, idx, address, mac from deposit_pool where network = $1 and user_id is null
            order by idx limit 1 for update skip locked`, [network]);
          if (!free) throw new PoolError('the deposit address pool is empty');
          if (!valid(free)) {
            // moved aside (kept for investigation) so it is never handed out
            log(`ALERT: deposit_pool row ${network}#${free.idx} fails its HMAC and was set aside: the database was changed outside the app`);
            await t.query("update deposit_pool set network = 'rejected-' || network where network = $1 and idx = $2", [network, free.idx]);
            return null;
          }
          await t.query('update deposit_pool set user_id = $1, assigned_at = now() where network = $2 and idx = $3', [userId, network, free.idx]);
          return free;
        });
        if (row) return row;
      } catch (e) {
        if (e.code !== '23505') throw e; // two requests for one user at once: the other one won, read it
      }
    }
    const row = await poolRowOf(userId);
    if (!row) throw new PoolError('could not assign a deposit address');
    return row;
  }

  // ---------- crediting ----------

  // one positive balance change of one of our token accounts in one confirmed transaction
  async function record({ userId, signature, token, tokenAccount, micro, slot }) {
    return db.tx(async (t) => {
      // support already credited this transaction to this user by hand (POST /admin/deposit with its signature)
      const manual = (await t.query("select 1 from ledger where kind = 'deposit' and ref = $1 and user_id = $2", [`manual ${signature}`, userId])).length;
      const status = manual ? 'manual' : micro >= BigInt(cfg.minDeposit) ? 'credited' : 'too_small';
      const ins = await t.query(
        `insert into deposits (user_id, signature, token, token_account, amount, slot, status) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (signature, token_account) do nothing returning id`,
        [userId, signature, token, tokenAccount, String(micro), slot ?? null, status]);
      if (!ins.length) return null; // already handled
      if (status === 'credited') {
        await t.query('update users set balance = balance + $1 where id = $2', [String(micro), userId]);
        await t.query("insert into ledger (user_id, delta, kind, ref) values ($1, $2, 'deposit', $3)", [userId, String(micro), `${token} ${signature} ${tokenAccount}`]);
      }
      return { userId, token, amount: Number(micro), signature, status };
    });
  }

  // A transaction as returned by getTransaction (encoding json). Credits every one of our token accounts
  // whose stablecoin balance went up in it.
  async function processTx(tx, signature) {
    if (!tx?.meta || tx.meta.err) return [];
    const keys = [
      ...(tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey)),
      ...(tx.meta.loadedAddresses?.writable || []),
      ...(tx.meta.loadedAddresses?.readonly || []),
    ];
    const pre = new Map((tx.meta.preTokenBalances || []).map((b) => [b.accountIndex, b]));
    // money moving between our own addresses (the owner's sweep, by mistake into a pool address) is not a deposit
    const post = new Map((tx.meta.postTokenBalances || []).map((b) => [b.accountIndex, b]));
    const senders = [...pre.values()].filter((b) => mints.has(b.mint) && BigInt(b.uiTokenAmount?.amount ?? '0') > BigInt(post.get(b.accountIndex)?.uiTokenAmount?.amount ?? '0'))
      .map((b) => b.owner).filter(Boolean);
    const ownSenders = senders.length ? await db.query('select network, idx, address, mac from deposit_pool where address = any($1) and network = $2', [senders, network]) : [];
    if (ownSenders.some(valid)) {
      log('not credited: a transfer out of one of our own pool addresses', signature);
      return [];
    }
    const changes = [];
    for (const b of tx.meta.postTokenBalances || []) {
      const token = mints.get(b.mint);
      const address = keys[b.accountIndex];
      if (!token || !address) continue;
      const before = pre.get(b.accountIndex);
      if (before && before.mint !== b.mint) continue;
      const delta = BigInt(b.uiTokenAmount?.amount ?? '0') - BigInt(before?.uiTokenAmount?.amount ?? '0');
      if (delta <= 0n) continue;
      changes.push({ address, owner: b.owner, token, micro: tokenToMicro(delta, Number(b.uiTokenAmount.decimals)) });
    }
    if (!changes.length) return [];
    const ours = await db.query(
      `select d.address, d.user_id, d.mint, p.network, p.idx, p.address as wallet, p.mac, p.user_id as pool_user
       from deposit_accounts d join deposit_pool p on p.address = d.wallet and p.network = $2
       where d.address = any($1)`, [changes.map((c) => c.address), network]);
    const out = [];
    for (const c of changes) {
      const acct = ours.find((r) => r.address === c.address && r.mint === c.token.mint);
      if (!acct) continue;
      // the token account must belong to the user's own, verified pool address
      const okWallet = valid({ network: acct.network, idx: acct.idx, address: acct.wallet, mac: acct.mac }) && acct.pool_user === acct.user_id
        && c.address === sol.associatedTokenAddress(acct.wallet, c.token.mint);
      if (!okWallet || (c.owner && c.owner !== acct.wallet)) {
        log('not credited: token account does not match a verified pool address', signature, c.address);
        continue;
      }
      const r = await record({ userId: acct.user_id, signature, token: c.token.symbol, tokenAccount: c.address, micro: c.micro, slot: tx.slot });
      if (r) out.push(r);
    }
    return out;
  }

  const getTx = (signature) => rpc('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }]);

  // Every new transaction of one token account since the last scan, oldest first. The cursor only moves
  // past transactions that were handled, so a transaction the node can't show yet is retried next time.
  async function scanAccount(a) {
    const sigs = [];
    let before;
    for (let page = 0; page < MAX_PAGES; page++) {
      const opt = { limit: PAGE, commitment: 'confirmed' };
      if (a.cursor) opt.until = a.cursor;
      if (before) opt.before = before;
      const batch = await rpc('getSignaturesForAddress', [a.address, opt]);
      sigs.push(...batch);
      if (batch.length < PAGE) break;
      before = batch[batch.length - 1].signature;
      if (page === MAX_PAGES - 1) log('more than', PAGE * MAX_PAGES, 'new transactions on', a.address, '- older ones need a manual rescan');
    }
    const credited = [];
    let cursor = a.cursor;
    for (const s of sigs.reverse()) {
      if (!s.err) {
        const tx = await getTx(s.signature);
        if (!tx) break;
        credited.push(...await processTx(tx, s.signature));
      }
      cursor = s.signature;
    }
    await db.query('update deposit_accounts set cursor = $1, checked_at = now() where address = $2', [cursor, a.address]);
    return credited;
  }

  async function scanUser(userId, { force = false } = {}) {
    const accts = await db.query('select * from deposit_accounts where user_id = $1 and mint = any($2) order by token', [userId, mintList]);
    const credited = [];
    let error = null;
    for (const a of accts) {
      if (!force && a.checked_at && Date.now() - new Date(a.checked_at).getTime() < (cfg.recheckMs ?? RECHECK_MS)) continue;
      try {
        credited.push(...await scanAccount(a));
      } catch (e) {
        error = e.message;
        log('scan failed', a.address, e.message);
      }
    }
    return { credited, error };
  }

  // ---------- Helius webhook ----------

  // Keeps one Helius webhook pointed at /hooks/helius, watching all our token accounts. The settings are
  // remembered in app_meta, so the webhook is only rewritten when the address list changes (each edit
  // costs Helius credits), plus a check every 6 hours that it is still there and switched on.
  async function syncWebhook({ create = true } = {}) {
    if (!enabled) return 'deposits off';
    if (!helius) return 'no Helius key';
    if (!webhookUrl.startsWith('https://')) return 'PUBLIC_URL is not https';
    const rows = await db.query('select address from deposit_accounts where mint = any($1) order by address', [mintList]);
    if (!rows.length) return 'no addresses yet';
    const want = {
      webhookURL: webhookUrl,
      transactionTypes: ['ANY'],
      accountAddresses: rows.map((r) => r.address),
      webhookType: cfg.cluster === 'mainnet' ? 'raw' : 'rawDevnet',
      authHeader: webhookSecret,
      txnStatus: 'success',
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(want)).digest('hex').slice(0, 16);
    const [meta] = await db.query("select value from app_meta where key = 'helius_webhook'");
    const state = meta ? JSON.parse(meta.value) : {};
    const save = (s) => db.query("insert into app_meta (key, value) values ('helius_webhook', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(s)]);
    const fresh = state.checkedAt && Date.now() - state.checkedAt < 6 * 3600e3;
    if (state.id && state.hash === hash && fresh) return 'up to date';

    let id = state.id;
    if (!id) {
      if (!create) return 'not created yet';
      const all = await helius.list();
      id = (Array.isArray(all) ? all : []).find((w) => w.webhookURL === webhookUrl)?.webhookID;
      if (!id) {
        const made = await helius.create(want);
        await save({ id: made.webhookID, hash, checkedAt: Date.now(), addresses: rows.length });
        return `created, ${rows.length} addresses`;
      }
    }
    try {
      if (!fresh) {
        const w = await helius.get(id);
        if (w && w.active === false && helius.activate) await helius.activate(id);
      }
      await helius.update(id, want);
    } catch (e) {
      if (e.status === 404) {
        await save({}); // deleted on the Helius side: make a new one next time
        return 'webhook was deleted, will recreate';
      }
      throw e;
    }
    await save({ id, hash, checkedAt: Date.now(), addresses: rows.length });
    return `updated, ${rows.length} addresses`;
  }

  // POST /hooks/helius. The payload only tells us WHICH transactions to look at.
  async function handleWebhook(body) {
    const items = (Array.isArray(body) ? body : [body]).slice(0, 100);
    const perItem = items.map((it) => {
      const sig = it?.transaction?.signatures?.[0] ?? it?.signature;
      const addrs = new Set();
      for (const k of it?.transaction?.message?.accountKeys || []) addrs.add(typeof k === 'string' ? k : k?.pubkey);
      for (const k of [...(it?.meta?.loadedAddresses?.writable || []), ...(it?.meta?.loadedAddresses?.readonly || [])]) addrs.add(k);
      for (const a of it?.accountData || []) addrs.add(a?.account); // "enhanced" webhook format
      addrs.delete(undefined);
      return { sig: typeof sig === 'string' && SIG.test(sig) ? sig : null, addrs: [...addrs].filter((a) => typeof a === 'string') };
    }).filter((x) => x.sig);
    const all = [...new Set(perItem.flatMap((x) => x.addrs))];
    const ours = all.length ? await db.query('select address, user_id from deposit_accounts where address = any($1)', [all]) : [];
    const ourSet = new Set(ours.map((r) => r.address));
    if (ours.length) {
      await db.query(`update users set deposit_watch_until = now() + ${WATCH} where id = any($1)`, [[...new Set(ours.map((r) => r.user_id))]]);
    }
    // payloads without account lists: check every signature (bounded)
    const toCheck = perItem.filter((x) => !x.addrs.length || x.addrs.some((a) => ourSet.has(a))).slice(0, 10);
    const credited = [];
    for (const { sig } of toCheck) {
      try {
        credited.push(...await processTx(await getTx(sig), sig));
      } catch (e) {
        log('webhook check failed', sig, e.message); // the scheduled scan will pick it up
      }
    }
    return { received: items.length, checked: toCheck.length, credited: credited.length };
  }

  // ---------- public ----------

  return {
    enabled,
    problem,
    cluster: cfg.cluster,
    tokens: cfg.tokens,
    minDeposit: cfg.minDeposit,
    webhookSecret,
    webhookUrl,

    // The user's deposit address from the pool and its token accounts, assigned on first use.
    async wallet(userId) {
      if (!enabled) throw new PoolError(`deposits are off: ${problem}`);
      const row = await assign(userId);
      let added = 0;
      const accounts = [];
      for (const t of cfg.tokens) {
        const address = sol.associatedTokenAddress(row.address, t.mint);
        const r = await db.query(
          'insert into deposit_accounts (address, user_id, wallet, token, mint) values ($1, $2, $3, $4, $5) on conflict (address) do nothing returning address',
          [address, userId, row.address, t.symbol, t.mint]);
        added += r.length;
        accounts.push({ token: t.symbol, mint: t.mint, address });
      }
      await db.query(`update users set deposit_watch_until = now() + ${WATCH} where id = $1`, [userId]);
      // new addresses: add them to the existing webhook right away (the scheduled scan covers them meanwhile)
      if (added && helius) {
        await Promise.race([syncWebhook({ create: false }), new Promise((r) => setTimeout(r, 4000))])
          .catch((e) => log('webhook sync failed', e.message));
      }
      if (added) {
        const st = await poolStats(db, network);
        if (poolLow(st)) log(`deposit pool for ${network} is running low: ${st.free} of ${st.total} addresses left`);
      }
      return { address: row.address, accounts };
    },

    // the address already handed to this user, if any (for the account overview)
    async currentAddress(userId) {
      if (!enabled) return null;
      return (await poolRowOf(userId).catch(() => null))?.address ?? null;
    },

    // Looks for new deposits of one user right now (throttled) and returns what got credited.
    check: (userId) => scanUser(userId),

    async recent(userId, limit = 3) {
      return db.query(`select token, amount, signature, status, created_at from deposits where user_id = $1
        and created_at > now() - interval '1 day' order by id desc limit $2`, [userId, limit]);
    },

    handleWebhook,
    syncWebhook,
    processTx,
    scanUser,

    // The scheduled run: keep the webhook in sync, then scan users who are expecting a deposit plus a few
    // others in rotation, so nothing stays uncredited even if every webhook call was lost.
    async tick({ budgetMs = 20_000, rotate = 6 } = {}) {
      const started = Date.now();
      const res = { webhook: null, scanned: 0, credited: 0, errors: [], pool: null };
      if (!enabled) return { ...res, webhook: 'deposits off' };
      res.pool = await poolStats(db, network);
      if (poolLow(res.pool)) res.errors.push(`deposit pool low: ${res.pool.free} free addresses left`);
      try {
        res.webhook = await syncWebhook();
      } catch (e) {
        res.errors.push(`webhook: ${e.message}`);
      }
      const watched = await db.query(`select distinct d.user_id from deposit_accounts d join users u on u.id = d.user_id
        where u.deposit_watch_until > now() and d.mint = any($1) limit 50`, [mintList]);
      const stale = await db.query(`select user_id from deposit_accounts where mint = any($1)
        group by user_id order by min(coalesce(checked_at, 'epoch'::timestamptz)) limit $2`, [mintList, rotate]);
      const ids = [...new Set([...watched, ...stale].map((r) => r.user_id))];
      let i = 0;
      const worker = async () => {
        while (i < ids.length && Date.now() - started < budgetMs) {
          const r = await scanUser(ids[i++], { force: true });
          res.scanned++;
          res.credited += r.credited.length;
          if (r.error) res.errors.push(r.error);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return res;
    },
  };
}
