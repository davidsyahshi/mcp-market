// The small slice of Solana this server needs, without a full SDK:
// - deposit wallets derived from one BIP39 phrase on the standard Solana path m/44'/501'/<index>'/0'
//   (the same path Phantom and Solflare use, so the phrase can be imported there to recover funds);
// - associated token account addresses (where a wallet receives USDC/USDT);
// - a JSON-RPC client (Helius or any Solana RPC) and the Helius webhook API.
// No private key is ever stored or logged; this module only derives public addresses.
import crypto from 'node:crypto';
import { base58 } from '@scure/base';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { ed25519 } from '@noble/curves/ed25519';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// Stablecoins accepted per network. USDC and USDT both have 6 decimals and use the classic token program.
export const STABLECOINS = {
  mainnet: [
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  ],
  // Circle's devnet USDC (free at faucet.circle.com). Tether has no official devnet token.
  devnet: [
    { symbol: 'USDC', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  ],
};

export const isAddress = (s) => {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
};

// ---------- keys ----------

export function seedFromMnemonic(phrase) {
  const words = String(phrase || '').trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(words, wordlist)) throw new Error('That is not a valid 12 or 24 word BIP39 seed phrase');
  return Buffer.from(mnemonicToSeedSync(words));
}

// SLIP-0010 ed25519 derivation (hardened steps only, as ed25519 requires)
function slip10(seed, path) {
  let I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  for (const index of path) {
    const data = Buffer.alloc(37);
    I.copy(data, 1, 0, 32);
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
    I = crypto.createHmac('sha512', I.subarray(32)).update(data).digest();
  }
  return I.subarray(0, 32);
}

// wallet #index under the phrase: m/44'/501'/index'/0'. Only the owner's scripts ever need the secret.
export function deriveKeypair(seed, index) {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error('bad derivation index');
  const secret = Buffer.from(slip10(seed, [44, 501, index, 0]));
  return { publicKey: base58.encode(ed25519.getPublicKey(secret)), seed: secret };
}

// public address of wallet #index under the phrase
export function deriveAddress(seed, index) {
  const kp = deriveKeypair(seed, index);
  kp.seed.fill(0);
  return kp.publicKey;
}

// ---------- program derived addresses ----------

function onCurve(bytes) {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

// a wallet: a public key on the ed25519 curve. Associated token accounts and other program addresses are off the
// curve, so a token account pasted in place of the wallet is caught without asking the network
export const isWallet = (s) => isAddress(s) && onCurve(base58.decode(s));

export function findProgramAddress(seeds, programId) {
  const program = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256')
      .update(Buffer.concat([...seeds.map((s) => Buffer.from(s)), Buffer.from([bump]), program, Buffer.from('ProgramDerivedAddress')]))
      .digest();
    if (!onCurve(h)) return base58.encode(h);
  }
  throw new Error('no program address found');
}

// where `owner` receives tokens of `mint`
export const associatedTokenAddress = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  findProgramAddress([base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)], ATA_PROGRAM);

// ---------- network ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSON-RPC client. Errors never include the URL, which carries the API key. An error the node answered
// with (e.g. a rejected transaction) has err.rpcError = true and err.code; a failed connection has
// err.network = true, which for sendTransaction means "unknown whether it was received".
export function makeRpc(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  let id = 0;
  return async function rpc(method, params) {
    // a sendTransaction is never repeated here: a second try could hide that the first one got through
    const retries = method === 'sendTransaction' ? 0 : 1;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (attempt < retries) continue;
        throw Object.assign(new Error(`${method}: network error (${e.name})`), { network: true });
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries * 2) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      const j = await res.json().catch(() => null);
      if (j?.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpcError: true, code: j.error.code, data: j.error.data });
      if (!res.ok || !j) throw Object.assign(new Error(`${method}: HTTP ${res.status}`), { network: true });
      return j.result;
    }
  };
}

export const heliusRpcUrl = (cluster, apiKey) => `https://${cluster === 'mainnet' ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;

// Helius webhook management (https://www.helius.dev/docs/webhooks). One host serves mainnet and devnet webhooks.
export function makeHeliusApi(apiKey, { fetchImpl = globalThis.fetch } = {}) {
  const base = 'https://api-mainnet.helius-rpc.com/v0/webhooks';
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}?api-key=${encodeURIComponent(apiKey)}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const textBody = await res.text();
    if (!res.ok) {
      const err = new Error(`Helius ${method} webhooks: HTTP ${res.status} ${textBody.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return textBody ? JSON.parse(textBody) : null;
  };
  return {
    list: () => call('GET', ''),
    get: (id) => call('GET', `/${id}`),
    create: (cfg) => call('POST', '', cfg),
    update: (id, cfg) => call('PUT', `/${id}`, cfg),
    activate: (id) => call('PATCH', `/${id}`, { active: true }),
  };
}
