// Makes the deposit address pool on YOUR computer. The seed phrase stays with you (on paper); only public
// addresses come out, in a CSV you import into the database. Needs no network, so you can turn Wi-Fi off.
//
//   node server/scripts/deposit-pool.js --network mainnet                    first 10,000 addresses, new phrase
//   node server/scripts/deposit-pool.js --network mainnet --start 10000      the next batch, same phrase
//   options: --count 10000  --out <folder>
//
// It prints DEPOSIT_POOL_KEY (goes to Netlify) and writes deposit-pool-<network>-<from>-<to>.csv.
// The same phrase always gives the same addresses and the same key. Wallet #n is m/44'/501'/n'/0', which is
// "Account n+1" in Phantom or Solflare, so the phrase alone recovers every deposit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { seedFromMnemonic } from '../src/solana.js';
import { makePoolRows, poolCsv } from '../src/pool.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const network = opt('network');
const start = Number(opt('start', 0));
const count = Number(opt('count', 10000));
const outDir = path.resolve(opt('out', '.'));
const die = (msg) => { console.error(`\n${msg}`); process.exit(1); };

if (!['mainnet', 'devnet'].includes(network)) die('Say which network: --network mainnet (real money) or --network devnet (test server).');
if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1 || count > 100000) die('--start and --count must be whole numbers (count up to 100000).');
const file = path.join(outDir, `deposit-pool-${network}-${start}-${start + count - 1}.csv`);
if (fs.existsSync(file)) die(`${file} already exists. Move it away first.`);

const tty = process.stdin.isTTY && process.stdout.isTTY;

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

// typed characters are not shown
function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true); // before the prompt, so nothing typed is ever echoed
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

const clearScreen = () => process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

async function newPhrase() {
  const phrase = generateMnemonic(wordlist, 256);
  const words = phrase.split(' ');
  clearScreen();
  console.log('Your new seed phrase (24 words):\n');
  for (let r = 0; r < 6; r++) {
    console.log('  ' + [0, 6, 12, 18].map((c) => `${String(c + r + 1).padStart(2)}. ${words[c + r].padEnd(10)}`).join('  '));
  }
  console.log(`
Write these words on paper, in order, and keep the paper somewhere safe.
- Whoever has these words can take every deposit. Whoever loses them loses every deposit.
- Never type them into a website, a chat (Claude included), a cloud note or a screenshot.
- Netlify, Supabase and GitHub never need them.`);
  await ask('\nPress Enter when the words are on paper. The screen will be cleared. ');
  clearScreen();
  const check = crypto.randomInt(0, 12);
  for (const n of [check, check + 12]) {
    if ((await ask(`Type word #${n + 1} from your paper: `)).toLowerCase() !== words[n]) {
      die('That does not match. Nothing was saved. Run the script again and write the words carefully.');
    }
  }
  return phrase;
}

async function readPhrase() {
  if (!tty) {
    // piped in: node deposit-pool.js --network devnet < phrase.txt
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  console.log(`MCP deposit address pool: ${network}, wallets #${start}..#${start + count - 1}`);
  console.log('Runs offline. For extra safety turn Wi-Fi off now.\n');
  if (network === 'devnet') console.log('Devnet is for the test server only. Use a different phrase for mainnet.\n');
  const choice = start === 0
    ? await ask('1) Create a new seed phrase\n2) Use a phrase I already have\n> ')
    : '2';
  if (choice === '1') return newPhrase();
  if (choice !== '2') die('Type 1 or 2.');
  return askHidden(start === 0 ? 'Your seed phrase (hidden while you type): ' : `Seed phrase of this pool (hidden): `);
}

let seed;
try {
  seed = seedFromMnemonic(await readPhrase());
} catch (e) {
  die(`${e.message}. Nothing was saved.`);
}

process.stdout.write(`Making ${count.toLocaleString('en-US')} addresses...`);
const { key, rows } = makePoolRows(seed, network, start, count);
seed.fill(0);
fs.mkdirSync(outDir, { recursive: true });
const csv = poolCsv(rows);
fs.writeFileSync(file, csv);
const sha = crypto.createHash('sha256').update(csv).digest('hex');

console.log(` done.

File: ${file}
      ${rows.length.toLocaleString('en-US')} public addresses (#${start}..#${start + count - 1}), safe to share. SHA-256 ${sha.slice(0, 16)}

DEPOSIT_POOL_KEY=${key}
      Put this in Netlify as a secret environment variable. It can't move money; it only proves
      the addresses came from you. The same phrase always prints the same key.

Check: wallet #${rows[0].idx} is ${rows[0].address}
      (in Phantom/Solflare this phrase shows it as "Account ${rows[0].idx + 1}")

Next: Supabase -> Table Editor -> deposit_pool -> Insert -> Import data from CSV -> pick this file.`);
