// Moves deposits out of the pool addresses to ONE address you choose: the payout hot wallet (to fund
// withdrawals) or your own cold wallet. Runs on YOUR computer: it needs the seed phrase, which never goes
// to the server. It first only shows what it found; nothing moves until you add --send and confirm.
//
//   npm run sweep -- --network mainnet --to <address>           look: balances, totals, fees needed
//   npm run sweep -- --network mainnet --to <address> --send    move them
//   options: --count 10000  (pool wallets to check, from #0)   --min 1  (skip smaller balances)
//            --rpc <url>    (default: SOLANA_RPC_URL, then HELIUS_API_KEY, then the public Solana RPC)
//
// Network fees are paid by a "fees wallet" made from the same phrase (shown when you run it). Send it
// about 0.05 SOL once; deposit addresses never need SOL. Token accounts are left open, so future deposits
// to the same addresses keep working.
import readline from 'node:readline/promises';
import * as sol from '../src/solana.js';
import { signTransaction, ix } from '../src/tx.js';
import { amount as plain } from '../src/money.js';

const FEES_INDEX = 2147483647; // m/44'/501'/2147483647'/0': never a pool address
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const die = (msg) => { console.error(`\n${msg}`); process.exit(1); };
const network = opt('network');
const to = opt('to');
const count = Number(opt('count', 10000));
const min = BigInt(Math.round(Number(opt('min', 1)) * 1e6));
const send = flag('send');
if (!['mainnet', 'devnet'].includes(network)) die('Say which network: --network mainnet or --network devnet.');
if (!sol.isAddress(to || '')) die('Say where to: --to <Solana wallet address> (the payout wallet or your own wallet).');
if (!Number.isInteger(count) || count < 1 || count > 100000) die('--count must be 1..100000.');
const rpcUrl = opt('rpc') || process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY ? sol.heliusRpcUrl(network, process.env.HELIUS_API_KEY)
  : network === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const rpc = sol.makeRpc(rpcUrl, { timeoutMs: 20000 });
const tokens = sol.STABLECOINS[network];
const tty = process.stdin.isTTY && process.stdout.isTTY;
const explorer = (sig) => `https://solscan.io/tx/${sig}${network === 'mainnet' ? '' : `?cluster=${network}`}`;

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    process.stdout.write(q);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(s);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPhrase() {
  if (tty) return askHidden('Seed phrase of the deposit pool (hidden while you type): ');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

let seed;
try {
  seed = sol.seedFromMnemonic(await readPhrase());
} catch (e) {
  die(`${e.message}. Nothing was sent.`);
}

const fees = sol.deriveKeypair(seed, FEES_INDEX);
// the destination must not be one of the pool's own addresses: the server would credit that wallet's user
process.stdout.write(`Checking ${count.toLocaleString('en-US')} deposit wallets on ${network}...`);
const addresses = Array.from({ length: Math.max(count, 10000) }, (_, i) => sol.deriveAddress(seed, i));
const poolIdx = addresses.indexOf(to);
if (poolIdx >= 0) die(`${to} is deposit wallet #${poolIdx} of this pool (in Phantom: "Account ${poolIdx + 1}"). Send to the payout wallet or a wallet of your own that is not from this phrase. Nothing was sent.`);
if (to === fees.publicKey) die('That is the fees wallet of this pool. Choose another destination. Nothing was sent.');
const destInfo = (await rpc('getAccountInfo', [to, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
if (destInfo && (destInfo.executable || [sol.TOKEN_PROGRAM, sol.TOKEN_2022_PROGRAM].includes(destInfo.owner))) {
  die(`${to} is a token account, not a wallet. Give the wallet address itself. Nothing was sent.`);
}

// balances of every pool wallet's USDC/USDT accounts
const wallets = [];
for (let i = 0; i < count; i++) {
  const address = addresses[i];
  wallets.push({ idx: i, address, accounts: tokens.map((t) => ({ ...t, ata: sol.associatedTokenAddress(address, t.mint), amount: 0n })) });
}
const all = wallets.flatMap((w) => w.accounts);
for (let i = 0; i < all.length; i += 100) {
  const chunk = all.slice(i, i + 100);
  const r = await rpc('getMultipleAccounts', [chunk.map((a) => a.ata), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  r.value.forEach((v, k) => {
    const info = v?.data?.parsed?.info;
    if (info && info.mint === chunk[k].mint) chunk[k].amount = BigInt(info.tokenAmount.amount);
  });
}
const todo = wallets.map((w) => ({ ...w, moving: w.accounts.filter((a) => a.amount >= min && a.amount > 0n) })).filter((w) => w.moving.length);
const totals = Object.fromEntries(tokens.map((t) => [t.symbol, todo.reduce((s, w) => s + (w.moving.find((a) => a.mint === t.mint)?.amount || 0n), 0n)]));
console.log(' done.\n');
for (const w of todo) console.log(`  #${w.idx} ${w.address}: ${w.moving.map((a) => `${plain(a.amount)} ${a.symbol}`).join(', ')}`);
console.log(`\n${todo.length} wallet(s) to move: ${Object.entries(totals).map(([s, v]) => `${plain(v)} ${s}`).join(' + ')}  ->  ${to}`);

// fees: one transaction per wallet, plus creating the destination's token account once per token if needed
const destAtas = await rpc('getMultipleAccounts', [tokens.map((t) => sol.associatedTokenAddress(to, t.mint)), { encoding: 'base64', commitment: 'confirmed' }]);
const missing = tokens.filter((t, k) => !destAtas.value[k] && totals[t.symbol] > 0n).length;
const need = todo.length * 15_000 + missing * 2_039_280;
const have = (await rpc('getBalance', [fees.publicKey, { commitment: 'confirmed' }])).value;
console.log(`Fees wallet: ${fees.publicKey}  (${have / 1e9} SOL, needs about ${(need / 1e9).toFixed(6)} SOL)`);
if (tokens.length > 1 && totals.USDT > 0n) console.log('Note: USDT moves as USDT. Payouts are in USDC, so swap USDT you send to the payout wallet.');
if (!todo.length) { console.log('\nNothing to move.'); process.exit(0); }
if (have < need) die(`Send at least ${((need - have) / 1e9 + 0.01).toFixed(3)} SOL to the fees wallet ${fees.publicKey} first. Nothing was sent.`);
if (!send) { console.log('\nNothing was sent. Run again with --send to move it.'); process.exit(0); }
if (tty) {
  if ((await ask(`\nType SEND to move it all to ${to}: `)) !== 'SEND') die('Cancelled. Nothing was sent.');
} else if (!flag('yes')) {
  die('Not a terminal: add --yes to confirm. Nothing was sent.');
}

let moved = 0;
for (const w of todo) {
  const kp = sol.deriveKeypair(seed, w.idx);
  const instructions = [ix.computeUnitLimit(100_000), ix.computeUnitPrice(20_000)];
  for (const a of w.moving) {
    const dest = sol.associatedTokenAddress(to, a.mint);
    instructions.push(ix.createAtaIdempotent({ payer: fees.publicKey, ata: dest, owner: to, mint: a.mint }),
      ix.transferChecked({ source: a.ata, mint: a.mint, destination: dest, owner: kp.publicKey, amount: a.amount, decimals: 6 }));
  }
  instructions.push(ix.memo('mcp:sweep'));
  try {
    const { value: bh } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = signTransaction({ payer: fees.publicKey, recentBlockhash: bh.blockhash, signers: [fees, kp], instructions });
    await rpc('sendTransaction', [tx.base64, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
    let ok = false;
    for (let k = 0; k < 40 && !ok; k++) {
      const st = (await rpc('getSignatureStatuses', [[tx.signature], { searchTransactionHistory: true }])).value[0];
      if (st?.err) throw new Error(`failed on chain: ${JSON.stringify(st.err)}`);
      ok = ['confirmed', 'finalized'].includes(st?.confirmationStatus);
      if (!ok) await new Promise((r) => setTimeout(r, 750));
    }
    if (!ok) throw new Error(`not confirmed yet, check ${explorer(tx.signature)} before running again`);
    moved++;
    console.log(`  ok #${w.idx}: ${w.moving.map((a) => `${plain(a.amount)} ${a.symbol}`).join(', ')}  ${explorer(tx.signature)}`);
  } catch (e) {
    console.log(`  FAILED #${w.idx}: ${e.message}`);
  } finally {
    kp.seed.fill(0);
  }
}
seed.fill(0);
fees.seed.fill(0);
console.log(`\nMoved ${moved} of ${todo.length}.`);
process.exit(moved === todo.length ? 0 : 1);
