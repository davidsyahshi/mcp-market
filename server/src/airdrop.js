// The $CREDIT airdrop, batch by batch, and what the Tokens page shows about it.
//
// The owner sends the token himself, from his own wallet, with a multisender: no key for it is on this server. In /admin
// he makes a batch of the oldest pending claims (credit.js: claim), one line per wallet ("wallet,amount"), sends those
// lines, pastes the transaction signatures (or Solscan links) and marks the batch sent. Wallets that failed go back to
// the queue. One batch is open at a time.
//
// The public side (the Tokens page) reads the batches sent, the open one ("sending now"), the queue in order, and one
// wallet's place in it with an estimate of when its batch goes out. Only wallets and amounts are public here: never the
// MCP account or the X handle behind a wallet.
//
// The token's contract address (CA) and its pump.fun link are set once in /admin when the token is live, and then
// can't be changed from /admin (only in the database): a stolen admin session can't swap the CA for a fake one.
import { base58 } from '@scure/base';
import * as m from './market.js';
import * as sol from './solana.js';
import { launchAt } from './credit.js';

const fail = (msg) => { throw new m.MarketError(msg); };
const intEnv = (v, d, lo, hi) => {
  const s = String(v ?? '').trim();
  if (!s) return d;
  const x = Number(s);
  if (Number.isInteger(x) && x >= lo && x <= hi) return x;
  console.error(`ALERT: "${s}" is not a valid number here (${lo} to ${hi}); using ${d}`);
  return d;
};
export const BATCH_MAX = 1000;
export const PACE = {
  // wallets in a batch (the /admin field starts with it; the estimate uses the last batch's size once there is one)
  size: intEnv(process.env.CREDIT_BATCH_SIZE, 100, 1, BATCH_MAX),
  // minutes between batches, for the estimate of when a wallet's batch goes out
  minutes: intEnv(process.env.CREDIT_BATCH_MINUTES, 5, 1, 1440),
};
const LOCK = 727274002; // making, sending and cancelling batches take turns

// ---------- the token: CA and link, set once ----------

const TOKEN_KEY = 'credit_token';
export const pumpUrl = (ca) => `https://pump.fun/coin/${ca}`;

export async function token(db) {
  const [r] = await db.query('select value from app_meta where key = $1', [TOKEN_KEY]);
  if (!r) return { ca: null, url: null, set_at: null };
  try {
    const v = JSON.parse(r.value);
    if (!sol.isAddress(v.ca)) return { ca: null, url: null, set_at: null };
    return { ca: v.ca, url: isHttps(v.url) ? v.url : pumpUrl(v.ca), set_at: v.set_at || null };
  } catch {
    return { ca: null, url: null, set_at: null };
  }
}
const isHttps = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && !x.username && !x.password && String(u).length <= 300;
  } catch {
    return false;
  }
};

// ca: the token's mint address; url: where "Buy" goes (empty: its pump.fun page)
export async function setToken(db, { ca, url } = {}) {
  const c = String(ca ?? '').trim();
  if (!sol.isAddress(c)) fail('That is not a Solana address. Paste the token\'s contract address (CA) from pump.fun.');
  const u = String(url ?? '').trim();
  if (u && !isHttps(u)) fail('The link has to be an https:// link (or leave it empty for the pump.fun page).');
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [LOCK]);
    const [had] = await t.query('select value from app_meta where key = $1', [TOKEN_KEY]);
    if (had) fail(`The CA is already set and can't be changed here. To change it, in the Supabase SQL editor: delete from app_meta where key = '${TOKEN_KEY}';`);
    const value = { ca: c, url: u || pumpUrl(c), set_at: new Date().toISOString() };
    await t.query('insert into app_meta (key, value) values ($1, $2)', [TOKEN_KEY, JSON.stringify(value)]);
    return value;
  });
}

// ---------- signatures pasted by the owner ----------

// a Solana transaction signature: 64 bytes in base58 (86 to 88 characters)
export const isSignature = (s) => {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) return false;
  try {
    return base58.decode(s).length === 64;
  } catch {
    return false;
  }
};
// What the owner pasted after sending, line by line: a signature or a Solscan link (solscan.io/tx/<sig>) is the batch's;
// a line with a wallet and a signature ("wallet,amount,signature", a multisender's report) ties that signature to the
// wallet. Anything else on a line is ignored.
export function parseSent(text) {
  const txs = [];
  const byWallet = new Map();
  for (const line of String(text ?? '').split(/\r?\n/).slice(0, 5000)) {
    const words = line.match(/[1-9A-HJ-NP-Za-km-z]{32,90}/g) || [];
    const sigs = words.filter(isSignature);
    const wallets = words.filter((w) => sol.isAddress(w));
    for (const s of sigs) if (!txs.includes(s)) txs.push(s);
    if (sigs.length && wallets.length === 1) byWallet.set(wallets[0], sigs[0]);
  }
  return { txs, byWallet };
}
// wallets, one per line (or with spaces or commas between)
export const parseWallets = (text) => [...new Set((String(text ?? '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []).filter((w) => sol.isAddress(w)))];

// ---------- batches (the owner, in /admin) ----------

// one line per wallet of the claims given: wallet, its total, the claim numbers, the earliest claim
const linesOf = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const w = by.get(r.wallet) || { wallet: r.wallet, amount: 0, ids: [], first: Number(r.id) };
    w.amount += Number(r.amount);
    w.ids.push(Number(r.id));
    w.first = Math.min(w.first, Number(r.id));
    by.set(r.wallet, w);
  }
  return [...by.values()].sort((a, b) => a.first - b.first);
};
const batchRow = (b, rows) => {
  const lines = linesOf(rows);
  return {
    id: Number(b.id), no: Number(b.no), size: Number(b.size), status: b.status, txs: b.txs || [], created_at: b.created_at, sent_at: b.sent_at || null,
    wallets: lines.length, credit: lines.reduce((s, l) => s + l.amount, 0),
    lines: lines.map((l) => ({ wallet: l.wallet, amount: l.amount, claims: l.ids, tx: rows.find((r) => r.wallet === l.wallet && r.tx)?.tx || null })),
    // for the multisender: "wallet,amount", one per line
    text: lines.map((l) => `${l.wallet},${l.amount}`).join('\n'),
  };
};
async function loadBatch(q, id) {
  const [b] = await q('select * from credit_batches where id = $1', [id]);
  if (!b) return null;
  return batchRow(b, await q('select id, wallet, amount, tx from credit_claims where batch_id = $1 order by id', [id]));
}

// The next batch: the pending claims that are in no batch, smallest wallet totals first (1,000s first, the biggest last, so
// the big holders come at the end), up to `size` wallets (all of a wallet's claims go together). Equal totals: oldest first.
export async function makeBatch(db, size = PACE.size) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1 || n > BATCH_MAX) fail(`A batch is 1 to ${BATCH_MAX} wallets.`);
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [LOCK]);
    const [open] = await t.query("select no from credit_batches where status = 'sending'");
    if (open) fail(`Batch #${open.no} is still open: mark it sent (or cancel it) first.`);
    const pick = await t.query(`select wallet from credit_claims where status = 'pending' and batch_id is null
      group by wallet order by sum(amount), min(id) limit $1`, [n]);
    if (!pick.length) fail('Nobody is waiting: there are no pending claims outside a batch.');
    const [{ no }] = await t.query('select coalesce(max(no), 0) + 1 as no from credit_batches');
    const [b] = await t.query('insert into credit_batches (no, size) values ($1, $2) returning id', [no, n]);
    const took = await t.query(`update credit_claims set batch_id = $1 where status = 'pending' and batch_id is null
      and wallet = any($2::text[]) returning id`, [b.id, pick.map((r) => r.wallet)]);
    if (!took.length) fail('Those claims just changed. Try again.');
    return loadBatch(t.query, b.id);
  });
}

// After sending: the batch's signatures (and a wallet's own, from a multisender's report), and the wallets that failed,
// which go back to the queue. On a batch already sent, this adds signatures or sends failed wallets back.
export async function markBatchSent(db, id, { sent, failed } = {}) {
  const { txs, byWallet } = parseSent(sent);
  const bad = parseWallets(failed);
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [LOCK]);
    const [b] = await t.query('select * from credit_batches where id = $1 for update', [Number(id) || 0]);
    if (!b) fail('There is no such batch.');
    const rows = await t.query('select id, wallet, amount, tx, status from credit_claims where batch_id = $1 for update', [b.id]);
    const inBatch = new Set(rows.map((r) => r.wallet));
    const failedHere = bad.filter((w) => inBatch.has(w));
    const unknown = [...bad.filter((w) => !inBatch.has(w)), ...[...byWallet.keys()].filter((w) => !inBatch.has(w))];
    if (b.status === 'sending' && failedHere.length === inBatch.size) fail('Every wallet of this batch failed: cancel the batch instead (they all go back to the queue).');
    if (b.status === 'sent' && !txs.length && !failedHere.length) fail('Nothing to change: paste signatures to add, or wallets that failed.');
    // the failed ones: back in the queue, as if never batched
    if (failedHere.length) {
      await t.query(`update credit_claims set status = 'pending', batch_id = null, tx = null, sent_at = null
        where batch_id = $1 and wallet = any($2::text[])`, [b.id, failedHere]);
    }
    for (const [w, s] of byWallet) {
      if (inBatch.has(w) && !failedHere.includes(w)) await t.query('update credit_claims set tx = $3 where batch_id = $1 and wallet = $2', [b.id, w, s]);
    }
    await t.query(`update credit_claims set status = 'sent', sent_at = coalesce(sent_at, now()) where batch_id = $1 and status = 'pending'`, [b.id]);
    const all = [...(b.txs || [])];
    for (const s of txs) if (!all.includes(s)) all.push(s);
    await t.query("update credit_batches set status = 'sent', sent_at = coalesce(sent_at, now()), txs = $2 where id = $1", [b.id, all.slice(0, 2000)]);
    return { ...await loadBatch(t.query, b.id), added: txs.length, failed: failedHere.length, unknown: unknown.length };
  });
}

// An open batch that won't be sent: its claims go back to the queue, the batch goes away.
export async function cancelBatch(db, id) {
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [LOCK]);
    const [b] = await t.query('select * from credit_batches where id = $1 for update', [Number(id) || 0]);
    if (!b) fail('There is no such batch.');
    if (b.status !== 'sending') fail(`Batch #${b.no} was sent: it can't be cancelled. Send wallets that didn't get it back to the queue instead.`);
    const back = await t.query('update credit_claims set batch_id = null, tx = null where batch_id = $1 returning id', [b.id]);
    await t.query('delete from credit_batches where id = $1', [b.id]);
    return { no: Number(b.no), returned: back.length };
  });
}

// /admin: the open batch with its lines, the last batches, the queue's size
export async function adminBatches(db) {
  const [open] = await db.query("select id from credit_batches where status = 'sending'");
  const recent = await db.query('select id from credit_batches order by no desc limit 30');
  const [q] = await db.query(`select count(distinct wallet)::int as wallets, coalesce(sum(amount), 0)::bigint as credit
    from credit_claims where status = 'pending' and batch_id is null`);
  return {
    open: open ? await loadBatch(db.query, open.id) : null,
    batches: await Promise.all(recent.map(async (r) => {
      const b = await loadBatch(db.query, r.id);
      return { ...b, lines: undefined, text: undefined };
    })),
    queue: { wallets: Number(q.wallets), credit: Number(q.credit) },
    size: PACE.size, minutes: PACE.minutes, token: await token(db),
  };
}

// ---------- the public feed (the Tokens page) ----------

// when the next batch is likely to go out, and the ones after it
async function schedule(db, now) {
  const [last] = await db.query('select no, size from credit_batches order by no desc limit 1');
  const [sent] = await db.query("select sent_at from credit_batches where status = 'sent' order by sent_at desc limit 1");
  const [open] = await db.query("select no from credit_batches where status = 'sending'");
  const size = last?.size > 0 ? Number(last.size) : PACE.size;
  const step = PACE.minutes * 60e3;
  // before the token is live (no CA yet), nothing goes out before the launch time
  const start = (await token(db)).ca ? 0 : launchAt()?.getTime() || 0;
  // the open batch goes out a step after the last one sent (or now); the queue's first batch a step after that
  const base = Math.max(now.getTime(), start, sent?.sent_at ? new Date(sent.sent_at).getTime() + step : 0);
  const first = open ? base + step : base;
  const nextNo = (last ? Number(last.no) : 0) + 1;
  // the queue's p-th wallet (1 = next in line): its batch and roughly when
  const at = (p) => {
    const k = Math.floor((p - 1) / size);
    return { batch: nextNo + k, eta: new Date(first + k * step).toISOString() };
  };
  return { size, minutes: PACE.minutes, next_no: nextNo, open_eta: open ? new Date(base).toISOString() : null, at };
}

const QUEUE = `select wallet, sum(amount)::bigint as amount, min(id) as first from credit_claims
  where status = 'pending' and batch_id is null group by wallet`;

export async function feed(db, { now = new Date(), rows = 100, batches = 20, queue = 30 } = {}) {
  const [s] = await db.query(`select
      (select count(distinct wallet)::int from credit_claims where status <> 'void') as wallets,
      (select coalesce(sum(amount), 0)::bigint from credit_claims where status <> 'void') as credit,
      (select count(distinct wallet)::int from credit_claims where status = 'sent') as sent_wallets,
      (select coalesce(sum(amount), 0)::bigint from credit_claims where status = 'sent') as sent_credit,
      (select count(*)::int from credit_claims where status = 'sent') as sent_claims,
      (select count(distinct wallet)::int from credit_claims where status = 'pending' and batch_id is null) as queued_wallets,
      (select coalesce(sum(amount), 0)::bigint from credit_claims where status = 'pending' and batch_id is null) as queued_credit,
      (select count(*)::int from credit_batches where status = 'sent') as batches_sent`);
  const totals = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]));
  const sch = await schedule(db, now);
  const [openRow] = await db.query("select id from credit_batches where status = 'sending'");
  const open = openRow ? await loadBatch(db.query, openRow.id) : null;
  // the batches, newest first, without their wallet lists
  const bs = await db.query(`select b.no, b.status, b.txs, b.created_at, b.sent_at,
      count(distinct c.wallet)::int as wallets, coalesce(sum(c.amount), 0)::bigint as credit
    from credit_batches b left join credit_claims c on c.batch_id = b.id
    group by b.id order by b.no desc limit $1`, [batches]);
  // the latest wallets sent, one row per wallet and batch
  const sent = await db.query(`select c.wallet, sum(c.amount)::bigint as amount, max(c.tx) as tx, max(c.sent_at) as at, b.no, b.txs[1] as batch_tx,
      cardinality(b.txs) as batch_txs, min(c.id) as first
    from credit_claims c join credit_batches b on b.id = c.batch_id
    where c.status = 'sent' group by b.no, b.txs, c.wallet order by max(c.sent_at) desc, b.no desc, min(c.id) desc limit $1`, [rows]);
  const next = await db.query(`${QUEUE} order by amount, first limit $1`, [queue]);
  const tk = await token(db);
  const launch = launchAt();
  return {
    token: { symbol: '$CREDIT', ca: tk.ca, url: tk.url, launch_at: launch?.toISOString() || null, live: !!tk.ca || (!!launch && launch <= now) },
    totals,
    pace: { size: sch.size, minutes: sch.minutes, next_no: sch.next_no, next_at: totals.queued_wallets ? sch.at(1).eta : null },
    open: open ? { no: open.no, wallets: open.wallets, credit: open.credit, started_at: open.created_at, eta: sch.open_eta,
      lines: open.lines.slice(0, 200).map((l) => ({ wallet: l.wallet, amount: l.amount })) } : null,
    batches: bs.map((b) => ({ no: Number(b.no), status: b.status, wallets: Number(b.wallets), credit: Number(b.credit),
      txs: (b.txs || []).slice(0, 50), tx_count: (b.txs || []).length, created_at: b.created_at, sent_at: b.sent_at || null })),
    recent: sent.map((r) => ({ wallet: r.wallet, amount: Number(r.amount), batch: Number(r.no), at: r.at,
      tx: r.tx || (Number(r.batch_txs) === 1 ? r.batch_tx : null) })),
    queue: next.map((r, i) => ({ pos: i + 1, wallet: r.wallet, amount: Number(r.amount), ...sch.at(i + 1) })),
  };
}

// One wallet: what it claimed, what was sent (batch, signature, when), what is being sent now, and its place in the queue.
export async function walletStatus(db, wallet, { now = new Date() } = {}) {
  const w = String(wallet ?? '').trim();
  if (!sol.isAddress(w)) fail('That is not a Solana wallet address.');
  const rows = await db.query(`select c.id, c.amount, c.status, c.tx, c.sent_at, c.created_at, b.no, b.status as bstatus, b.txs, b.created_at as bat
    from credit_claims c left join credit_batches b on b.id = c.batch_id where c.wallet = $1 and c.status <> 'void' order by c.id`, [w]);
  const sum = (xs) => xs.reduce((a, r) => a + Number(r.amount), 0);
  const sentRows = rows.filter((r) => r.status === 'sent');
  const sendingRows = rows.filter((r) => r.status === 'pending' && r.no != null);
  const queuedRows = rows.filter((r) => r.status === 'pending' && r.no == null);
  // sent: one entry per batch (a wallet can be in several, after claiming again)
  const byBatch = new Map();
  for (const r of sentRows) {
    const k = r.no ?? 0;
    const e = byBatch.get(k) || { batch: r.no == null ? null : Number(r.no), amount: 0, at: r.sent_at, tx: null, txs: (r.txs || []).slice(0, 20) };
    e.amount += Number(r.amount);
    if (r.tx) e.tx = r.tx;
    if (r.sent_at && (!e.at || r.sent_at > e.at)) e.at = r.sent_at;
    byBatch.set(k, e);
  }
  let queued = null;
  const sch = queuedRows.length || sendingRows.length ? await schedule(db, now) : null;
  if (queuedRows.length) {
    // the queue goes smallest total first, then oldest claim first
    const first = Math.min(...queuedRows.map((r) => Number(r.id)));
    const mine = sum(queuedRows);
    const [{ ahead }] = await db.query(`select count(*)::int as ahead from (${QUEUE}) q where q.amount < $2 or (q.amount = $2 and q.first < $1)`, [first, mine]);
    queued = { amount: sum(queuedRows), pos: Number(ahead) + 1, ...sch.at(Number(ahead) + 1) };
  }
  return {
    wallet: w, found: rows.length > 0,
    total: sum(rows), sent: sum(sentRows),
    sent_batches: [...byBatch.values()].sort((a, b) => (a.batch ?? 0) - (b.batch ?? 0)),
    sending: sendingRows.length ? { batch: Number(sendingRows[0].no), amount: sum(sendingRows), since: sendingRows[0].bat, eta: sch.open_eta } : null,
    queued,
  };
}
