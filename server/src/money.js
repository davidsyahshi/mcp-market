// Balances are in $MCP, the market's unit: 1 $MCP = $1 = 1 USDC (or USDT). Amounts are stored as integer
// micro-units (1 $MCP = 1,000,000), the same 6 decimals as USDC and USDT on Solana, so a deposit is
// credited to the last unit and never rounded.
export const MICRO = 1_000_000;
export const UNIT = '$MCP';

export class MoneyError extends Error {}

// "1,234.50", "20", "0.24975": whole numbers stay whole, otherwise at least 2 decimals
export function amount(micro) {
  const n = BigInt(micro);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const whole = (a / 1_000_000n).toLocaleString('en-US');
  let frac = String(a % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  if (frac && frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

// "1,234.50 $MCP"
export const mcp = (micro) => `${amount(micro)} ${UNIT}`;

// micro-units to a plain number for JSON (exact up to 9 billion)
export const units = (micro) => (micro == null ? null : Number(micro) / MICRO);

// an amount typed by a person or an AI (12, 12.5, "12.50", "12.5 MCP") to micro-units.
// `decimals` caps the precision: prices have at most 2 decimals, withdrawals may go down to 6.
export function toMicro(value, { decimals = 2, what = 'Amount' } = {}) {
  const num = typeof value === 'string' ? Number(value.trim().replace(/^\$/, '').replace(/\s*\$?MCP$/i, '')) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) throw new MoneyError(`${what} must be an amount of ${UNIT} above zero.`);
  if (num > 9e9) throw new MoneyError(`${what} is too large.`);
  const fixed = num.toFixed(decimals);
  if (Math.abs(Number(fixed) - num) > 1e-9) {
    throw new MoneyError(decimals === 2 ? `${what} can have at most 2 decimals, like 12.50.` : `${what} has too many decimal places.`);
  }
  const [whole, frac = ''] = fixed.split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  if (micro <= 0n) throw new MoneyError(`${what} must be an amount of ${UNIT} above zero.`);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`${what} is too large.`);
  return Number(micro);
}

// an on-chain token amount (raw integer string, `decimals` places) to micro-units, rounding down
export function tokenToMicro(raw, decimals) {
  const n = BigInt(raw);
  if (decimals === 6) return n;
  return decimals < 6 ? n * 10n ** BigInt(6 - decimals) : n / 10n ** BigInt(decimals - 6);
}
