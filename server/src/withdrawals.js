// Withdrawals: $MCP out as USDC (1:1) to the one address the user bound, paid from a HOT wallet whose key is
// the only key the server holds (WITHDRAW_WALLET_KEY). Keep little on it: a full server takeover can take
// at most what sits there. Deposits stay in the offline-made pool and are moved by the owner (sweep script).
//
// Life of a withdrawal:
//   review   over an automatic limit, or something looked wrong: waits for the owner (set pending or rejected)
//   pending  queued for the hot wallet
//   sending  at least one signed transaction exists for it (withdrawal_attempts)
//   sent     one of its transactions is confirmed on chain
//   rejected the owner refused it; once none of its transactions can land, amount and fee go back once
//   refunded final: the amount and fee went back (a database trigger keeps sent and refunded final)
//
// Never paid twice. The rules, all enforced here:
//   1. Every signed transaction is stored in withdrawal_attempts BEFORE it is broadcast, and never deleted.
//   2. A new transaction is made only when every earlier one is dead: the FINALIZED block height is past
//      its last valid height plus a margin (asked FIRST), and then a status lookup from a node at least that
//      current shows it never landed (or landed, failed, and is finalized). Until then the same bytes are
//      rebroadcast, which can land at most once.
//   3. Any error from sendTransaction counts as "maybe received": the withdrawal stays "sending" and rule 2
//      decides later. sendTransaction is never retried automatically with different bytes.
//   4. Every state change is made under a row lock and only if the status AND the number of stored
//      transactions are still what the decision was based on, so parallel instances can't act on stale reads.
//   5. A refund happens only when no transaction of the withdrawal landed or can still land, at most once
//      (unique ledger key).
// Only signatures this server stored are trusted; the memo "mcp:w:<network>:<id>" is just for people
// reading the chain.
//
// Rows and address bindings are HMAC-signed (key derived from DEPOSIT_POOL_KEY, or WITHDRAW_MAC_KEY), so a
// row written or changed straight in the database is not paid, and rotating the hot wallet breaks nothing.
// Someone with write access to the database can still inflate a balance and withdraw it through an account
// of their own: that loss is capped by the hard daily payout cap and the hot wallet float.
import crypto from 'node:crypto';
import * as sol from './solana.js';
import { keypairFromSecret, signTransaction, ix } from './tx.js';
import { toMicro, mcp, amount as plain } from './money.js';
import { MarketError } from './market.js';

const fail = (msg) => { throw new MarketError(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const MIN_SOL_LAMPORTS = 3_000_000; // 0.003 SOL: enough for fees and one new token account
const EXPIRY_MARGIN = 150; // blocks (~1 minute) past lastValidBlockHeight before a transaction counts as dead
const LOCK = 727274002;

export function withdrawConfig(env = process.env) {
  const testMode = env.TEST_MODE === '1';
  const cluster = String(env.SOLANA_CLUSTER || (testMode ? 'devnet' : 'mainnet')).toLowerCase();
  return {
    testMode,
    cluster,
    mint: env.WITHDRAW_MINT || sol.STABLECOINS[cluster]?.[0]?.mint || '',
    walletKey: env.WITHDRAW_WALLET_KEY || '',
    rpcUrl: env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? sol.heliusRpcUrl(cluster, env.HELIUS_API_KEY) : ''),
    fee: toMicro(env.WITHDRAW_FEE || '0.5'),
    min: toMicro(env.MIN_WITHDRAW_USD || '5'),
    autoMax: toMicro(env.WITHDRAW_AUTO_MAX || '100'),
    userDaily: toMicro(env.WITHDRAW_USER_DAILY || '300'),
    daily: toMicro(env.WITHDRAW_DAILY || '1000'),
    // nothing pays out more than this per 24 hours, approved or not (default: twice the automatic daily total)
    hardDaily: env.WITHDRAW_HARD_DAILY ? toMicro(env.WITHDRAW_HARD_DAILY) : 2 * toMicro(env.WITHDRAW_DAILY || '1000'),
    macKey: String(env.WITHDRAW_MAC_KEY || env.DEPOSIT_POOL_KEY || '').trim().toLowerCase(),
    addressDelayHours: Number(env.WITHDRAW_ADDRESS_DELAY_HOURS ?? (testMode ? 0 : 24)),
    paused: env.WITHDRAWALS_PAUSED === '1',
    priorityFee: env.WITHDRAW_PRIORITY_FEE || 'auto', // micro-lamports per compute unit, or "auto" (Helius estimate)
  };
}

export const explorerTx = (sig, cluster) => `https://solscan.io/tx/${sig}${cluster === 'mainnet' ? '' : `?cluster=${cluster}`}`;

export function createWithdrawals(db, opts = {}) {
  const cfg = opts.config || withdrawConfig();
  const log = opts.log || ((...a) => console.error('[withdrawals]', ...a));
  const network = cfg.cluster;

  let problem = null;
  if (!['mainnet', 'devnet'].includes(network)) problem = 'SOLANA_CLUSTER must be mainnet or devnet';
  else if (cfg.testMode && network === 'mainnet') problem = 'TEST_MODE=1 only pays out on devnet';
  else if (!cfg.testMode && network !== 'mainnet') problem = 'the real server only pays out on mainnet';
  else if (!cfg.walletKey) problem = 'WITHDRAW_WALLET_KEY is not set';
  else if (!cfg.rpcUrl && !opts.rpc) problem = 'HELIUS_API_KEY (or SOLANA_RPC_URL) is not set';
  else if (!sol.isAddress(cfg.mint)) problem = 'no USDC mint for this network';
  else if (!/^[0-9a-f]{64}$/.test(cfg.macKey || '')) problem = 'DEPOSIT_POOL_KEY (or WITHDRAW_MAC_KEY) is needed to sign withdrawals';
  else if (cfg.priorityFee !== 'auto' && !/^\d{1,9}$/.test(String(cfg.priorityFee))) problem = 'WITHDRAW_PRIORITY_FEE must be "auto" or a whole number';
  let hot = null;
  if (!problem) {
    try {
      hot = keypairFromSecret(cfg.walletKey);
    } catch (e) {
      problem = `WITHDRAW_WALLET_KEY: ${e.message}`;
    }
  }
  if (problem && cfg.walletKey) log('withdrawals are off:', problem);
  const enabled = !problem;
  const rpc = opts.rpc || (cfg.rpcUrl ? sol.makeRpc(cfg.rpcUrl) : null);
  const hotAta = hot ? sol.associatedTokenAddress(hot.publicKey, cfg.mint) : null;
  // independent of the hot wallet, so the hot wallet can be replaced without invalidating rows and bindings
  const macKey = enabled ? crypto.createHmac('sha256', Buffer.from(cfg.macKey, 'hex')).update('mcp/withdrawal-mac').digest() : null;
  const hmac = (s) => crypto.createHmac('sha256', macKey).update(s).digest('hex');
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const macOf = (w) => hmac(`mcp-w:${w.network}:${w.id}:${w.user_id}:${BigInt(w.amount)}:${BigInt(w.fee)}:${w.address}`);
  const macOk = (w) => !!macKey && same(w.mac, macOf(w));
  const bindMacOf = (userId, address, setAt) => hmac(`mcp-bind:${userId}:${address}:${new Date(setAt).toISOString()}`);
  const memoOf = (id) => `mcp:w:${network}:${id}`;

  // ---------- binding the address ----------

  async function bindAddress(userId, address) {
    if (!enabled) fail('Withdrawals are not open yet.');
    address = String(address || '').trim();
    if (!sol.isAddress(address)) fail('That is not a Solana address.');
    if (address === hot.publicKey) fail('That is the market\'s own payout wallet. Use your own wallet address.');
    const ours = await db.query('select 1 from deposit_pool where address = $1 union all select 1 from deposit_accounts where address = $1', [address]);
    if (ours.length) fail('That is a deposit address of this market. Use your own wallet address (Phantom, Solflare, an exchange).');
    let info;
    try {
      info = (await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
    } catch (e) {
      log('bind check failed', e.message);
      fail('Could not check that address on the Solana network right now. Try again in a minute.');
    }
    // a token account or a mint is not a wallet: anything sent "to" it would be lost
    if (info && (info.executable || [sol.TOKEN_PROGRAM, sol.TOKEN_2022_PROGRAM].includes(info.owner))) {
      fail('That address is a token account, not a wallet. Give the wallet address itself (in Phantom: tap the account name to copy it).');
    }
    const setAt = new Date();
    const rows = await db.query(`update users set withdraw_address = $1, withdraw_address_set_at = $2, withdraw_mac = $3
      where id = $4 and withdraw_address is null returning *`, [address, setAt, bindMacOf(userId, address, setAt), userId]);
    if (!rows.length) fail('A withdrawal address is already bound to this account. Changing it requires support.');
    return rows[0];
  }

  // ---------- requesting ----------

  async function findByKey(userId, clientKey) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(clientKey || ''))) return null;
    return (await db.query('select * from withdrawals where user_id = $1 and client_key = $2', [userId, clientKey]))[0] || null;
  }

  // The withdrawal form's pass: the server hands it out with the form (in the tool result's _meta, which MCP
  // Apps hosts give to the form and keep out of the AI's context) and the form's buttons need it. It stops an
  // assistant in an app that ignores visibility "app" from binding or withdrawing on its own.
  const FORM_TTL_MS = 2 * 3600e3;
  const formTokenFor = (userId, exp) => `${exp}.${hmac(`mcp-form:${network}:${userId}:${exp}`)}`;
  function formToken(userId) {
    if (!enabled) return null;
    return formTokenFor(userId, Date.now() + FORM_TTL_MS);
  }
  function formTokenOk(userId, token) {
    if (!enabled) return false;
    const m = /^(\d{13})\.[0-9a-f]{64}$/.exec(String(token || ''));
    if (!m || Number(m[1]) < Date.now() || Number(m[1]) > Date.now() + FORM_TTL_MS) return false;
    return same(String(token), formTokenFor(userId, m[1]));
  }

  // clientKey: made by the withdrawal form for each confirmed withdrawal. A retry with the same key (an answer lost
  // on the way back) returns the withdrawal made the first time instead of making a second one.
  async function request(userId, amount, { clientKey = null } = {}) {
    if (!enabled) fail('Withdrawals are not open yet. Your balance is safe.');
    if (clientKey != null && !/^[A-Za-z0-9_-]{16,64}$/.test(String(clientKey))) fail('Bad request key.');
    // a repeat is answered with what happened the first time, before any other check
    if (clientKey) {
      const first = await findByKey(userId, clientKey);
      if (first) return { ...first, repeated: true };
    }
    let hold = null;
    const w = await db.tx(async (t) => {
      await t.query(`select pg_advisory_xact_lock(${LOCK})`);
      if (clientKey) {
        const [same] = await t.query('select * from withdrawals where user_id = $1 and client_key = $2', [userId, clientKey]);
        if (same) return { ...same, repeated: true };
      }
      // checked after the repeat lookup, so a retry of a request that went through is never told "no"
      if (cfg.paused) fail('Withdrawals are paused for maintenance right now. Your balance is safe; try again later.');
      if (!Number.isInteger(amount) || amount < cfg.min) fail(`Minimum withdrawal is ${mcp(cfg.min)}.`);
      const [u] = await t.query('select id, balance, withdraw_address, withdraw_address_set_at, withdraw_mac from users where id = $1 for update', [userId]);
      if (!u.withdraw_address) fail('Bind a withdrawal address first, in the withdrawal form.');
      if (u.withdraw_mac == null) {
        hold = 'address bound before signed bindings: check it';
      } else if (!same(u.withdraw_mac, bindMacOf(userId, u.withdraw_address, u.withdraw_address_set_at))) {
        log(`ALERT: user ${userId}: withdrawal address binding fails its signature check: the database was changed outside the app`);
        fail('Withdrawals for this account are on hold for a security check. Your balance is safe; contact support.');
      }
      const [{ s }] = await t.query('select coalesce(sum(delta), 0)::bigint as s from ledger where user_id = $1', [userId]);
      if (BigInt(s) !== BigInt(u.balance)) {
        log(`ALERT: user ${userId}: balance ${u.balance} does not match the ledger ${s}`);
        fail('Withdrawals for this account are on hold for a security check. Your balance is safe; contact support.');
      }
      const opensAt = new Date(new Date(u.withdraw_address_set_at || 0).getTime() + cfg.addressDelayHours * 3600e3);
      if (opensAt > new Date()) {
        fail(`For safety, withdrawals to a newly bound address open ${cfg.addressDelayHours} hours after binding: from ${opensAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
      }
      const total = amount + cfg.fee;
      if (Number(u.balance) < total) {
        const max = Number(u.balance) - cfg.fee;
        fail(`Not enough $MCP: ${mcp(amount)} plus the ${mcp(cfg.fee)} fee is ${mcp(total)}, the balance is ${mcp(u.balance)}.` +
          (max >= cfg.min ? ` You can withdraw up to ${mcp(max)}.` : ''));
      }
      const sums = async (oneUser) => Number((await t.query(`select coalesce(sum(amount), 0)::bigint as s from withdrawals
        where network = $1 and status in ('pending', 'sending', 'sent') and created_at > now() - interval '1 day' ${oneUser ? 'and user_id = $2' : ''}`,
      oneUser ? [network, userId] : [network]))[0].s);
      const auto = !hold && amount <= cfg.autoMax && (await sums(true)) + amount <= cfg.userDaily && (await sums(false)) + amount <= cfg.daily;
      const [row] = await t.query(`insert into withdrawals (user_id, amount, fee, address, status, network, error, client_key, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, now()) returning *`, [userId, amount, cfg.fee, u.withdraw_address, auto ? 'pending' : 'review', network, hold, clientKey]);
      row.mac = macOf(row);
      await t.query('update withdrawals set mac = $1 where id = $2', [row.mac, row.id]);
      const debited = await t.query('update users set balance = balance - $1 where id = $2 and balance >= $1 returning id', [total, userId]);
      if (!debited.length) fail('Not enough $MCP on your balance.');
      const ref = `w${row.id}`;
      await t.query(`insert into ledger (user_id, delta, kind, ref) values ($1, $2, 'withdraw', $4), ($1, $3, 'withdraw_fee', $4), (null, $5, 'withdraw_fee', $4)`,
        [userId, -amount, -cfg.fee, ref, cfg.fee]);
      return row;
    });
    if (w.status === 'review' && !w.repeated) log(`withdrawal #${w.id} of ${mcp(w.amount)} waits for review`);
    return w;
  }

  // ---------- chain state of a withdrawal ----------

  // What the chain says about every transaction this server ever signed for the withdrawal.
  // The finalized block height comes first: once it is past a transaction's last valid height, that
  // transaction can't land any more. The status lookup after it is trusted only from a node that has seen at
  // least that slot; otherwise everything not confirmed counts as still possible.
  async function chainState(withdrawalId) {
    const atts = await db.query('select signature, raw, last_valid_height from withdrawal_attempts where withdrawal_id = $1 order by id', [withdrawalId]);
    if (!atts.length) return { paid: null, live: null, count: 0 };
    const ep = await rpc('getEpochInfo', [{ commitment: 'finalized' }]);
    const res = await rpc('getSignatureStatuses', [atts.map((a) => a.signature), { searchTransactionHistory: true }]);
    const sts = res?.value || [];
    const current = Number(res?.context?.slot ?? 0) >= Number(ep.absoluteSlot);
    let live = null;
    for (let i = 0; i < atts.length; i++) {
      const st = sts[i];
      const final = st && ['confirmed', 'finalized'].includes(st.confirmationStatus);
      if (final && !st.err) return { paid: atts[i].signature, live: null, count: atts.length };
      const expired = current && Number(ep.blockHeight) > Number(atts[i].last_valid_height) + EXPIRY_MARGIN;
      if (final && st.err && (st.confirmationStatus === 'finalized' || expired)) continue; // failed for good: moved nothing
      if (st || !expired) live = atts[i]; // seen but not settled, or may still land
    }
    return { paid: null, live, count: atts.length };
  }

  // under the row lock: is the withdrawal still in the state the decision was made from?
  async function lockIf(t, id, status, count) {
    const [cur] = await t.query('select * from withdrawals where id = $1 for update', [id]);
    if (!cur || cur.status !== status) return null;
    const [{ n }] = await t.query('select count(*)::int as n from withdrawal_attempts where withdrawal_id = $1', [id]);
    return n === count ? cur : null;
  }

  async function hotBalances() {
    let usdc = 0n;
    try {
      usdc = BigInt((await rpc('getTokenAccountBalance', [hotAta, { commitment: 'confirmed' }])).value.amount);
    } catch (e) {
      if (!e.rpcError) throw e; // no token account yet = 0
    }
    const lamports = BigInt((await rpc('getBalance', [hot.publicKey, { commitment: 'confirmed' }])).value);
    return { usdc, lamports };
  }

  async function priorityFee() {
    if (cfg.priorityFee !== 'auto') return Number(cfg.priorityFee);
    try {
      const r = await rpc('getPriorityFeeEstimate', [{ accountKeys: [hotAta, sol.TOKEN_PROGRAM], options: { priorityLevel: 'Medium' } }]);
      return Math.min(Math.max(Math.ceil(Number(r?.priorityFeeEstimate) || 0), 1_000), 2_000_000);
    } catch {
      return 50_000;
    }
  }

  // a state change that only happens if nobody changed the row (status, number of transactions) since we read it
  async function move(id, from, fields, count = null) {
    const keys = Object.keys(fields);
    const r = await db.tx(async (t) => {
      const [cur] = await t.query('select status from withdrawals where id = $1 for update', [id]);
      if (!cur || cur.status !== from) return null;
      if (count != null) {
        const [{ n }] = await t.query('select count(*)::int as n from withdrawal_attempts where withdrawal_id = $1', [id]);
        if (n !== count) return null;
      }
      return (await t.query(`update withdrawals set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
        where id = $1 returning *`, [id, ...keys.map((k) => fields[k])]))[0];
    });
    return r || (await db.query('select * from withdrawals where id = $1', [id]))[0];
  }
  const markSent = (w, from, sig) => move(w.id, from, { status: 'sent', tx: sig, sent_at: new Date(), error: null });

  const broadcast = (raw) => rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);

  // ---------- memo-only transactions (the explorer's anchors, see explorer.js) ----------

  // Writes `text` to Solana from the payout wallet. Moves no tokens. onSigned(signature, lastValidHeight) runs
  // before anything is broadcast, so the caller has the signature stored even if the answer gets lost.
  async function sendMemo(text, onSigned) {
    if (!enabled) return { skipped: `payout wallet off: ${problem}` };
    const bal = await hotBalances();
    if (bal.lamports < BigInt(MIN_SOL_LAMPORTS)) return { skipped: `hot wallet SOL is low: ${Number(bal.lamports) / 1e9}` };
    const [{ value: bh }, price] = await Promise.all([rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), priorityFee()]);
    const signed = signTransaction({
      payer: hot.publicKey,
      recentBlockhash: bh.blockhash,
      signers: [hot],
      // not urgent: a capped priority fee (at most 0.000005 SOL on top of the base fee); a dropped one is redone
      instructions: [ix.computeUnitLimit(50_000), ix.computeUnitPrice(Math.min(price, 100_000)), ix.memo(text)],
    });
    await onSigned(signed.signature, bh.lastValidBlockHeight);
    try {
      await broadcast(signed.base64);
    } catch (e) {
      log('memo broadcast', e.message); // maybe received: the status check decides
    }
    return { signature: signed.signature };
  }

  // ---------- paying ----------

  // Pays one pending withdrawal. Waits up to waitMs for confirmation; anything unfinished is picked up later.
  async function send(id, { waitMs = 6000, budget = null } = {}) {
    const [w] = await db.query('select * from withdrawals where id = $1 and network = $2', [id, network]);
    if (!w || w.status !== 'pending') return w;
    if (!macOk(w)) {
      log(`ALERT: withdrawal #${w.id} fails its signature check: the database was changed outside the app. Not paid.`);
      return move(w.id, 'pending', { status: 'review', error: 'signature check failed: not created by this server' });
    }
    const refunded = w.refunded_at || (await db.query("select 1 from ledger where kind = 'withdraw_refund' and ref = $1", [`w${w.id}`])).length;
    if (refunded) {
      log(`ALERT: withdrawal #${w.id} was already refunded and was set back to pending; not paid`);
      return move(w.id, 'pending', { status: 'review', error: 'already refunded: not paid' });
    }
    const state = await chainState(w.id);
    if (state.paid) return markSent(w, 'pending', state.paid);
    if (state.live) return move(w.id, 'pending', { status: 'sending' }, state.count); // an earlier transaction may still land
    // gives up after MAX_ATTEMPTS transactions; the owner can approve again with attempts = 0
    if (Number(w.attempts) >= MAX_ATTEMPTS) return move(w.id, 'pending', { status: 'review', error: `not paid after ${w.attempts} attempts: ${w.error || 'see logs'}` });
    // a hard cap on everything paid out in 24 hours, approved by the owner or not
    const [{ s: paid24 }] = await db.query(`select coalesce(sum(w.amount), 0)::bigint as s from withdrawals w where w.network = $1 and w.id <> $2
      and exists (select 1 from withdrawal_attempts a where a.withdrawal_id = w.id and a.created_at > now() - interval '1 day')`, [network, w.id]);
    if (BigInt(paid24) + BigInt(w.amount) > BigInt(cfg.hardDaily)) {
      log(`ALERT: the 24-hour payout cap of ${mcp(cfg.hardDaily)} is reached; withdrawal #${w.id} waits`);
      await db.query("update withdrawals set error = $2, updated_at = now() where id = $1 and status = 'pending'", [w.id, 'waiting: the daily payout cap is reached']);
      return { ...w, waiting: true };
    }
    const bal = budget || await hotBalances();
    if (bal.usdc < BigInt(w.amount) || bal.lamports < BigInt(MIN_SOL_LAMPORTS)) {
      log(`ALERT: hot wallet ${hot.publicKey} is low (${plain(bal.usdc)} USDC, ${Number(bal.lamports) / 1e9} SOL); withdrawal #${w.id} waits`);
      await db.query("update withdrawals set error = $2, updated_at = now() where id = $1 and status = 'pending'", [w.id, 'waiting for the payout wallet to be topped up']);
      return { ...w, waiting: true };
    }

    const to = sol.associatedTokenAddress(w.address, cfg.mint);
    const [{ value: bh }, price] = await Promise.all([rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), priorityFee()]);
    const signed = signTransaction({
      payer: hot.publicKey,
      recentBlockhash: bh.blockhash,
      signers: [hot],
      instructions: [
        ix.computeUnitLimit(60_000),
        ix.computeUnitPrice(price),
        ix.createAtaIdempotent({ payer: hot.publicKey, ata: to, owner: w.address, mint: cfg.mint }),
        ix.transferChecked({ source: hotAta, mint: cfg.mint, destination: to, owner: hot.publicKey, amount: BigInt(w.amount), decimals: 6 }),
        ix.memo(memoOf(w.id)),
      ],
    });
    // record the transaction and claim the withdrawal in one step, before anything is broadcast, and only if
    // nothing changed since chainState() looked (same status, same number of transactions)
    let claimed;
    try {
      claimed = await db.tx(async (t) => {
        const cur = await lockIf(t, w.id, 'pending', state.count);
        if (!cur || cur.refunded_at) return null;
        await t.query('insert into withdrawal_attempts (withdrawal_id, signature, raw, last_valid_height) values ($1, $2, $3, $4)',
          [w.id, signed.signature, signed.base64, bh.lastValidBlockHeight]);
        const [r] = await t.query(`update withdrawals set status = 'sending', tx = $2, attempts = attempts + 1, error = null, updated_at = now()
          where id = $1 returning *`, [w.id, signed.signature]);
        return r;
      });
    } catch (e) {
      if (e.code !== '23505') throw e; // the very same transaction is already stored: nothing new to send
      claimed = null;
    }
    if (!claimed) return (await db.query('select * from withdrawals where id = $1', [w.id]))[0]; // someone else got it
    if (budget) budget.usdc -= BigInt(w.amount);
    try {
      await rpc('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
    } catch (e) {
      // even a refusal may come after an earlier delivery of the same bytes: treat it as "maybe received"
      log(`withdrawal #${w.id}: sendTransaction said "${e.message.slice(0, 200)}"; it stays in flight until it lands or expires`);
      await db.query("update withdrawals set error = $2 where id = $1 and status = 'sending'", [w.id, e.message.slice(0, 300)]);
      return { ...claimed, error: e.message };
    }
    return confirm(claimed, waitMs);
  }

  // waits for this transaction only; failures and expiry are decided by reconcile()
  async function confirm(w, waitMs) {
    const until = Date.now() + waitMs;
    for (;;) {
      const st = (await rpc('getSignatureStatuses', [[w.tx], { searchTransactionHistory: true }]).catch(() => null))?.value?.[0];
      if (st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus)) return markSent(w, 'sending', w.tx);
      if (Date.now() >= until) return w;
      await sleep(700);
    }
  }

  // A withdrawal in "sending": paid? still possible (rebroadcast the same bytes)? all dead (queue again)?
  async function reconcile(w) {
    const state = await chainState(w.id);
    if (state.paid) return markSent(w, 'sending', state.paid);
    if (state.live) {
      await broadcast(state.live.raw).catch(() => {});
      const st = (await rpc('getSignatureStatuses', [[state.live.signature], { searchTransactionHistory: true }]).catch(() => null))?.value?.[0];
      if (st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus)) return markSent(w, 'sending', state.live.signature);
      return w;
    }
    return move(w.id, 'sending', Number(w.attempts) >= MAX_ATTEMPTS
      ? { status: 'review', error: `not paid after ${w.attempts} attempts: ${w.error || 'see logs'}` }
      : { status: 'pending' }, state.count);
  }

  async function refund(w) {
    if (!macOk(w)) {
      log(`ALERT: rejected withdrawal #${w.id} fails its signature check; not refunded`);
      return move(w.id, 'rejected', { status: 'review', error: 'signature check failed: not created by this server, not refunded' });
    }
    const state = await chainState(w.id);
    if (state.paid) {
      log(`ALERT: withdrawal #${w.id} was marked rejected but it is paid on chain (${state.paid}); not refunded`);
      return markSent(w, 'rejected', state.paid);
    }
    if (state.live) return null; // one of its transactions could still land: wait until it can't
    try {
      return await db.tx(async (t) => {
        const cur = await lockIf(t, w.id, 'rejected', state.count);
        if (!cur || cur.refunded_at) return null;
        const total = BigInt(cur.amount) + BigInt(cur.fee);
        const ref = `w${cur.id}`;
        // one refund per withdrawal, enforced by a unique key on the ledger
        await t.query(`insert into ledger (user_id, delta, kind, ref) values ($1, $2, 'withdraw_refund', $3), (null, $4, 'withdraw_fee', $3)`,
          [cur.user_id, String(total), ref, String(-BigInt(cur.fee))]);
        await t.query('update users set balance = balance + $1 where id = $2', [String(total), cur.user_id]);
        return (await t.query("update withdrawals set status = 'refunded', refunded_at = now(), updated_at = now() where id = $1 returning *", [cur.id]))[0];
      });
    } catch (e) {
      if (e.code !== '23505') throw e;
      log(`ALERT: withdrawal #${w.id} was already refunded once and was set back to rejected; not refunded again`);
      return move(w.id, 'rejected', { status: 'refunded', error: 'already refunded once' });
    }
  }

  return {
    enabled,
    problem,
    cluster: network,
    hotWallet: hot?.publicKey ?? null,
    // public settings only: no keys, no RPC URL
    config: { fee: cfg.fee, min: cfg.min, autoMax: cfg.autoMax, userDaily: cfg.userDaily, daily: cfg.daily, hardDaily: cfg.hardDaily, addressDelayHours: cfg.addressDelayHours, paused: cfg.paused },
    explorer: (sig) => explorerTx(sig, network),
    bindAddress,
    request,
    sendMemo,
    // [{ confirmationStatus, err } | null] for signatures, and the finalized block height (for expiry)
    async chainStatus(signatures) {
      const ep = await rpc('getEpochInfo', [{ commitment: 'finalized' }]);
      const res = await rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
      return { statuses: res?.value || [], finalizedHeight: Number(ep.blockHeight), current: Number(res?.context?.slot ?? 0) >= Number(ep.absoluteSlot) };
    },
    findByKey,
    formToken,
    formTokenOk,
    send,
    macOk,

    async list(userId, limit = 10) {
      return db.query(`select id, amount, fee, address, status, tx, created_at, sent_at, refunded_at from withdrawals
        where user_id = $1 order by id desc limit $2`, [userId, limit]);
    },

    // The scheduled run: refunds, transactions in flight, then the queue, within the time budget.
    async tick({ budgetMs = 12_000, waitMs = 2000 } = {}) {
      const started = Date.now();
      const res = { sent: 0, waiting: 0, review: 0, refunded: 0, errors: [], hot: null };
      if (!enabled) return { ...res, skipped: problem };
      // one bad row never stops the others
      const each = async (rows, fn) => {
        for (const w of rows) {
          try {
            if ((await fn(w)) === 'stop') break;
          } catch (e) {
            res.errors.push(`#${w.id}: ${e.message}`);
            log(`withdrawal #${w.id}:`, e.message);
          }
        }
      };
      try {
        await each(await db.query("select * from withdrawals where network = $1 and status = 'rejected' order by id limit 20", [network]), async (w) => {
          if ((await refund(w))?.status === 'refunded') res.refunded++;
        });
        await each(await db.query("select * from withdrawals where network = $1 and status = 'sending' order by id limit 20", [network]), async (w) => {
          if ((await reconcile(w))?.status === 'sent') res.sent++;
        });
        const bal = await hotBalances();
        res.hot = { address: hot.publicKey, usdc: plain(bal.usdc), sol: Number(bal.lamports) / 1e9 };
        if (!cfg.paused) {
          await each(await db.query("select id from withdrawals where network = $1 and status = 'pending' order by id limit 50", [network]), async (w) => {
            if (Date.now() - started > budgetMs) return 'stop';
            const r = await send(w.id, { waitMs, budget: bal });
            if (r?.status === 'sent') res.sent++;
            if (r?.waiting) { res.waiting++; return 'stop'; }
          });
        }
        const [c] = await db.query(`select count(*) filter (where status = 'review')::int as review,
          coalesce(sum(amount) filter (where status = 'pending'), 0)::bigint as queued from withdrawals where network = $1`, [network]);
        res.review = c.review;
        if (bal.usdc < BigInt(c.queued)) res.errors.push(`hot wallet has ${plain(bal.usdc)} USDC, queued payouts need ${plain(c.queued)}`);
        if (bal.lamports < BigInt(MIN_SOL_LAMPORTS) * 3n) res.errors.push(`hot wallet SOL is low: ${Number(bal.lamports) / 1e9}`);
      } catch (e) {
        res.errors.push(e.message);
        log('tick failed', e.message);
      }
      return res;
    },
  };
}
