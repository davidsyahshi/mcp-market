// A tiny in-memory Solana for tests: the RPC methods deposits, payouts and the sweep script use, plus the
// Helius webhook API. Deposits are recorded as ready-made getTransaction results; payout and sweep
// transactions are really executed: signatures verified, blockhash expiry, token balances, memos.
import crypto from 'node:crypto';
import { base58 } from '@scure/base';
import { TOKEN_PROGRAM, ATA_PROGRAM, seedFromMnemonic, associatedTokenAddress } from '../src/solana.js';
import { decodeTransaction, MEMO_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM } from '../src/tx.js';
import { makePoolRows, poolKeyFromSeed } from '../src/pool.js';

export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const FAKE_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // mainnet USDT mint, used here as a devnet test token

export const TEST_SEED = seedFromMnemonic(TEST_MNEMONIC);
export const TEST_POOL_KEY = poolKeyFromSeed(TEST_SEED);

export const randomAddress = () => base58.encode(crypto.randomBytes(32));

// what the owner does once: make addresses offline and import the CSV into deposit_pool
export async function seedPool(db, { network = 'devnet', start = 0, count = 20, seed = TEST_SEED } = {}) {
  const { rows } = makePoolRows(seed, network, start, count);
  for (const r of rows) {
    await db.query('insert into deposit_pool (network, idx, address, mac) values ($1, $2, $3, $4)', [r.network, r.idx, r.address, r.mac]);
  }
  return rows;
}
const randomSig = () => base58.encode(crypto.randomBytes(64));

// the payout hot wallet for tests, and payout settings: devnet USDC, fee 0.5, min 5, auto up to 100 at once,
// 300 a day per user, 1000 a day in total, no waiting after binding an address
export const TEST_HOT_SEED = Buffer.alloc(32, 9);
import { keypairFromSeed } from '../src/tx.js';
export const TEST_HOT = keypairFromSeed(TEST_HOT_SEED);
export const TEST_HOT_SECRET = base58.encode(Buffer.concat([TEST_HOT_SEED, Buffer.from(base58.decode(TEST_HOT.publicKey))]));
export const testWithdrawConfig = (over = {}) => ({
  testMode: true,
  cluster: 'devnet',
  mint: DEV_USDC,
  walletKey: TEST_HOT_SECRET,
  rpcUrl: 'http://fake-rpc.invalid',
  fee: 500_000,
  min: 5_000_000,
  autoMax: 100_000_000,
  userDaily: 300_000_000,
  daily: 1_000_000_000,
  addressDelayHours: 0,
  paused: false,
  priorityFee: 'auto',
  macKey: TEST_POOL_KEY,
  hardDaily: 2_000_000_000,
  ...over,
});

// deposit settings for tests: devnet, USDC + USDT, no throttling between checks
export const testDepositConfig = (over = {}) => ({
  testMode: true,
  cluster: 'devnet',
  tokens: [{ symbol: 'USDC', mint: DEV_USDC }, { symbol: 'USDT', mint: FAKE_USDT }],
  poolKey: TEST_POOL_KEY,
  heliusKey: 'test',
  rpcUrl: 'http://fake-rpc.invalid',
  webhookSecret: '',
  minDeposit: 10_000, // $0.01
  recheckMs: 0,
  ...over,
});

export function fakeChain() {
  const sigsByAddr = new Map(); // address -> newest first
  const txs = new Map();
  const hidden = new Set(); // signatures getTransaction can't see yet (a lagging node)
  const calls = [];
  let slot = 1000;

  function addTx({ accountKeys, loaded = { writable: [], readonly: [] }, pre = [], post = [], err = null }) {
    const signature = randomSig();
    slot += 1;
    const tx = {
      slot, blockTime: Math.floor(Date.now() / 1000), version: 0,
      meta: { err, fee: 5000, preTokenBalances: pre, postTokenBalances: post, loadedAddresses: loaded },
      transaction: { signatures: [signature], message: { accountKeys } },
    };
    txs.set(signature, tx);
    for (const a of new Set([...accountKeys, ...loaded.writable, ...loaded.readonly])) {
      if (!sigsByAddr.has(a)) sigsByAddr.set(a, []);
      sigsByAddr.get(a).unshift({ signature, slot, err, blockTime: tx.blockTime, confirmationStatus: 'confirmed' });
    }
    return signature;
  }

  // A token transfer into `to` (a token account owned by `owner`). amount is raw (6 decimals = micro-dollars).
  // inLookupTable puts the receiving account in the v0 address lookup table part of the transaction.
  function transfer({ mint, to, owner, amount, before = 0, decimals = 6, err = null, inLookupTable = false, ownerInPost }) {
    const sender = randomAddress();
    const senderAta = randomAddress();
    const keys = [sender, senderAta, ...(inLookupTable ? [] : [to]), mint, TOKEN_PROGRAM];
    const loaded = { writable: inLookupTable ? [to] : [], readonly: [] };
    const toIndex = inLookupTable ? keys.length : 2;
    const bal = (accountIndex, own, amt) => ({ accountIndex, mint, owner: own, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: String(amt), decimals } });
    const pre = [bal(1, sender, 10n ** 15n), ...(before != null ? [bal(toIndex, owner, before)] : [])];
    const post = [bal(1, sender, 10n ** 15n - BigInt(amount)), bal(toIndex, ownerInPost ?? owner, BigInt(before ?? 0) + BigInt(amount))];
    return addTx({ accountKeys: keys, loaded, pre, post, err });
  }

  // one transaction paying several of our token accounts at once (an exchange batch payout)
  function batch(mint, payments) {
    const sender = randomAddress();
    const senderAta = randomAddress();
    const keys = [sender, senderAta, ...payments.map((p) => p.to), mint, TOKEN_PROGRAM];
    const total = payments.reduce((s, p) => s + BigInt(p.amount), 0n);
    const bal = (accountIndex, own, amt) => ({ accountIndex, mint, owner: own, uiTokenAmount: { amount: String(amt), decimals: 6 } });
    return addTx({
      accountKeys: keys,
      pre: [bal(1, sender, 10n ** 15n)],
      post: [bal(1, sender, 10n ** 15n - total), ...payments.map((p, i) => bal(2 + i, p.owner, p.amount))],
    });
  }

  // what a Helius "raw" webhook delivers for one transaction
  const webhookItem = (signature) => structuredClone(txs.get(signature));

  // ---------- executed transactions (payouts, sweeps) ----------
  const tokens = new Map(); // token account -> { mint, owner, amount }
  const lamports = new Map();
  const statuses = new Map(); // signature -> { slot, confirmationStatus, err }
  const blockhashes = new Map(); // blockhash -> last valid block height
  const executed = []; // { signature, memo, transfers: [{ from, to, mint, amount }] }
  let height = 5000;
  const behave = { reject: 0, drop: 0, lostResponse: 0, landFailed: 0, statusLag: 0, delay: 0, staleStatusNode: false };
  const FINALITY = 32; // blocks between confirmed and finalized
  const delayed = []; // accepted transactions that land only when flush() is called (if still valid then)
  const rpcErr = (message, code = -32002) => Object.assign(new Error(`sendTransaction: ${message}`), { rpcError: true, code });

  // give `owner` a token account for `mint` holding `amount` raw units (and some SOL)
  function fund(owner, mint, amount, sol = 1_000_000_000) {
    const ata = associatedTokenAddress(owner, mint);
    const cur = tokens.get(ata) || { mint, owner, amount: 0n };
    cur.amount += BigInt(amount);
    tokens.set(ata, cur);
    if (sol != null) lamports.set(owner, (lamports.get(owner) || 0) + sol);
    return ata;
  }
  const tokenBalance = (owner, mint) => tokens.get(associatedTokenAddress(owner, mint))?.amount ?? 0n;
  const advance = (blocks) => { height += blocks; };

  function execute(b64) {
    const t = decodeTransaction(Buffer.from(b64, 'base64'));
    if (!t.verified) throw rpcErr('Transaction signature verification failure', -32003);
    if (statuses.has(t.signature)) return t.signature; // the same transaction again: nothing happens twice
    const lastValid = blockhashes.get(t.recentBlockhash);
    if (lastValid == null || height > lastValid) throw rpcErr('Blockhash not found');
    const tok = new Map([...tokens].map(([k, v]) => [k, { ...v }]));
    const lam = new Map(lamports);
    const payer = t.keys[0];
    const pay = (who, n) => {
      if ((lam.get(who) || 0) < n) throw rpcErr('Attempt to debit an account but found no record of a prior credit.');
      lam.set(who, lam.get(who) - n);
    };
    pay(payer, 5000);
    let memo = null;
    const transfers = [];
    for (const i of t.instructions) {
      if (i.programId === COMPUTE_BUDGET_PROGRAM) continue;
      if (i.programId === MEMO_PROGRAM) { memo = i.data.toString('utf8'); continue; }
      if (i.programId === ATA_PROGRAM) {
        const [p, ata, owner, mint, sys, prog] = i.accounts;
        if (ata !== associatedTokenAddress(owner, mint) || sys !== SYSTEM_PROGRAM || prog !== TOKEN_PROGRAM || !t.signers.includes(p)) throw rpcErr('invalid ATA instruction');
        if (!tok.has(ata)) { tok.set(ata, { mint, owner, amount: 0n }); pay(p, 2_039_280); }
        continue;
      }
      if (i.programId === TOKEN_PROGRAM && i.data[0] === 12) {
        const [source, mint, dest, owner] = i.accounts;
        const amount = i.data.readBigUInt64LE(1);
        const src = tok.get(source);
        const dst = tok.get(dest);
        if (!src || !dst || src.mint !== mint || dst.mint !== mint) throw rpcErr('invalid account data for instruction');
        if (src.owner !== owner || !t.signers.includes(owner)) throw rpcErr('owner does not match');
        if (src.amount < amount) throw rpcErr('Error processing Instruction: custom program error: 0x1 (insufficient funds)');
        src.amount -= amount;
        dst.amount += amount;
        transfers.push({ from: source, to: dest, mint, amount });
        continue;
      }
      throw rpcErr(`unsupported program ${i.programId}`);
    }
    return { t, tok, lam, memo, transfers };
  }

  function land(r, { failed = false } = {}) {
    slot += 1;
    const err = failed ? { InstructionError: [3, { Custom: 1 }] } : null;
    if (!failed) {
      for (const [k, v] of r.tok) tokens.set(k, v);
      for (const [k, v] of r.lam) lamports.set(k, v);
    } else {
      lamports.set(r.t.keys[0], (lamports.get(r.t.keys[0]) || 0) - 5000);
    }
    statuses.set(r.t.signature, { slot, err, landedAt: height });
    const memo = r.memo != null ? `[${Buffer.byteLength(r.memo)}] ${r.memo}` : null;
    for (const a of new Set(r.t.keys)) {
      if (!sigsByAddr.has(a)) sigsByAddr.set(a, []);
      sigsByAddr.get(a).unshift({ signature: r.t.signature, slot, err, memo, blockTime: Math.floor(Date.now() / 1000), confirmationStatus: 'confirmed' });
    }
    // also visible to the deposit scanner, like any transaction on chain (token balances before/after)
    const bal = (map) => [...r.t.keys.entries()].filter(([, k]) => map.has(k)).map(([idx, k]) => ({
      accountIndex: idx, mint: map.get(k).mint, owner: map.get(k).owner, uiTokenAmount: { amount: String(map.get(k).amount), decimals: 6 } }));
    const before = new Map([...tokens].filter(([k]) => r.t.keys.includes(k)));
    txs.set(r.t.signature, { slot, meta: { err, fee: 5000, preTokenBalances: failed ? bal(before) : r.preBalances, postTokenBalances: bal(failed ? before : tokens) },
      transaction: { signatures: [r.t.signature], message: { accountKeys: r.t.keys } } });
    if (!failed) executed.push({ signature: r.t.signature, memo: r.memo, transfers: r.transfers });
  }

  async function rpc(method, params) {
    calls.push(method);
    if (method === 'sendTransaction') {
      const [b64, opts = {}] = params;
      const sig = (() => { try { return decodeTransaction(Buffer.from(b64, 'base64')).signature; } catch { return null; } })();
      // like a real node: the same transaction again fails preflight, or is silently ignored without preflight
      if (sig && statuses.has(sig)) {
        if (!opts.skipPreflight) throw rpcErr('Transaction simulation failed: This transaction has already been processed');
        return sig;
      }
      if (behave.reject > 0) { behave.reject--; throw rpcErr('Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1'); }
      const r = execute(b64);
      if (typeof r === 'string') return r;
      if (behave.drop > 0) { behave.drop--; return r.t.signature; } // accepted, then lost before it lands
      if (behave.delay > 0) { behave.delay--; delayed.push(b64); return r.t.signature; } // lands later
      r.preBalances = [...r.t.keys.entries()].filter(([, k]) => tokens.has(k)).map(([idx, k]) => ({
        accountIndex: idx, mint: tokens.get(k).mint, owner: tokens.get(k).owner, uiTokenAmount: { amount: String(tokens.get(k).amount), decimals: 6 } }));
      if (behave.landFailed > 0) { behave.landFailed--; land(r, { failed: true }); return r.t.signature; }
      land(r);
      if (behave.lostResponse > 0) { behave.lostResponse--; throw Object.assign(new Error('sendTransaction: network error (TimeoutError)'), { network: true }); }
      return r.t.signature;
    }
    if (method === 'getLatestBlockhash') {
      const blockhash = randomAddress();
      blockhashes.set(blockhash, height + 150);
      return { context: { slot }, value: { blockhash, lastValidBlockHeight: height + 150 } };
    }
    if (method === 'getBlockHeight') return height;
    if (method === 'getEpochInfo') {
      const fin = params?.[0]?.commitment === 'finalized';
      return { blockHeight: fin ? height - FINALITY : height, absoluteSlot: fin ? slot - 1 : slot, epoch: 1, slotIndex: 0, slotsInEpoch: 432000 };
    }
    if (method === 'getSignatureStatuses') {
      // a node behind the load balancer that is far behind the rest
      const ctx = { slot: behave.staleStatusNode ? slot - 1000 : slot };
      if (behave.statusLag > 0) { behave.statusLag--; return { context: ctx, value: params[0].map(() => null) }; }
      return { context: ctx, value: params[0].map((s) => {
        const st = statuses.get(s);
        if (!st) return null;
        return { slot: st.slot, confirmations: null, err: st.err, confirmationStatus: height - st.landedAt >= FINALITY ? 'finalized' : 'confirmed' };
      }) };
    }
    if (method === 'getTokenAccountBalance') {
      const a = tokens.get(params[0]);
      if (!a) throw Object.assign(new Error('getTokenAccountBalance: Invalid param: could not find account'), { rpcError: true, code: -32602 });
      return { context: { slot }, value: { amount: String(a.amount), decimals: 6, uiAmountString: String(Number(a.amount) / 1e6) } };
    }
    if (method === 'getBalance') return { context: { slot }, value: lamports.get(params[0]) || 0 };
    if (method === 'getAccountInfo') {
      const [addr] = params;
      if (tokens.has(addr)) return { context: { slot }, value: { owner: TOKEN_PROGRAM, executable: false, lamports: 2_039_280, data: ['', 'base64'] } };
      if (lamports.has(addr)) return { context: { slot }, value: { owner: SYSTEM_PROGRAM, executable: false, lamports: lamports.get(addr), data: ['', 'base64'] } };
      return { context: { slot }, value: null };
    }
    if (method === 'getMultipleAccounts') {
      return { context: { slot }, value: params[0].map((a) => (tokens.has(a)
        ? { owner: TOKEN_PROGRAM, data: { program: 'spl-token', parsed: { type: 'account', info: { mint: tokens.get(a).mint, owner: tokens.get(a).owner, tokenAmount: { amount: String(tokens.get(a).amount), decimals: 6 } } } } }
        : null)) };
    }
    if (method === 'getPriorityFeeEstimate') return { priorityFeeEstimate: 12_345 };
    if (method === 'getSignaturesForAddress') {
      const [addr, { limit = 1000, until, before } = {}] = params;
      let list = sigsByAddr.get(addr) || [];
      if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
      if (until) {
        const i = list.findIndex((s) => s.signature === until);
        if (i >= 0) list = list.slice(0, i);
      }
      return list.slice(0, limit).map((s) => ({ ...s }));
    }
    if (method === 'getTransaction') {
      const [sig] = params;
      if (hidden.has(sig) || !txs.has(sig)) return null;
      return structuredClone(txs.get(sig));
    }
    throw new Error(`fake chain: unexpected ${method}`);
  }

  // Helius webhook API
  const webhooks = new Map();
  const heliusCalls = [];
  const helius = {
    list: async () => { heliusCalls.push('list'); return [...webhooks.values()]; },
    get: async (id) => {
      heliusCalls.push('get');
      if (!webhooks.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
      return webhooks.get(id);
    },
    create: async (cfg) => {
      heliusCalls.push('create');
      const w = { ...cfg, webhookID: crypto.randomUUID(), active: true };
      webhooks.set(w.webhookID, w);
      return w;
    },
    update: async (id, cfg) => {
      heliusCalls.push('update');
      if (!webhooks.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
      webhooks.set(id, { ...webhooks.get(id), ...cfg });
      return webhooks.get(id);
    },
    activate: async (id) => {
      heliusCalls.push('activate');
      webhooks.get(id).active = true;
      return webhooks.get(id);
    },
  };

  return {
    rpc, helius, transfer, batch, addTx, webhookItem, hidden, calls, webhooks, heliusCalls,
    fund, tokenBalance, advance, behave, executed, lamports, tokens,
    // the slow transactions finally land, unless their blockhash expired meanwhile
    flush() {
      for (const b64 of delayed.splice(0)) {
        try {
          const r = execute(b64);
          if (typeof r === 'string') continue;
          r.preBalances = [];
          land(r);
        } catch {}
      }
    },
    get height() { return height; },
  };
}
