// The public explorer: every balance change in the market, under public MCP addresses, chained so history
// can't be rewritten unnoticed, anchored on Solana, plus proof of reserves.
//
// Chain: every ledger row gets seq (1, 2, 3, ...) and hash = sha256(entryText(previous hash, row)). Rows are
// sealed in the background, in the order they are seen committed. Every so often the newest hash is written
// to Solana from the payout wallet as the memo "mcp:anchor:<network>:<seq>:<hash>". Anyone can download the
// chain (/api/explorer/chain), recompute every hash and compare with those memos: a changed, removed or
// inserted row breaks every hash after it, and the hashes already on Solana can't be changed.
//
// Reserves: what users are owed (balances plus withdrawals not paid yet) next to the USDC/USDT actually held
// on Solana by the deposit addresses, the payout wallet and the owner's declared reserve wallets.
import crypto from 'node:crypto';
import * as sol from './solana.js';
import { depositConfig } from './deposits.js';
import { explorerTx } from './withdrawals.js';
import { ensurePublicIds, nftName } from './market.js';
import { isEscrowKind, ESCROW_KINDS } from './launchpad.js';

export const GENESIS = '0'.repeat(64);
const SEAL_LOCK = 727274010;
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// what the public sees of a row's reference. Support references of manual credits are free text: only a digest.
export function publicRef(kind, ref) {
  if (ref == null) return '';
  const r = String(ref);
  if (r.startsWith('manual')) return `manual:${sha256(r).slice(0, 16)}`;
  return r;
}

// The exact text hashed for a row. The explorer page recomputes it the same way, field by field:
// previous hash, seq, row id, account (MCP address or "treasury"), delta in micro-$MCP, kind, public ref, time.
export const entryText = (prev, e) => [prev, e.seq, e.id, e.account, e.delta, e.kind, e.ref, e.at].join('\n');
export const entryHash = (prev, e) => sha256(entryText(prev, e));

// a ledger row (joined with its account's public_id) as the public sees it and as it is hashed
export const ledgerEntry = (r) => ({
  seq: r.seq == null ? null : Number(r.seq),
  id: Number(r.id),
  // the market's two accounts: the escrow (launchpad mint money on hold) and the treasury (everything else)
  account: r.user_id == null ? (isEscrowKind(r.kind) ? 'escrow' : 'treasury') : r.public_id,
  delta: String(r.delta),
  kind: r.kind,
  ref: publicRef(r.kind, r.ref),
  at: new Date(r.created_at).toISOString(),
  hash: r.hash || null,
});

export function explorerConfig(env = process.env) {
  return {
    anchorEveryMs: Number(env.ANCHOR_EVERY_MINUTES || 60) * 60e3,
    anchorsOff: env.ANCHORS_OFF === '1',
    reservesEveryMs: Number(env.RESERVES_EVERY_MINUTES || 10) * 60e3,
    // the owner's cold wallets that hold swept deposits, so they count as reserves (public addresses)
    reserveWallets: String(env.RESERVE_WALLETS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const KINDS = { deposit: 'deposit', faucet: 'faucet', mint: 'mint', team_mint: 'team mint', free_mint: 'free mint', buy: 'buy', withdraw: 'withdrawal', withdraw_refund: 'refund', payout: 'payout', mint_refund: 'refund' };
const ESCROW_SQL = `(${ESCROW_KINDS.map((k) => `'${k}'`).join(', ')})`;

export function createExplorer(db, opts = {}) {
  const cfg = { ...explorerConfig(), ...(opts.config || {}) };
  const log = opts.log || ((...a) => console.error('[explorer]', ...a));
  const { deposits, withdrawals } = opts;
  const network = withdrawals?.cluster || deposits?.cluster || 'mainnet';
  const tokens = deposits?.tokens?.length ? deposits.tokens : sol.STABLECOINS[network] || [];
  const rpcUrl = depositConfig().rpcUrl;
  const rpc = opts.rpc || (rpcUrl ? sol.makeRpc(rpcUrl) : null);
  const reserveWallets = cfg.reserveWallets.filter((w) => {
    if (sol.isAddress(w)) return true;
    log(`RESERVE_WALLETS: "${w}" is not a Solana address, ignored`);
    return false;
  });
  const txUrl = (sig) => explorerTx(sig, network);

  const entry = ledgerEntry;
  const ROW = `select l.id, l.user_id, l.delta, l.kind, l.ref, l.created_at, l.xact, l.seq, l.hash, u.public_id,
    case when u.show_handle then u.handle end as name from ledger l left join users u on u.id = l.user_id`;

  // ---------- sealing ----------

  async function seal({ max = 2000 } = {}) {
    await ensurePublicIds(db);
    return db.tx(async (t) => {
      const [{ ok }] = await t.query(`select pg_try_advisory_xact_lock(${SEAL_LOCK}) as ok`);
      if (!ok) return { sealed: 0, busy: true };
      const [head] = await t.query('select seq, hash from ledger where seq is not null order by seq desc limit 1');
      let seq = Number(head?.seq || 0);
      let prev = head?.hash || GENESIS;
      const rows = await t.query(`${ROW} where l.seq is null order by l.id limit $1`, [max]);
      const ids = [];
      const seqs = [];
      const hashes = [];
      for (const r of rows) {
        if (r.user_id != null && !r.public_id) throw new Error(`account ${r.user_id} has no MCP address`);
        seq += 1;
        const hash = entryHash(prev, entry({ ...r, seq }));
        ids.push(String(r.id));
        seqs.push(String(seq));
        hashes.push(hash);
        prev = hash;
      }
      if (ids.length) {
        // one statement for the whole batch
        const done = await t.query(`update ledger l set seq = v.seq, hash = v.hash
          from unnest($1::bigint[], $2::bigint[], $3::text[]) as v(id, seq, hash) where l.id = v.id and l.seq is null returning l.id`, [ids, seqs, hashes]);
        if (done.length !== ids.length) throw new Error('ledger changed while sealing: nothing sealed');
      }
      return { sealed: rows.length, head: seq };
    });
  }

  // ---------- anchors on Solana ----------

  async function anchor({ force = false } = {}) {
    if (cfg.anchorsOff) return { skipped: 'anchors are off' };
    if (!withdrawals?.enabled || !withdrawals.sendMemo) return { skipped: 'no payout wallet' };
    if (withdrawals.config?.paused) return { skipped: 'payouts are paused: the payout wallet signs nothing' };
    const [head] = await db.query('select seq, hash from ledger where seq is not null order by seq desc limit 1');
    if (!head) return { skipped: 'nothing sealed yet' };
    const [last] = await db.query("select seq, created_at from chain_anchors where network = $1 and status <> 'dropped' order by id desc limit 1", [network]);
    if (last && Number(last.seq) >= Number(head.seq)) return { skipped: 'up to date' };
    if (!force && last && Date.now() - new Date(last.created_at).getTime() < cfg.anchorEveryMs) return { skipped: 'not due' };
    const text = `mcp:anchor:${network}:${head.seq}:${head.hash}`;
    const r = await withdrawals.sendMemo(text, (signature, lastValid) => db.query(
      'insert into chain_anchors (network, seq, hash, signature, last_valid_height) values ($1, $2, $3, $4, $5)',
      [network, head.seq, head.hash, signature, lastValid]));
    return r.skipped ? { skipped: r.skipped } : { anchored: Number(head.seq), signature: r.signature };
  }

  async function confirmAnchors() {
    if (!withdrawals?.chainStatus) return 0;
    const open = await db.query("select id, signature, last_valid_height from chain_anchors where network = $1 and status in ('sent', 'confirmed') order by id limit 50", [network]);
    if (!open.length) return 0;
    const { statuses, finalizedHeight, current } = await withdrawals.chainStatus(open.map((a) => a.signature));
    let changed = 0;
    for (let i = 0; i < open.length; i++) {
      const st = statuses[i];
      let status = null;
      if (st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus)) status = st.confirmationStatus;
      else if (st?.err && st.confirmationStatus === 'finalized') status = 'dropped';
      else if (!st && current && finalizedHeight > Number(open[i].last_valid_height) + 150) status = 'dropped';
      if (!status) continue;
      const r = await db.query(`update chain_anchors set status = $2, confirmed_at = case when $2 = 'dropped' then null else coalesce(confirmed_at, now()) end
        where id = $1 and status <> $2 returning id`, [open[i].id, status]);
      changed += r.length;
    }
    return changed;
  }

  // ---------- proof of reserves ----------

  // owed to users from the ledger (what the chain covers); users.balance must say the same
  async function owed() {
    const [r] = await db.query(`select
      (select coalesce(sum(delta), 0)::bigint from ledger where user_id is not null) as balances,
      (select coalesce(sum(balance), 0)::bigint from users) as user_balances,
      (select coalesce(sum(case when status = 'rejected' then amount + fee else amount end), 0)::bigint from withdrawals
        where network = $1 and status in ('review', 'pending', 'sending', 'rejected')) as withdrawals,
      (select coalesce(sum(delta), 0)::bigint from ledger where user_id is null and kind not in ${ESCROW_SQL}) as treasury,
      (select coalesce(sum(delta), 0)::bigint from ledger where user_id is null and kind in ${ESCROW_SQL}) as escrow,
      (select coalesce(sum(amount), 0)::bigint from mint_holds where released_at is null and refunded_at is null) as holds`, [network]);
    return { balances: BigInt(r.balances), userBalances: BigInt(r.user_balances), withdrawals: BigInt(r.withdrawals), treasury: BigInt(r.treasury),
      escrow: BigInt(r.escrow), holds: BigInt(r.holds) };
  }

  async function reserves() {
    if (!rpc) return { skipped: 'no Solana RPC' };
    const accounts = [];
    const dep = await db.query('select address, wallet, token, mint from deposit_accounts where mint = any($1) order by address', [tokens.map((t) => t.mint)]);
    for (const d of dep) accounts.push({ kind: 'deposit', wallet: d.wallet, token: d.token, mint: d.mint, address: d.address });
    // a wallet counts once: a reserve wallet that is also the payout wallet or a deposit address is ignored
    const depWallets = new Set(dep.map((d) => d.wallet));
    const wallets = withdrawals?.hotWallet ? [{ kind: 'payout', wallet: withdrawals.hotWallet }] : [];
    for (const w of reserveWallets) {
      if (w === withdrawals?.hotWallet || depWallets.has(w) || wallets.some((x) => x.wallet === w)) log(`RESERVE_WALLETS: ${w} is already counted, ignored`);
      else wallets.push({ kind: 'reserve', wallet: w });
    }
    for (const w of wallets) {
      for (const t of tokens) accounts.push({ kind: w.kind, wallet: w.wallet, token: t.symbol, mint: t.mint, address: sol.associatedTokenAddress(w.wallet, t.mint) });
    }
    const seen = new Set();
    for (let i = accounts.length - 1; i >= 0; i--) {
      if (seen.has(accounts[i].address)) accounts.splice(i, 1);
      else seen.add(accounts[i].address);
    }
    for (let i = 0; i < accounts.length; i += 100) {
      const chunk = accounts.slice(i, i + 100);
      const res = await rpc('getMultipleAccounts', [chunk.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      (res?.value || []).forEach((v, j) => {
        const info = v?.data?.parsed?.info;
        const a = chunk[j];
        // only a real token account of the expected mint, owned by the expected wallet, counts
        a.amount = info && info.mint === a.mint && info.owner === a.wallet ? BigInt(info.tokenAmount?.amount || 0) : 0n;
      });
    }
    const held = {};
    for (const t of tokens) held[t.symbol] = 0n;
    for (const a of accounts) held[a.token] += a.amount || 0n;
    const total = Object.values(held).reduce((x, y) => x + y, 0n);
    const o = await owed();
    // mint money held for creators is owed too: to the creator, or back to the minters
    const owedTotal = o.balances + o.withdrawals + o.escrow;
    const snap = {
      at: new Date().toISOString(),
      network,
      held: Object.fromEntries(Object.entries(held).map(([k, v]) => [k, String(v)])),
      held_total: String(total),
      owed_balances: String(o.balances),
      owed_withdrawals: String(o.withdrawals),
      owed_escrow: String(o.escrow),
      escrow_matches: o.escrow === o.holds,
      owed_total: String(owedTotal),
      // the balances on users must equal the ledger; if not, the snapshot says so
      ledger_matches: o.balances === o.userBalances,
      treasury: String(o.treasury),
      // held per $1 owed (1 = fully backed)
      coverage: owedTotal > 0n ? Number((total * 10000n) / owedTotal) / 10000 : null,
      accounts: accounts.filter((a) => a.kind !== 'deposit' || a.amount > 0n)
        .map((a) => ({ kind: a.kind, wallet: a.wallet, token: a.token, token_account: a.address, amount: String(a.amount || 0n) })),
      deposit_wallets: depWallets.size,
    };
    if (!snap.ledger_matches) log(`ALERT: user balances (${o.userBalances}) do not match the ledger (${o.balances})`);
    if (!snap.escrow_matches) log(`ALERT: the escrow in the ledger (${o.escrow}) does not match the open mint holds (${o.holds})`);
    await db.query("insert into app_meta (key, value) values ('reserves', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(snap)]);
    return { held: snap.held_total, owed: snap.owed_total, coverage: snap.coverage };
  }

  async function lastReserves() {
    const [r] = await db.query("select value from app_meta where key = 'reserves'");
    return r ? JSON.parse(r.value) : null;
  }

  // ---------- the scheduled run ----------

  async function tick({ budgetMs = 6000 } = {}) {
    const started = Date.now();
    const out = { errors: [] };
    const step = async (name, fn) => {
      try {
        out[name] = await fn();
      } catch (e) {
        out.errors.push(`${name}: ${e.message}`);
      }
    };
    await step('seal', () => seal());
    await step('confirmed', () => confirmAnchors());
    await step('anchor', () => anchor());
    await step('stats', () => refreshStats());
    const last = await lastReserves().catch(() => null);
    if (Date.now() - started < budgetMs && (!last || Date.now() - new Date(last.at).getTime() >= cfg.reservesEveryMs)) await step('reserves', () => reserves());
    return out;
  }

  // ---------- read side (the public API) ----------

  const typeOf = (kinds) => {
    for (const k of ['deposit', 'withdraw', 'withdraw_refund', 'mint_refund', 'payout', 'buy', 'mint', 'team_mint', 'free_mint', 'faucet']) if (kinds.includes(k)) return KINDS[k];
    return kinds[0] || 'other';
  };

  async function decorate(rows) {
    const byX = new Map();
    for (const r of rows) {
      if (!byX.has(String(r.xact))) byX.set(String(r.xact), []);
      byX.get(String(r.xact)).push(r);
    }
    const wIds = [...new Set(rows.filter((r) => /^w\d+$/.test(r.ref || '')).map((r) => Number(r.ref.slice(1))))];
    const ws = wIds.length ? await db.query('select id, status, tx from withdrawals where id = any($1)', [wIds]) : [];
    const wById = new Map(ws.map((w) => [Number(w.id), w]));
    // NFT rows (mints, buys) carry the NFT's number: its name, picture and collection for the page
    const nIds = [...new Set(rows.filter((r) => ['mint', 'team_mint', 'free_mint', 'buy', 'mint_refund'].includes(r.kind) && /^\d{1,9}$/.test(r.ref || '')).map((r) => Number(r.ref)))];
    // payouts carry "c<collection id>"
    const cIds = [...new Set(rows.filter((r) => /^c\d{1,9}$/.test(r.ref || '')).map((r) => Number(r.ref.slice(1))))];
    const cs = cIds.length ? await db.query('select id, slug, name from collections where id = any($1)', [cIds]) : [];
    const cById = new Map(cs.map((c) => [Number(c.id), { slug: c.slug, name: c.name }]));
    const ns = nIds.length ? await db.query(`select n.id, n.name, n.rarity, n.pixel, c.slug, c.name as collection_name
      from nfts n join collections c on c.id = n.collection_id where n.id = any($1)`, [nIds]) : [];
    const nById = new Map(ns.map((n) => [Number(n.id), n]));
    return [...byX.values()].map((g) => {
      const kinds = g.map((r) => r.kind);
      const type = typeOf(kinds);
      const t = {
        id: Math.min(...g.map((r) => Number(r.id))),
        at: new Date(g[0].created_at).toISOString(),
        type,
        sealed: g.every((r) => r.seq != null),
        entries: g.map((r) => ({ ...entry(r), name: r.name || null, amount: Number(r.delta) / 1e6 })),
      };
      const ref = g[0].ref || '';
      if (ref.startsWith('manual')) {
        t.manual = true; // credited by support: its reference is not published
      } else if (type === 'deposit') {
        const m = /^(\w+) ([1-9A-HJ-NP-Za-km-z]{64,90})\b/.exec(ref);
        if (m) t.solana = { token: m[1], tx: m[2], url: txUrl(m[2]) };
      } else if (/^w\d+$/.test(ref)) {
        const w = wById.get(Number(ref.slice(1)));
        t.withdrawal = { id: Number(ref.slice(1)), status: w?.status || null };
        if (w?.tx && ['sending', 'sent'].includes(w.status)) t.solana = { token: 'USDC', tx: w.tx, url: txUrl(w.tx) };
      } else if (/^c\d+$/.test(ref)) {
        t.collection = cById.get(Number(ref.slice(1))) || null;
      }
      if (kinds.filter((k) => k === 'mint_refund').length > 1) {
        // a freeze: every refunded mint of the collection in one transaction
        t.refunds = g.filter((r) => r.kind === 'mint_refund').length;
        t.refunded = g.filter((r) => r.kind === 'mint_refund').reduce((s, r) => s + Number(r.delta), 0) / 1e6;
      } else if (type === KINDS.team_mint) {
        // the owner's free mint: up to a chunk of NFTs to one account, all in one transaction
        const team = g.filter((r) => r.kind === 'team_mint');
        t.team = { count: team.length, account: team[0].public_id || null, name: team[0].name || null };
        const n = nById.get(Number(team[0].ref));
        if (n) t.nft = { id: Number(team[0].ref), name: n.name, rarity: n.rarity, collection: n.slug, collection_name: n.collection_name,
          image: `/img/${Number(team[0].ref)}.png`, thumb: `/thumb/${Number(team[0].ref)}.png`, pixel: n.pixel };
      } else if (/^\d+$/.test(ref) && ['mint', 'free mint', 'buy', 'refund'].includes(type)) {
        const n = nById.get(Number(ref));
        t.nft = n ? { id: Number(ref), name: n.name, rarity: n.rarity, collection: n.slug, collection_name: n.collection_name,
          image: `/img/${Number(ref)}.png`, thumb: `/thumb/${Number(ref)}.png`, pixel: n.pixel } : { id: Number(ref), name: nftName(ref) };
      }
      return t;
    }).sort((a, b) => b.id - a.id);
  }

  async function txs({ before = null, addr = null, limit = 30 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
    // addr: only transactions touching that MCP address ("treasury": the market's own rows)
    // The newest rows by id (index), then their whole transactions. A transaction's rows have neighbouring ids,
    // so a window of 4 rows per transaction is usually plenty. A big transaction (a team mint has 50 rows) can fill
    // the window: then it is widened until the page is full or the window reaches the end of the ledger.
    let userId = null;
    if (addr && addr !== 'treasury' && addr !== 'escrow') {
      const [u] = await db.query('select id from users where public_id = $1', [addr]);
      if (!u) return [];
      userId = u.id;
    }
    const filter = addr === 'treasury' ? `and user_id is null and kind not in ${ESCROW_SQL}` : addr === 'escrow' ? `and user_id is null and kind in ${ESCROW_SQL}`
      : userId != null ? 'and user_id = $4' : '';
    const params = (win) => (userId != null ? [before ?? null, n, win, userId] : [before ?? null, n, win]);
    let groups = [];
    for (let win = n * 4; ; win *= 8) {
      groups = await db.query(`select xact, min(id) as first from ledger where xact in (
          select xact from ledger where ($1::bigint is null or id < $1) ${filter} order by id desc limit $3)
        group by xact having ($1::bigint is null or min(id) < $1) order by first desc limit $2`, params(win));
      if (groups.length >= n || win >= 50_000) break;
      // same parameters as above ($2 unused here, typed so Postgres accepts it)
      const [{ c }] = await db.query(`select count(*)::int as c from (select 1 from ledger where ($1::bigint is null or id < $1) ${filter}
        and $2::int is not null order by id desc limit $3) w`, params(win));
      if (c < win) break; // the window already holds every older row
    }
    const rows = groups.length ? await db.query(`${ROW} where l.xact = any($1) order by l.id`, [groups.map((g) => g.xact)]) : [];
    return decorate(rows);
  }

  async function tx(id) {
    const [r] = await db.query('select xact from ledger where id = $1', [id]);
    if (!r) return null;
    const rows = await db.query(`${ROW} where l.xact = $1 order by l.id`, [r.xact]);
    return (await decorate(rows))[0] || null;
  }

  async function address(addr) {
    if (addr === 'treasury') {
      const o = await owed();
      return { address: 'treasury', name: 'MCP treasury', balance: Number(o.treasury) / 1e6, nfts: [] };
    }
    if (addr === 'escrow') {
      const o = await owed();
      return { address: 'escrow', name: 'Escrow', balance: Number(o.escrow) / 1e6, nfts: [] };
    }
    const [u] = await db.query(`select id, public_id, balance, created_at, show_handle, handle, avatar from users where public_id = $1`, [addr]);
    if (!u) return null;
    const [c] = await db.query('select count(distinct xact)::int as n from ledger where user_id = $1', [u.id]);
    return {
      address: u.public_id,
      name: u.show_handle ? u.handle : null,
      avatar: u.show_handle ? u.avatar : null,
      balance: Number(u.balance) / 1e6,
      joined: new Date(u.created_at).toISOString().slice(0, 10), // the day only
      transactions: c.n,
    };
  }

  async function chain({ after = 0, limit = 1000 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
    const rows = await db.query(`${ROW} where l.seq > $1 order by l.seq limit $2`, [Math.max(Number(after) || 0, 0), n]);
    return rows.map(entry);
  }

  async function anchors(limit = 20) {
    const rows = await db.query('select seq, hash, signature, status, created_at, confirmed_at from chain_anchors where network = $1 order by id desc limit $2', [network, limit]);
    return rows.map((a) => ({
      seq: Number(a.seq), hash: a.hash, signature: a.signature, url: txUrl(a.signature), status: a.status, at: a.created_at,
      memo: `mcp:anchor:${network}:${a.seq}:${a.hash}`, signer: withdrawals?.hotWallet || null,
    }));
  }

  // totals over the whole ledger: computed by the scheduled run, so public page views stay cheap
  async function refreshStats() {
    const [s] = await db.query(`select
      (select count(distinct xact)::int from ledger) as transactions,
      (select coalesce(sum(delta), 0)::bigint from ledger where kind = 'deposit') as deposited,
      (select coalesce(sum(amount), 0)::bigint from withdrawals where status = 'sent' and network = $1) as withdrawn,
      (select coalesce(sum(price), 0)::bigint from sales) as volume,
      (select count(*)::int from nfts where minted_at is not null) as minted`, [network]);
    const v = { at: new Date().toISOString(), transactions: s.transactions, deposited: String(s.deposited), withdrawn: String(s.withdrawn), volume: String(s.volume), minted: s.minted };
    await db.query("insert into app_meta (key, value) values ('explorer_stats', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(v)]);
    return v;
  }

  async function summary() {
    // cheap on every page view: indexed lookups here, the totals from the scheduled run
    const [s] = await db.query(`select
      (select count(*)::int from users) as accounts,
      (select count(*)::int from ledger where seq is null) as unsealed,
      (select max(seq) from ledger) as head_seq`);
    const [head] = s.head_seq != null ? await db.query('select hash from ledger where seq = $1', [s.head_seq]) : [];
    const [st] = await db.query("select value from app_meta where key = 'explorer_stats'");
    const totals = st ? JSON.parse(st.value) : await refreshStats();
    const anchorsList = await anchors(1);
    return {
      network,
      accounts: s.accounts,
      transactions: totals.transactions,
      deposited: Number(totals.deposited) / 1e6,
      withdrawn: Number(totals.withdrawn) / 1e6,
      volume: Number(totals.volume) / 1e6,
      minted: totals.minted ?? null,
      totals_at: totals.at,
      chain: { head_seq: s.head_seq == null ? 0 : Number(s.head_seq), head_hash: head?.hash || GENESIS, unsealed: s.unsealed, genesis: GENESIS },
      last_anchor: anchorsList[0] || null,
      payout_wallet: withdrawals?.hotWallet || null,
      reserves: await lastReserves(),
    };
  }

  return { network, seal, anchor, confirmAnchors, reserves, refreshStats, tick, txs, tx, address, chain, anchors, summary, owed };
}
