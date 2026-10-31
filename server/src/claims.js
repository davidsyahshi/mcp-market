// Lost deposits: someone sent USDC/USDT and it didn't show up on their balance. The site's /lost-deposit form takes
// the MCP deposit address they sent to, the wallet they sent from and the transaction; the owner checks each report in
// /admin, where every report comes with what the database already knows: whose deposit address it is and whether that
// transaction was credited. Crediting stays a manual step; a report never moves money.
import crypto from 'node:crypto';
import { MoneyError } from './money.js';

export class ClaimError extends MoneyError {}
const fail = (msg) => { throw new ClaimError(msg); };

export const CLAIMS_PER_HOUR = 5;   // per sender (by a salted hash of their IP address; IPv6 by its /64)
export const CLAIMS_PER_DAY = 20;
export const CLAIMS_TOTAL_PER_DAY = 500; // from everyone: junk can't bury real reports
export const CLAIM_STATUSES = ['new', 'done', 'rejected'];

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /[1-9A-HJ-NP-Za-km-z]{64,90}/;
export const isSolAddress = (s) => SOL_ADDR.test(String(s || ''));
// a signature as pasted, or taken out of an explorer link (solscan.io/tx/…, explorer.solana.com/tx/…?cluster=…)
export function signatureOf(input) {
  const s = String(input || '').trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)) return s;
  const fromLink = /\/tx\/([1-9A-HJ-NP-Za-km-z]{64,90})(?:[/?#]|$)/.exec(s);
  if (fromLink) return fromLink[1];
  return null;
}

const salt = () => crypto.createHash('sha256').update(`mcp/claims:${process.env.WITHDRAW_MAC_KEY || process.env.DEPOSIT_POOL_KEY || process.env.X_CLIENT_SECRET || ''}`).digest();
// one sender = one IPv4 address, or one IPv6 /64 (a home or phone gets a whole /64 and can rotate inside it)
const ipKey = (ip) => {
  const s = String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!s.includes(':')) return s;
  const [head] = s.split('::');
  const parts = s.includes('::') ? head.split(':').filter(Boolean) : s.split(':');
  return `${parts.slice(0, 4).join(':')}::/64`;
};
export const ipHash = (ip) => crypto.createHmac('sha256', salt()).update(ipKey(ip)).digest('hex').slice(0, 32);

const view = (c) => ({
  id: Number(c.id), deposit_address: c.deposit_address, from_wallet: c.from_wallet, tx: c.tx, status: c.status, note: c.note || null,
  created_at: c.created_at, updated_at: c.updated_at || null,
});

export async function createClaim(db, { deposit_address, from_wallet, tx, ip, userId = null }) {
  const to = String(deposit_address ?? '').trim();
  const from = String(from_wallet ?? '').trim();
  if (!isSolAddress(to)) fail('MCP deposit address: the Solana address your AI gave you for deposits (32 to 44 letters and digits).');
  if (!isSolAddress(from)) fail('Your wallet: the Solana address you sent from (32 to 44 letters and digits).');
  if (to === from) fail('The deposit address and your wallet are the same address. Check both.');
  const sig = signatureOf(tx);
  if (!sig) fail('Transaction: paste the transaction signature or its Solscan link (solscan.io/tx/…).');
  const h = ipHash(ip);
  return db.tx(async (t) => {
    // one sender's reports take turns, so parallel requests can't slip past the limit
    await t.query('select pg_advisory_xact_lock(727274020, hashtext($1))', [h]);
    // the same transaction with the same deposit address once; another address for the same transaction is a report
    // of its own (both show in /admin, flagged), so nobody can block a real report by filing the signature first
    const [had] = await t.query('select id from deposit_claims where tx = $1 and deposit_address = $2', [sig, to]);
    if (had) return { id: Number(had.id), duplicate: true };
    const [{ hour, day }] = await t.query(`select count(*) filter (where created_at > now() - interval '1 hour')::int as hour,
      count(*)::int as day from deposit_claims where ip_hash = $1 and created_at > now() - interval '1 day'`, [h]);
    if (hour >= CLAIMS_PER_HOUR || day >= CLAIMS_PER_DAY) fail('Too many reports from here. Try again later.');
    const [{ total }] = await t.query("select count(*)::int as total from deposit_claims where created_at > now() - interval '1 day'");
    if (total >= CLAIMS_TOTAL_PER_DAY) fail('Too many reports today. Try again tomorrow.');
    const [c] = await t.query(`insert into deposit_claims (deposit_address, from_wallet, tx, user_id, ip_hash) values ($1, $2, $3, $4, $5)
      on conflict (tx, deposit_address) do nothing returning id`, [to, from, sig, userId, h]);
    if (!c) return { id: Number((await t.query('select id from deposit_claims where tx = $1 and deposit_address = $2', [sig, to]))[0].id), duplicate: true };
    return { id: Number(c.id), duplicate: false };
  });
}

// the owner's list, newest first, each with what the database knows about its address and transaction (looked up
// for the whole page at once: a handful of queries, not a few per report)
export async function listClaims(db, { status = null, limit = 200 } = {}) {
  const lim = Math.min(Number(limit) || 200, 500);
  const where = status && CLAIM_STATUSES.includes(status) ? 'where c.status = $2' : '';
  const rows = await db.query(`select c.*, ru.public_id as reporter_addr, ru.handle as reporter_handle from deposit_claims c
    left join users ru on ru.id = c.user_id ${where} order by c.id desc limit $1`, where ? [lim, status] : [lim]);
  if (!rows.length) return [];
  const addrs = [...new Set(rows.map((c) => c.deposit_address))];
  const sigs = [...new Set(rows.map((c) => c.tx))];
  const [pools, accts, deps, manual, same] = await Promise.all([
    db.query(`select p.address, p.network, u.public_id, u.handle from deposit_pool p left join users u on u.id = p.user_id where p.address = any($1::text[])`, [addrs]),
    db.query(`select da.address, da.wallet, u.public_id, u.handle from deposit_accounts da join users u on u.id = da.user_id
      where da.address = any($1::text[]) or da.wallet = any($1::text[])`, [addrs]),
    db.query(`select d.signature, d.status, d.amount, d.token, u.public_id, u.handle from deposits d join users u on u.id = d.user_id
      where d.signature = any($1::text[])`, [sigs]),
    // credited by hand through /admin/deposit: its reference is "manual <signature>"
    db.query("select ref from ledger where kind = 'deposit' and ref = any($1::text[])", [sigs.map((x) => `manual ${x}`)]),
    db.query('select tx, count(distinct deposit_address)::int as n from deposit_claims where tx = any($1::text[]) group by tx', [sigs]),
  ]);
  const poolBy = new Map(pools.map((p) => [p.address, p]));
  const acctBy = new Map();
  for (const a of accts) { acctBy.set(a.address, a); acctBy.set(a.wallet, a); }
  const manualSet = new Set(manual.map((r) => r.ref.slice('manual '.length)));
  const sameBy = new Map(same.map((r) => [r.tx, r.n]));
  return rows.map((c) => {
    const pool = poolBy.get(c.deposit_address);
    const acct = pool ? null : acctBy.get(c.deposit_address);
    const owner = pool?.public_id ? { addr: pool.public_id, handle: pool.handle } : acct ? { addr: acct.public_id, handle: acct.handle } : null;
    const ds = deps.filter((d) => d.signature === c.tx);
    return {
      ...view(c),
      reporter: c.reporter_addr ? { addr: c.reporter_addr, handle: c.reporter_handle } : null,
      check: {
        // whose deposit address it is, as the person typed it: the transaction's real destination is on Solscan
        address: pool ? (pool.public_id ? 'ours' : 'ours, not given out') : acct ? 'ours (a token account)' : 'not ours',
        owner,
        network: pool?.network || null,
        deposits: ds.map((d) => ({ status: d.status, amount: Number(d.amount) / 1e6, token: d.token, addr: d.public_id, handle: d.handle })),
        credited: ds.some((d) => d.status === 'credited') || manualSet.has(c.tx),
        manual: manualSet.has(c.tx),
        // the same transaction reported with other deposit addresses too: someone may be claiming another's transfer
        other_addresses: Math.max(0, (sameBy.get(c.tx) || 1) - 1),
      },
    };
  });
}

export async function updateClaim(db, id, { status, note } = {}) {
  if (status != null && !CLAIM_STATUSES.includes(status)) fail(`Status: ${CLAIM_STATUSES.join(', ')}.`);
  if (status == null && note == null) fail('Nothing to change.');
  const [c] = await db.query(`update deposit_claims set status = coalesce($2, status), note = case when $3::text is null then note else nullif($3::text, '') end,
    updated_at = now() where id = $1 returning *`, [id, status ?? null, note == null ? null : String(note).slice(0, 500)]);
  if (!c) fail('There is no such report.');
  return view(c);
}
