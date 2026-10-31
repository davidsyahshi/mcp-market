// $CREDIT: holders burn MCP NFTs for $CREDIT (10,000 per NFT, rarer ones up to 10x), then claim it to a Solana wallet for the airdrop of the
// $CREDIT token. $CREDIT is a balance of its own (users.credit_balance, whole units), never $MCP: it does not enter the
// $MCP ledger, balances or reserves. Burning and claiming happen in a form inside the chat (server/ui/credit.html):
// the person ticks the NFTs or pastes the wallet and presses Confirm there.
//
// A burn takes NFTs out for good: no owner, off the market, never minted again (minted_at stays). Each NFT gets a
// zero-amount "burn" ledger row, so the explorer and the NFT's history show it, and the burns row holds what it gave.
// A claim takes all the account's $CREDIT at that moment to the wallet given, for a fee in $MCP (to the treasury, a
// "claim_fee" ledger row pair). The owner sees the claims in /admin, copies them for the airdrop and marks them sent.
// Free drops: a code from /admin gives each account a fixed amount of $CREDIT after social tasks and a post of its
// airdrop card on X (redeemDrop). It runs through the chat's existing promo-code tool, so no connector refresh is needed.
// An account's $CREDIT is always: its burns + its finished drops - its claims that are not void.
import * as m from './market.js';
import * as sol from './solana.js';
import { toMicro } from './money.js';

const fail = (msg) => { throw new m.MarketError(msg); };
const intEnv = (v, d) => (/^\d{1,12}$/.test(String(v ?? '').trim()) ? Number(v) : d);

// a bad value falls back to the default, loudly
const alert = (name, v, d) => { console.error(`ALERT: ${name}="${v}" is not valid; using ${d}`); return d; };
export const CONFIG = {
  // $CREDIT per burned NFT
  perNft: (() => {
    const v = process.env.CREDIT_PER_BURN;
    return v == null || v === '' ? 10_000 : intEnv(v, 0) >= 1 ? intEnv(v, 0) : alert('CREDIT_PER_BURN', v, 10_000);
  })(),
  // $MCP per claim, micro-units (0 is allowed: free claims)
  claimFee: (() => {
    const v = process.env.CREDIT_CLAIM_FEE;
    if (v == null || v === '') return 500_000;
    if (String(v).trim() === '0') return 0;
    try { return toMicro(v, { what: 'CREDIT_CLAIM_FEE' }); } catch { return alert('CREDIT_CLAIM_FEE', v, 0.5) && 500_000; }
  })(),
};
export const BURN_MAX = 500; // NFTs in one burn (one transaction); burn again for more
// rarer NFTs burn for more: CREDIT_PER_BURN times this (Common and anything unlisted: 1x)
export const RARITY_X = { Common: 1, Rare: 2, Epic: 5, Legendary: 8, 'Ultra-Rare': 10 };
export const rarityX = (rarity) => (Object.hasOwn(RARITY_X, rarity ?? '') ? RARITY_X[rarity] : 1);
// the $CREDIT one NFT of this rarity burns for
export const creditFor = (rarity) => CONFIG.perNft * rarityX(rarity);
// "10,000 each · Rare 2x · Epic 5x · Legendary 8x · Ultra-Rare 10x"
export const rarityLine = () => `${CONFIG.perNft.toLocaleString('en-US')} each · ${Object.entries(RARITY_X).filter(([, x]) => x > 1).map(([r, x]) => `${r} ${x}x`).join(' · ')}`;
const notBurned = 'Nothing was burned.';

// When the $CREDIT token goes live: CREDIT_LAUNCH_AT (an ISO time). Not set: no countdown, just "soon".
export function launchAt(env = process.env) {
  const set = env.CREDIT_LAUNCH_AT ? new Date(env.CREDIT_LAUNCH_AT) : null;
  return set && !Number.isNaN(set.getTime()) ? set : null;
}
// "in 9 hours, at 20:00 UTC" / "in 40 minutes, at 20:00 UTC" / "on Nov 2 at 20:00 UTC (in 33 hours)" / null when it
// passed or isn't set
export function launchText(now = new Date(), env = process.env) {
  const at = launchAt(env);
  if (!at) return null;
  const ms = at.getTime() - now.getTime();
  if (ms <= 0) return null;
  const clock = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
  const mins = Math.ceil(ms / 60e3);
  const hours = Math.round(ms / 3600e3);
  const inText = mins < 60 ? `in ${mins} minute${mins === 1 ? '' : 's'}` : `in ${Math.max(1, hours)} hour${hours === 1 ? '' : 's'}`;
  if (ms <= 24 * 3600e3) return `${inText}, at ${clock}`;
  const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `on ${day} at ${clock} (${inText})`;
}
export const launchLine = (now = new Date(), env = process.env) => {
  if (!launchAt(env)) return 'The $CREDIT token launches soon.';
  const t = launchText(now, env);
  return t ? `The $CREDIT token launches ${t}.` : 'The $CREDIT token is live.';
};

export const credits = (n) => Number(n).toLocaleString('en-US');

// NFT numbers, each once, in order
function burnList(ids) {
  if (!Array.isArray(ids) || !ids.length) fail(`Pick the NFTs to burn. ${notBurned}`);
  if (ids.length > BURN_MAX) fail(`Burn at most ${BURN_MAX} NFTs at a time. ${notBurned}`);
  const out = [...new Set(ids.map(Number))];
  if (out.length !== ids.length) fail(`An NFT is in the list twice. ${notBurned}`);
  for (const id of out) if (!Number.isInteger(id) || id < 1 || id > 2147483647) fail(`An NFT number is a whole number, like 42. ${notBurned}`);
  return out.sort((a, b) => a - b);
}

// Burns the account's MCP NFTs, all of them or none: $CREDIT to the account, the NFTs gone.
// Lock order as in a send or a buy: the collection (shared), the NFTs, then the account.
export async function burn(db, userId, ids) {
  const list = burnList(ids);
  return db.tx(async (t) => {
    const cols = await t.query(`select id, slug, name, status, trade_after_sold_out from collections
      where id in (select collection_id from nfts where id = any($1::int[])) order by id for share`, [list]);
    const nfts = await t.query(`select id, name, rarity, pixel, owner_id, price, collection_id from nfts
      where id = any($1::int[]) order by id for update`, [list]);
    const byId = new Map(nfts.map((n) => [Number(n.id), n]));
    for (const id of list) {
      const n = byId.get(id);
      if (!n || n.owner_id == null || Number(n.owner_id) !== Number(userId)) fail(`You don't own ${n ? n.name : m.nftName(id)}. ${notBurned}`);
    }
    for (const c of cols) {
      if (c.slug !== m.OWN_COLLECTION) fail(`Only MCP NFTs can be burned for $CREDIT; ${c.name} can't. ${notBurned}`);
      if (c.status === 'frozen') fail(`${c.name} is frozen. ${notBurned}`);
      if (c.trade_after_sold_out) {
        const [{ left }] = await t.query('select exists (select 1 from nfts where collection_id = $1 and minted_at is null) as left', [c.id]);
        if (left) fail(`Burning opens when the whole ${c.name} collection is minted. ${notBurned}`);
      }
    }
    const gone = await t.query(`update nfts set owner_id = null, price = null, listed_at = null, burned_at = now(), burned_by = $2
      where id = any($1::int[]) and owner_id = $2 returning id`, [list, userId]);
    if (gone.length !== list.length) fail(`Some of these NFTs just changed hands. ${notBurned}`);
    const rows = await t.query(`insert into ledger (user_id, delta, kind, ref)
      select $1, 0, 'burn', x.id::text from unnest($2::int[]) as x(id) order by x.id returning id`, [userId, list]);
    const credit = list.reduce((sum, id) => sum + creditFor(byId.get(id).rarity), 0);
    const [b] = await t.query('insert into burns (user_id, nft_ids, count, credit) values ($1, $2, $3, $4) returning id, created_at',
      [userId, list, list.length, credit]);
    const [u] = await t.query('update users set credit_balance = credit_balance + $1 where id = $2 returning credit_balance, public_id', [credit, userId]);
    return {
      id: Number(b.id), count: list.length, credit, balance: Number(u.credit_balance), address: u.public_id,
      tx: Math.min(...rows.map((r) => Number(r.id))), at: b.created_at,
      nfts: list.map((id) => ({ id, name: byId.get(id).name, rarity: byId.get(id).rarity, pixel: !!byId.get(id).pixel, credit: creditFor(byId.get(id).rarity) })),
    };
  });
}

export async function getBurn(db, id) {
  const [b] = await db.query(`select b.id, b.count, b.credit, b.nft_ids, b.created_at, u.public_id, case when u.show_handle then u.handle end as name
    from burns b join users u on u.id = b.user_id where b.id = $1`, [id]);
  if (!b) return null;
  const ids = b.nft_ids.map(Number);
  const ns = await db.query('select id, name, pixel from nfts where id = any($1::int[])', [ids]);
  const byId = new Map(ns.map((n) => [Number(n.id), n]));
  return { id: Number(b.id), count: Number(b.count), credit: Number(b.credit), at: b.created_at, address: b.public_id, name: b.name,
    nfts: ids.map((x) => ({ id: x, name: byId.get(x)?.name || m.nftName(x), pixel: !!byId.get(x)?.pixel })) };
}

// ---------- claims ----------

const CLAIM_KEY = /^[A-Za-z0-9_-]{8,64}$/;

// All the account's $CREDIT to the wallet given, for the claim fee in $MCP. A retry with the same request key returns
// the same claim instead of making another.
// expected: the $CREDIT the user saw when they confirmed (a burn meanwhile makes it more: they confirm again).
// blocked: wallets that are the market's own (the payout wallet).
export async function claim(db, userId, { wallet, requestKey, expected, blocked = [] } = {}) {
  const w = String(wallet ?? '').trim();
  if (!sol.isAddress(w)) fail('That is not a Solana address. Paste your wallet address (Phantom, Solflare, Backpack…).');
  if (!sol.isWallet(w)) fail('That address is a token account, not a wallet. Paste the wallet address itself (in Phantom: tap the account name to copy it).');
  const key = requestKey == null ? null : String(requestKey);
  if (key != null && !CLAIM_KEY.test(key)) fail('Bad request key.');
  return db.tx(async (t) => {
    const [u] = await t.query('select id, balance, credit_balance, public_id from users where id = $1 for update', [userId]);
    if (!u) fail('There is no such account.');
    if (key) {
      const [again] = await t.query('select * from credit_claims where user_id = $1 and client_key = $2', [userId, key]);
      if (again) return { ...claimView(again), repeated: true, credit_balance: Number(u.credit_balance), mcp_balance: Number(u.balance) };
    }
    const ours = await t.query('select 1 from deposit_pool where address = $1 union all select 1 from deposit_accounts where address = $1 limit 1', [w]);
    if (ours.length || blocked.includes(w)) fail('That is an address of this market, not your wallet. Paste your own wallet address.');
    const amount = Number(u.credit_balance);
    if (!(amount > 0)) fail('No $CREDIT to claim yet. Burn MCP NFTs for it first: /burnmcp');
    if (expected != null && Number(expected) !== amount) fail(`Your $CREDIT is now ${credits(amount)}, not ${credits(expected)}. Check it and confirm again.`);
    const fee = CONFIG.claimFee;
    if (Number(u.balance) < fee) {
      fail(`Claiming costs ${m.fmt(fee)}, and the balance is ${m.fmt(u.balance)}. Top up ${m.fmt(fee - Number(u.balance))} or more with /deposit-mcp, then claim.`);
    }
    const [c] = await t.query(`insert into credit_claims (user_id, wallet, amount, fee, client_key) values ($1, $2, $3, $4, $5) returning *`,
      [userId, w, amount, fee, key]);
    if (fee > 0) {
      await t.query('update users set balance = balance - $1 where id = $2', [fee, userId]);
      await t.query(`insert into ledger (user_id, delta, kind, ref) values ($1, $2, 'claim_fee', $4), (null, $3, 'claim_fee', $4)`,
        [userId, -fee, fee, `k${c.id}`]);
    }
    const [after] = await t.query('update users set credit_balance = credit_balance - $1 where id = $2 returning balance, credit_balance', [amount, userId]);
    return { ...claimView(c), repeated: false, credit_balance: Number(after.credit_balance), mcp_balance: Number(after.balance) };
  });
}

const claimView = (c) => ({ id: Number(c.id), wallet: c.wallet, amount: Number(c.amount), fee: Number(c.fee), status: c.status, at: c.created_at, sent_at: c.sent_at || null });

export async function myClaims(db, userId, limit = 20) {
  return (await db.query('select * from credit_claims where user_id = $1 order by id desc limit $2', [userId, limit])).map(claimView);
}

// ---------- free drops ----------

export const DROP_WAIT_S = 15; // each step waits this long after it was shown: the user has to do it first
export const DROP_MAX_AMOUNT = 1_000_000;
// what people type or copy from a post: "FREE 1000 $CREDIT MCP", "free 1,000", "/mcpcredit FREE1000" → FREE1000.
// The words around the code and every space or sign go; codes compare in that form.
export const dropKey = (input) => m.normCode(String(input ?? '').replace(/^\s*\/?(mcpcredit|mcpmint)\b/i, ''))
  .replace(/\$?\bCREDITS?\b|\bMCP\b|\bTOKENS?\b|\bAIRDROP\b|\$/g, ' ').replace(/[^A-Z0-9]/g, '');

// the drop a typed code means, or null
export async function findDrop(db, input) {
  const key = dropKey(input);
  if (!key) return null;
  const rows = await db.query('select code from credit_drops');
  return rows.find((r) => dropKey(r.code) === key)?.code || null;
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

// One account through a drop, a step per call: the tasks (if the code has any), then the card to post, then done.
// proof: what the assistant saw on the screenshot the user sent for the step they are on. Returns { stage, ... }:
// 'tasks' (do them, send a screenshot), 'post' (the card: post it, send a screenshot of the post), 'done' ($CREDIT added).
export async function redeemDrop(db, userId, code, { proof } = {}) {
  const note = clean(proof);
  return db.tx(async (t) => {
    // the account first, then the drop: one step at a time per account, and the count of uses never passes the limit
    const [u] = await t.query('select id, credit_balance from users where id = $1 for update', [userId]);
    if (!u) fail('There is no such account.');
    const [d] = await t.query('select * from credit_drops where code = $1 for update', [code]);
    if (!d) fail(`There is no code "${code}". Check the spelling.`);
    const [c] = await t.query(`select *, extract(epoch from now() - shown_at)::float as ago from credit_drop_claims
      where code = $1 and user_id = $2`, [code, userId]);
    const tasks = m.promoTasks(d);
    const base = { code, amount: Number(d.amount), max_uses: d.max_uses, tweet_url: d.tweet_url || null };
    if (c?.stage === 'done') return { ...base, stage: 'done', already: true, id: c.id, amount: Number(c.amount), balance: Number(u.credit_balance) };
    if (c?.stage === 'post') {
      if (!note || c.ago < DROP_WAIT_S) return { ...base, stage: 'post', id: c.id, amount: Number(c.amount), proof_missing: !!note };
      await t.query("update credit_drop_claims set stage = 'done', post_proof = $2, done_at = now() where id = $1", [c.id, note]);
      const [b] = await t.query('update users set credit_balance = credit_balance + $1 where id = $2 returning credit_balance', [c.amount, userId]);
      return { ...base, stage: 'done', id: c.id, amount: Number(c.amount), balance: Number(b.credit_balance) };
    }
    if (d.status !== 'active') fail(`The ${code} airdrop is paused right now.`);
    if (d.used >= d.max_uses) fail(`All ${d.max_uses.toLocaleString('en-US')} free airdrops of ${code} are taken.`);
    if (tasks.length) {
      if (!c) {
        await t.query('insert into credit_drop_claims (code, user_id) values ($1, $2)', [code, userId]);
        return { ...base, stage: 'tasks', tasks, left: d.max_uses - d.used };
      }
      if (!note || c.ago < DROP_WAIT_S) return { ...base, stage: 'tasks', tasks, left: d.max_uses - d.used, proof_missing: !!note };
    }
    // the tasks are done (or there are none): the card is made and a use is counted; the $CREDIT comes after the post
    const [row] = c
      ? await t.query("update credit_drop_claims set stage = 'post', amount = $2, task_proof = $3, shown_at = now() where id = $1 returning id", [c.id, d.amount, note || null])
      : await t.query("insert into credit_drop_claims (code, user_id, stage, amount) values ($1, $2, 'post', $3) returning id", [code, userId, d.amount]);
    const [{ used }] = await t.query('update credit_drops set used = used + 1 where code = $1 returning used', [code]);
    return { ...base, stage: 'post', id: row.id, amount: Number(d.amount), left: d.max_uses - used, fresh: true };
  });
}

export async function getDropCard(db, id) {
  const [c] = await db.query(`select c.id, c.amount, c.stage, c.code, u.public_id, case when u.show_handle then u.handle end as name
    from credit_drop_claims c join users u on u.id = c.user_id where c.id = $1 and c.stage in ('post', 'done')`, [id]);
  return c ? { id: Number(c.id), amount: Number(c.amount), stage: c.stage, code: c.code, address: c.public_id, name: c.name } : null;
}

// the owner's drop codes (/admin). Drop codes and promo codes share one name space.
const DROP_COLS = `d.code, d.amount, d.max_uses, d.used, d.status, d.created_at, d.follow_url, d.tweet_url,
  (select count(*)::int from credit_drop_claims c where c.code = d.code and c.stage = 'done') as done,
  (select max(created_at) from credit_drop_claims c where c.code = d.code) as last_used_at`;
export async function drops(db) {
  return (await db.query(`select ${DROP_COLS} from credit_drops d order by d.created_at desc, d.code`)).map((d) => ({ ...d, amount: Number(d.amount) }));
}
const dropLinks = ({ follow_url: f, tweet_url: tw }) => {
  const out = {};
  for (const [k, v, post] of [['follow_url', f, false], ['tweet_url', tw, true]]) {
    if (v == null) continue;
    const x = String(v).trim().replace(/\/$/, '');
    if (x && (!m.isXUrl(x) || /\/status\//.test(x) !== post)) fail(`${post ? 'Tweet' : 'Follow'} link: an x.com link to ${post ? 'a post, like https://x.com/name/status/123…' : 'an account, like https://x.com/name'}.`);
    out[k] = x;
  }
  return out;
};
const dropUses = (uses) => {
  if (!Number.isInteger(uses) || uses < 1 || uses > 100_000) fail('Uses: 1 to 100,000.');
};
export async function createDrop(db, { code, amount, uses, follow_url, tweet_url } = {}) {
  const c0 = m.normCode(code);
  if (!m.isCode(c0)) fail('A code is 3 to 32 letters, digits, - or _, starting with a letter or digit.');
  if (!dropKey(c0)) fail('Pick a code with more than the words CREDIT, MCP, TOKEN or AIRDROP in it.');
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 1 || amt > DROP_MAX_AMOUNT) fail(`$CREDIT per account: 1 to ${DROP_MAX_AMOUNT.toLocaleString('en-US')}.`);
  dropUses(uses);
  const links = dropLinks({ follow_url, tweet_url });
  return db.tx(async (t) => {
    if ((await t.query('select 1 from promo_codes where code = $1', [c0])).length) fail(`${c0} is already a promo code.`);
    if (await findDrop(t, c0)) fail(`${c0} already exists (or a drop code that reads the same).`);
    await t.query('insert into credit_drops (code, amount, max_uses, follow_url, tweet_url) values ($1, $2, $3, $4, $5)',
      [c0, amt, uses, links.follow_url || null, links.tweet_url || null]);
    return (await t.query(`select ${DROP_COLS} from credit_drops d where d.code = $1`, [c0])).map((d) => ({ ...d, amount: Number(d.amount) }))[0];
  });
}
export async function updateDrop(db, code, { status, uses, follow_url, tweet_url } = {}) {
  const c0 = m.normCode(code);
  if (status != null && !['active', 'paused'].includes(status)) fail('Status: active or paused.');
  if (uses != null) dropUses(uses);
  const links = dropLinks({ follow_url, tweet_url });
  if (status == null && uses == null && links.follow_url == null && links.tweet_url == null) fail('Nothing to change.');
  return db.tx(async (t) => {
    const [d] = await t.query('select * from credit_drops where code = $1 for update', [c0]);
    if (!d) fail(`There is no drop "${c0}".`);
    if (uses != null && uses < d.used) fail(`${d.used} accounts already got ${c0}: uses can't go below that.`);
    await t.query(`update credit_drops set status = coalesce($2, status), max_uses = coalesce($3, max_uses),
      follow_url = case when $4::text is null then follow_url else nullif($4::text, '') end,
      tweet_url = case when $5::text is null then tweet_url else nullif($5::text, '') end where code = $1`,
    [c0, status ?? null, uses ?? null, links.follow_url ?? null, links.tweet_url ?? null]);
    return (await t.query(`select ${DROP_COLS} from credit_drops d where d.code = $1`, [c0])).map((x) => ({ ...x, amount: Number(x.amount) }))[0];
  });
}

// what the forms show: the account's $CREDIT, its claims and the numbers of a claim
export async function creditInfo(db, userId, now = new Date()) {
  const [u] = await db.query(`select u.balance, u.credit_balance,
      (select coalesce(sum(count), 0)::int from burns where user_id = u.id) as burned,
      (select coalesce(sum(credit), 0)::bigint from burns where user_id = u.id)
        + (select coalesce(sum(amount), 0)::bigint from credit_drop_claims where user_id = u.id and stage = 'done') as earned
    from users u where u.id = $1`, [userId]);
  return {
    balance: Number(u.credit_balance), burned: Number(u.burned), earned: Number(u.earned), per_nft: CONFIG.perNft, rarity_x: RARITY_X,
    fee: CONFIG.claimFee / 1e6, mcp_balance: Number(u.balance) / 1e6,
    launch_at: launchAt()?.toISOString() || null, launch_text: launchText(now), launch_line: launchLine(now),
    claims: await myClaims(db, userId),
    last_burn: (await db.query('select id, count, credit from burns where user_id = $1 order by id desc limit 1', [userId]))
      .map((b) => ({ id: Number(b.id), count: Number(b.count), credit: Number(b.credit) }))[0] || null,
  };
}

// ---------- the owner's view (/admin) ----------

export async function adminCredit(db) {
  const [s] = await db.query(`select
      (select coalesce(sum(count), 0)::int from burns) as burned_nfts,
      (select count(distinct user_id)::int from burns) as burners,
      (select coalesce(sum(credit), 0)::bigint from burns) as issued,
      (select count(*)::int from credit_drop_claims where stage = 'done') as drops,
      (select coalesce(sum(amount), 0)::bigint from credit_drop_claims where stage = 'done') as drop_credit,
      (select coalesce(sum(credit_balance), 0)::bigint from users) as unclaimed,
      (select count(*)::int from credit_claims where status = 'pending') as pending,
      (select coalesce(sum(amount), 0)::bigint from credit_claims where status = 'pending') as pending_credit,
      (select count(*)::int from credit_claims where status = 'sent') as sent,
      (select coalesce(sum(amount), 0)::bigint from credit_claims where status = 'sent') as sent_credit,
      (select count(*)::int from credit_claims where status = 'void') as void,
      (select coalesce(sum(fee), 0)::bigint from credit_claims) as fees`);
  // the newest 1,000 to look at; the airdrop list below has every pending one
  const claims = await db.query(`select c.*, u.public_id, u.handle from credit_claims c join users u on u.id = c.user_id
    order by (c.status = 'pending') desc, c.id desc limit 1000`);
  return {
    totals: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'fees' ? Number(v) / 1e6 : Number(v)])),
    per_nft: CONFIG.perNft, launch_at: launchAt()?.toISOString() || null,
    claims: claims.map((c) => ({ ...claimView(c), addr: c.public_id, handle: c.handle })),
    ...await airdrop(db),
  };
}

// every pending claim, one line per wallet with its total: "wallet,amount" for an airdrop tool, and the claims those
// lines cover (the page marks exactly these sent, so a claim that comes in after the copy isn't marked by mistake)
export async function airdrop(db) {
  const rows = await db.query(`select wallet, sum(amount)::bigint as amount, array_agg(id order by id) as ids
    from credit_claims where status = 'pending' group by wallet order by min(id)`);
  return { airdrop: rows.map((r) => `${r.wallet},${Number(r.amount)}`).join('\n'), airdrop_ids: rows.flatMap((r) => r.ids.map(Number)) };
}

// the owner marks claims sent after the airdrop (or back to pending), by their numbers; a void claim stays void
export async function markClaims(db, ids, status) {
  if (!['sent', 'pending'].includes(status)) fail('Status is sent or pending.');
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((x) => Number.isInteger(x) && x > 0);
  if (!list.length || list.length > 100_000) fail('Give 1 to 100,000 claim numbers.');
  const rows = await db.query(`update credit_claims set status = $2, sent_at = case when $2 = 'sent' then coalesce(sent_at, now()) else null end
    where id = any($1::int[]) and status <> $2 and status <> 'void' returning id`, [list, status]);
  return { updated: rows.length };
}

// A claim made by mistake (a wrong wallet, a claim the user didn't make): void, its $CREDIT back on the account. Only a
// pending one: a sent one went out in the airdrop. The fee stays paid.
export async function voidClaim(db, id) {
  return db.tx(async (t) => {
    const [c] = await t.query('select * from credit_claims where id = $1 for update', [Number(id) || 0]);
    if (!c) fail('There is no such claim.');
    if (c.status !== 'pending') fail(`Claim #${c.id} is ${c.status}: only a pending claim can be voided.`);
    await t.query("update credit_claims set status = 'void' where id = $1", [c.id]);
    const [u] = await t.query('update users set credit_balance = credit_balance + $1 where id = $2 returning credit_balance', [c.amount, c.user_id]);
    return { id: Number(c.id), returned: Number(c.amount), credit_balance: Number(u.credit_balance) };
  });
}
