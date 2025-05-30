// The deposit address pool. Deposit addresses are made offline, on the owner's computer, from a seed phrase
// that never reaches the server (server/scripts/deposit-pool.js). The server only ever sees public addresses,
// so it can watch them and credit deposits but can't move a cent out of them, even if it is fully compromised.
//
// Each pool row carries an HMAC of (network, index, address) made with DEPOSIT_POOL_KEY. The key is derived
// from the phrase, so the owner can recreate it for every new batch, and it reveals nothing about the phrase.
// The server shows and credits only rows whose HMAC checks out, so someone who can write to the database
// but doesn't have the key can't slip in an address of their own.
import crypto from 'node:crypto';
import { deriveAddress, isAddress } from './solana.js';

export const POOL_KEY = /^[0-9a-f]{64}$/;

export const poolKeyFromSeed = (seed) => crypto.createHmac('sha256', seed).update('mcp/deposit-pool').digest('hex');

export const poolMac = (key, network, idx, address) =>
  crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(`mcp-pool:${network}:${idx}:${address}`).digest('hex');

export function poolRowValid(key, row) {
  if (!row || !isAddress(row.address) || typeof row.mac !== 'string' || !/^[0-9a-f]{64}$/.test(row.mac)) return false;
  const want = Buffer.from(poolMac(key, row.network, row.idx, row.address), 'hex');
  return crypto.timingSafeEqual(want, Buffer.from(row.mac, 'hex'));
}

// rows for indexes start..start+count-1: wallet idx is m/44'/501'/idx'/0' (Phantom "Account idx+1")
export function makePoolRows(seed, network, start, count) {
  const key = poolKeyFromSeed(seed);
  const rows = [];
  for (let idx = start; idx < start + count; idx++) {
    const address = deriveAddress(seed, idx);
    rows.push({ network, idx, address, mac: poolMac(key, network, idx, address) });
  }
  return { key, rows };
}

export const POOL_CSV_HEADER = 'network,idx,address,mac';
export const poolCsv = (rows) => [POOL_CSV_HEADER, ...rows.map((r) => `${r.network},${r.idx},${r.address},${r.mac}`)].join('\n') + '\n';

export function parsePoolCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.shift()?.trim() !== POOL_CSV_HEADER) throw new Error(`first line must be "${POOL_CSV_HEADER}"`);
  return lines.filter(Boolean).map((l) => {
    const [network, idx, address, mac] = l.trim().split(',');
    return { network, idx: Number(idx), address, mac };
  });
}

// running low: under 500 free, or under 10% for a small pool
export const poolLow = ({ total, free }) => free < Math.max(1, Math.min(500, total * 0.1));

// what the scheduled scan reports, and what the owner checks before the pool runs dry
export async function poolStats(db, network) {
  const [r] = await db.query(`select count(*)::int as total, count(*) filter (where user_id is null)::int as free
    from deposit_pool where network = $1`, [network]);
  return r;
}
