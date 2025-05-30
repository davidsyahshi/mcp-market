// The transaction encoder against a frozen vector. The vector was produced by this code and checked with
// @solana/web3.js + @solana/spl-token when written: same instructions, same account flags, valid signature,
// byte-exact message round trip (50 random payouts and two-signer sweeps). Ed25519 signatures are
// deterministic, so any change to the encoding shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keypairFromSeed, signTransaction, decodeTransaction, ix, MEMO_PROGRAM, COMPUTE_BUDGET_PROGRAM } from '../src/tx.js';
import { associatedTokenAddress, STABLECOINS, TOKEN_PROGRAM, ATA_PROGRAM } from '../src/solana.js';

const USDC = STABLECOINS.mainnet[0].mint;
const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

test('payout transaction matches the vector checked against web3.js', () => {
  const kp = keypairFromSeed(Buffer.alloc(32, 7));
  assert.equal(kp.publicKey, 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
  const to = associatedTokenAddress(USER, USDC);
  const t = signTransaction({
    payer: kp.publicKey, recentBlockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', signers: [kp],
    instructions: [ix.computeUnitLimit(60000), ix.computeUnitPrice(5000), ix.createAtaIdempotent({ payer: kp.publicKey, ata: to, owner: USER, mint: USDC }),
      ix.transferChecked({ source: associatedTokenAddress(kp.publicKey, USDC), mint: USDC, destination: to, owner: kp.publicKey, amount: 49500000n, decimals: 6 }),
      ix.memo('mcp:w:mainnet:1')],
  });
  assert.equal(t.signature, '4yocwtXBnwctwJrgeou9jbAAnNBDZHWW9vKGR96S6YZsibebcfMKXVazEfKKoXhATRfjvZ4aBPFvmdsZSJ1MsQ9o');
  assert.equal(t.base64, 'AccJU0EuhETsS9ZjYnd6xJ7nccaoIub7rTqyiXzpma4tm07m/nluTzNaJ82cyew/vpxfrNEeN7NGKomxOUMVNgoBAAcK6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0izT6oz1rKyozQUgdRIXXEPO9Upd2Z7eIKFrVSU3OPOX3GcwLkkYlNdJLqa+T5FOpPRfoULmRYZ8kWSidtXddvB2AwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAB+jAiHYL/eHd3PMsF/IJuCQu5SqvEx+s2I0OosbQsG8sb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11hAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8AqYyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZBUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQUDAAUCYOoAAAMACQOIEwAAAAAAAAgGAAEEBQYHAQEHBAIFAQAKDGBP8wIAAAAABgkAD21jcDp3Om1haW5uZXQ6MQ==');
  const d = decodeTransaction(t.bytes);
  assert.ok(d.verified);
  assert.deepEqual(d.instructions.map((i) => i.programId), [COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM]);
  assert.deepEqual(d.writable.sort(), [kp.publicKey, to, associatedTokenAddress(kp.publicKey, USDC)].sort());
  const bad = Buffer.from(t.bytes);
  bad[bad.length - 1] ^= 1;
  assert.equal(decodeTransaction(bad).verified, false);
});

test('a transaction needs every signer it names', () => {
  const a = keypairFromSeed(Buffer.alloc(32, 1));
  const b = keypairFromSeed(Buffer.alloc(32, 2));
  const args = { payer: a.publicKey, recentBlockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
    instructions: [ix.transferChecked({ source: USER, mint: USDC, destination: USER, owner: b.publicKey, amount: 1n, decimals: 6 })] };
  assert.throws(() => signTransaction({ ...args, signers: [a] }), /missing signer/);
  const t = signTransaction({ ...args, signers: [b, a] });
  const d = decodeTransaction(t.bytes);
  assert.deepEqual(d.signers, [a.publicKey, b.publicKey], 'fee payer signs first');
  assert.ok(d.verified);
});
