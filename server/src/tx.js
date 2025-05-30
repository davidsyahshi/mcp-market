// Building and signing Solana transactions without an SDK: the handful of instructions payouts and sweeps
// need (SPL TransferChecked, create-associated-token-account-idempotent, memo, compute budget), legacy
// message compilation, ed25519 signing, and decoding for checks. Verified against @solana/web3.js
// (see test/tx.test.js for frozen vectors).
//
// The transaction id is the first signature, so it is known BEFORE the transaction is broadcast. Payouts
// record it first and only then send, which is what makes them safe to retry.
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { TOKEN_PROGRAM, ATA_PROGRAM } from './solana.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

// ---------- keys ----------

// A wallet's secret key as Phantom/Solflare export it (base58, 64 bytes), as solana-keygen writes it
// (JSON array of 64 numbers), or a bare 32-byte seed.
export function keypairFromSecret(input) {
  const s = String(input || '').trim();
  let bytes;
  try {
    bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58.decode(s);
  } catch {
    throw new Error('not a Solana secret key (base58 or JSON array expected)');
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('a Solana secret key is 64 bytes');
  const seed = Buffer.from(bytes.subarray(0, 32));
  const publicKey = base58.encode(ed25519.getPublicKey(seed));
  if (bytes.length === 64 && base58.encode(bytes.subarray(32)) !== publicKey) throw new Error('secret key and public key do not match');
  return { publicKey, seed };
}

export const keypairFromSeed = (seed32) => ({ publicKey: base58.encode(ed25519.getPublicKey(seed32)), seed: Buffer.from(seed32) });

// ---------- instructions ----------

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

export const ix = {
  // SPL Token TransferChecked: moves `amount` raw units of `mint` from one token account to another
  transferChecked: ({ source, mint, destination, owner, amount, decimals }) => ({
    programId: TOKEN_PROGRAM,
    keys: [meta(source, false, true), meta(mint, false, false), meta(destination, false, true), meta(owner, true, false)],
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  }),
  // creates `owner`'s token account for `mint` if it doesn't exist yet; does nothing if it does
  createAtaIdempotent: ({ payer, ata, owner, mint }) => ({
    programId: ATA_PROGRAM,
    keys: [meta(payer, true, true), meta(ata, false, true), meta(owner, false, false), meta(mint, false, false),
      meta(SYSTEM_PROGRAM, false, false), meta(TOKEN_PROGRAM, false, false)],
    data: Buffer.from([1]),
  }),
  memo: (text) => ({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(String(text), 'utf8') }),
  computeUnitLimit: (units) => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([2]), u32(units)]) }),
  computeUnitPrice: (microLamports) => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([3]), u64(microLamports)]) }),
};

// ---------- compile & sign ----------

function shortvec(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return Buffer.from(out);
  }
}

// Legacy message: header, account keys (signers first, then writable before read-only), blockhash, instructions.
export function compileMessage({ payer, instructions, recentBlockhash }) {
  const accounts = new Map([[payer, { isSigner: true, isWritable: true }]]);
  const add = (pubkey, isSigner, isWritable) => {
    const cur = accounts.get(pubkey);
    if (cur) {
      cur.isSigner ||= isSigner;
      cur.isWritable ||= isWritable;
    } else {
      accounts.set(pubkey, { isSigner, isWritable });
    }
  };
  for (const i of instructions) {
    for (const k of i.keys) add(k.pubkey, k.isSigner, k.isWritable);
    add(i.programId, false, false);
  }
  const rank = ([key, a]) => (key === payer ? -1 : (a.isSigner ? 0 : 2) + (a.isWritable ? 0 : 1));
  const keys = [...accounts.entries()].sort((x, y) => rank(x) - rank(y)); // stable: keeps first-seen order inside a group
  const index = new Map(keys.map(([k], i) => [k, i]));
  const signers = keys.filter(([, a]) => a.isSigner);
  const header = Buffer.from([
    signers.length,
    signers.filter(([, a]) => !a.isWritable).length,
    keys.filter(([, a]) => !a.isSigner && !a.isWritable).length,
  ]);
  const body = [header, shortvec(keys.length), ...keys.map(([k]) => Buffer.from(base58.decode(k))), Buffer.from(base58.decode(recentBlockhash)), shortvec(instructions.length)];
  for (const i of instructions) {
    body.push(Buffer.from([index.get(i.programId)]), shortvec(i.keys.length), Buffer.from(i.keys.map((k) => index.get(k.pubkey))), shortvec(i.data.length), i.data);
  }
  return { message: Buffer.concat(body), signerKeys: signers.map(([k]) => k) };
}

// Signs with every required signer. Returns the wire bytes and the transaction id (first signature).
export function signTransaction({ payer, instructions, recentBlockhash, signers }) {
  const { message, signerKeys } = compileMessage({ payer, instructions, recentBlockhash });
  const byKey = new Map(signers.map((s) => [s.publicKey, s]));
  const sigs = signerKeys.map((k) => {
    const s = byKey.get(k);
    if (!s) throw new Error(`missing signer ${k}`);
    return Buffer.from(ed25519.sign(message, s.seed));
  });
  const bytes = Buffer.concat([shortvec(sigs.length), ...sigs, message]);
  return { bytes, base64: bytes.toString('base64'), signature: base58.encode(sigs[0]), message };
}

// ---------- decode (for checks and the test chain) ----------

function readShortvec(buf, o) {
  let n = 0;
  let shift = 0;
  for (;;) {
    const b = buf[o.i++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return n;
    shift += 7;
  }
}

export function decodeTransaction(bytes) {
  const buf = Buffer.from(bytes);
  const o = { i: 0 };
  const nsig = readShortvec(buf, o);
  const signatures = [];
  for (let k = 0; k < nsig; k++, o.i += 64) signatures.push(buf.subarray(o.i, o.i + 64));
  const message = buf.subarray(o.i);
  if (message[0] & 0x80) throw new Error('versioned transactions are not supported here');
  const [numSigners, numReadonlySigned, numReadonlyUnsigned] = message;
  o.i += 3;
  const nkeys = readShortvec(buf, o);
  const keys = [];
  for (let k = 0; k < nkeys; k++, o.i += 32) keys.push(base58.encode(buf.subarray(o.i, o.i + 32)));
  const recentBlockhash = base58.encode(buf.subarray(o.i, o.i + 32));
  o.i += 32;
  const nix = readShortvec(buf, o);
  const instructions = [];
  for (let k = 0; k < nix; k++) {
    const programId = keys[buf[o.i++]];
    const nacc = readShortvec(buf, o);
    const accounts = [...buf.subarray(o.i, o.i + nacc)].map((x) => keys[x]);
    o.i += nacc;
    const ndata = readShortvec(buf, o);
    const data = buf.subarray(o.i, o.i + ndata);
    o.i += ndata;
    instructions.push({ programId, accounts, data });
  }
  const isWritable = (idx) => (idx < numSigners ? idx < numSigners - numReadonlySigned : idx < nkeys - numReadonlyUnsigned);
  const verified = signatures.every((sig, k) => {
    try {
      return ed25519.verify(sig, message, base58.decode(keys[k]));
    } catch {
      return false;
    }
  });
  return {
    signature: signatures[0] ? base58.encode(signatures[0]) : null,
    signers: keys.slice(0, numSigners),
    writable: keys.filter((_, idx) => isWritable(idx)),
    keys, recentBlockhash, instructions, verified,
  };
}
