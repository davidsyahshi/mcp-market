// Market rules: balances, mint, listings, buys. Every balance change writes a ledger row
// in the same transaction, so sum(ledger) per user always equals users.balance.
// All amounts are integer micro-units of $MCP, 1 $MCP = $1 (see money.js).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { mcp, toMicro, MoneyError } from './money.js';

export const CONFIG = {
  mintPrice: toMicro(process.env.MINT_PRICE_USD || '5'),
  mintLimit: Number(process.env.MINT_LIMIT_PER_USER || 5),
  feeBps: Number(process.env.FEE_BPS || 250), // 2.5% market fee to the treasury
  faucetAmount: toMicro(process.env.FAUCET_USD || '20'),
  testMode: process.env.TEST_MODE === '1',
};

// rule violations the assistant should relay to the user as a normal answer
export class MarketError extends MoneyError {}
const fail = (msg) => { throw new MarketError(msg); };

export const fmt = mcp;
export const CENT = 10_000; // 0.01 $MCP in micro-units
export const feeOf = (price) => Math.floor((Number(price) * CONFIG.feeBps) / 10000);
export const nftName = (id) => `MCP #${String(id).padStart(4, '0')}`;

export async function seedCollection(db, collectionPath) {
  const items = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const [{ n }] = await db.query('select count(*)::int as n from nfts');
  if (n > 0) return n;
  await db.tx(async (t) => {
    for (const it of items) {
      await t.query('insert into nfts (id, name, character, shape, palette, rarity) values ($1,$2,$3,$4,$5,$6) on conflict do nothing',
        [it.id, it.name, it.character, it.shape, it.palette, it.rarity]);
    }
  });
  return items.length;
}

// An account's public MCP address: "mcp_" and 12 random base58 characters. The underscore is not base58, so it
// can never be mistaken for (or pasted as) a Solana address. It is an account number, not a wallet.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const newPublicId = () => 'mcp_' + [...crypto.randomBytes(12)].map((b) => B58[b % 58]).join('');
export const isPublicId = (s) => /^mcp_[1-9A-HJ-NP-Za-km-z]{12}$/.test(String(s || ''));

export async function upsertUser(db, { xId, handle, name, avatar }) {
  const rows = await db.query(
    `insert into users (x_id, handle, name, avatar, public_id) values ($1, $2, $3, $4, $5)
     on conflict (x_id) do update set handle = excluded.handle, name = excluded.name, avatar = excluded.avatar
     returning *`, [xId, handle.toLowerCase(), name || handle, avatar || null, newPublicId()]);
  if (!rows[0].public_id) await ensurePublicIds(db);
  return rows[0].public_id ? rows[0] : getUser(db, rows[0].id);
}

// gives every account made before MCP addresses existed its own
export async function ensurePublicIds(db) {
  const rows = await db.query('select id from users where public_id is null');
  for (const { id } of rows) {
    for (let tries = 0; tries < 3; tries++) {
      try {
        await db.query('update users set public_id = $1 where id = $2 and public_id is null', [newPublicId(), id]);
        break;
      } catch (e) {
        if (e.code !== '23505') throw e; // the same random address twice: try another
      }
    }
  }
  return rows.length;
}

export async function setShowHandle(db, userId, show) {
  return (await db.query('update users set show_handle = $1 where id = $2 returning *', [!!show, userId]))[0];
}

// how public pages and the chat name an account: its X handle only if the user chose to show it
export const label = (addr, name) => (name ? `@${name}` : addr || 'nobody');

export async function getUser(db, id) {
  return (await db.query('select * from users where id = $1', [id]))[0];
}

async function move(t, userId, delta, kind, ref) {
  if (userId != null) {
    const rows = await t.query('update users set balance = balance + $1 where id = $2 and balance + $1 >= 0 returning balance', [delta, userId]);
    if (!rows.length) fail('Not enough $MCP on your balance.');
  }
  await t.query('insert into ledger (user_id, delta, kind, ref) values ($1, $2, $3, $4)', [userId, delta, kind, ref]);
}

export async function credit(db, userId, amount, kind, ref) {
  if (!(amount > 0)) fail('Amount must be positive.');
  return db.tx(async (t) => {
    if (kind === 'deposit' && ref) {
      const dup = await t.query("select 1 from ledger where kind = 'deposit' and ref = $1", [ref]);
      if (dup.length) return { duplicate: true };
    }
    await move(t, userId, amount, kind, ref);
    return { duplicate: false };
  });
}

export async function faucet(db, userId) {
  if (!CONFIG.testMode) fail('The faucet only exists on the test server.');
  const recent = await db.query("select 1 from ledger where user_id = $1 and kind = 'faucet' and created_at > now() - interval '1 day'", [userId]);
  if (recent.length) fail('Faucet already used today.');
  await credit(db, userId, CONFIG.faucetAmount, 'faucet', 'test');
  return CONFIG.faucetAmount;
}

export async function mint(db, userId) {
  return db.tx(async (t) => {
    const mintedByUser = (await t.query("select count(*)::int as n from ledger where user_id = $1 and kind = 'mint'", [userId]))[0].n;
    if (mintedByUser >= CONFIG.mintLimit) fail(`Mint limit reached: ${CONFIG.mintLimit} per account.`);
    const free = await t.query('select * from nfts where minted_at is null order by random() limit 1 for update skip locked');
    if (!free.length) fail('Sold out: every NFT in the collection is minted. Check the market.');
    const nft = free[0];
    await move(t, userId, -CONFIG.mintPrice, 'mint', String(nft.id));
    await move(t, null, CONFIG.mintPrice, 'mint', String(nft.id));
    const [row] = await t.query('update nfts set owner_id = $1, minted_at = now() where id = $2 returning *', [userId, nft.id]);
    return row;
  });
}

export async function list(db, userId, nftId, price) {
  if (!Number.isInteger(price) || price <= 0 || price % CENT) fail('Price must be above zero with at most 2 decimals.');
  const rows = await db.query('update nfts set price = $1, listed_at = now() where id = $2 and owner_id = $3 returning *', [price, nftId, userId]);
  if (!rows.length) fail(`You don't own ${nftName(nftId)}.`);
  return rows[0];
}

export async function unlist(db, userId, nftId) {
  const rows = await db.query('update nfts set price = null, listed_at = null where id = $1 and owner_id = $2 returning *', [nftId, userId]);
  if (!rows.length) fail(`You don't own ${nftName(nftId)}.`);
  return rows[0];
}

export async function buy(db, buyerId, nftId, expectedPrice) {
  return db.tx(async (t) => {
    const [nft] = await t.query('select * from nfts where id = $1 for update', [nftId]);
    if (!nft) fail(`${nftName(nftId)} does not exist.`);
    if (nft.price == null) fail(`${nftName(nftId)} is not for sale.`);
    if (nft.owner_id === buyerId) fail('You already own this NFT.');
    const price = Number(nft.price);
    // the buyer agreed to a price; never charge more than that
    if (expectedPrice != null && price !== expectedPrice) fail(`Price changed: ${nftName(nftId)} now costs ${fmt(price)}. Confirm the new price first.`);
    const fee = feeOf(price);
    await move(t, buyerId, -price, 'buy', String(nftId));
    await move(t, nft.owner_id, price - fee, 'sale', String(nftId));
    if (fee) await move(t, null, fee, 'fee', String(nftId));
    await t.query('insert into sales (nft_id, seller_id, buyer_id, price) values ($1, $2, $3, $4)', [nftId, nft.owner_id, buyerId, price]);
    const [row] = await t.query('update nfts set owner_id = $1, price = null, listed_at = null where id = $2 returning *', [buyerId, nftId]);
    return { nft: row, price, fee };
  });
}

// Withdrawals (binding the address, requests, payouts) live in withdrawals.js.

// ---------- read side, shared by the MCP tools and the public preview API ----------

// owner_addr: the owner's MCP address; owner_name: their X handle, only when they chose to show it
const NFT_COLS = `n.id, n.name, n.character, n.shape, n.palette, n.rarity, n.price, n.listed_at, n.minted_at,
  u.public_id as owner_addr, case when u.show_handle then u.handle end as owner_name`;
export const PUBLIC_NAME = (alias, as) => `${alias}.public_id as ${as}_addr, case when ${alias}.show_handle then ${alias}.handle end as ${as}_name`;

export async function getNft(db, id) {
  const [nft] = await db.query(`select ${NFT_COLS} from nfts n left join users u on u.id = n.owner_id where n.id = $1`, [id]);
  if (!nft) return null;
  nft.history = await db.query(
    `select s.price, s.created_at, ${PUBLIC_NAME('se', 'seller')}, ${PUBLIC_NAME('b', 'buyer')} from sales s
     join users se on se.id = s.seller_id join users b on b.id = s.buyer_id where s.nft_id = $1 order by s.id desc limit 20`, [id]);
  return nft;
}

// ownerId: one account's NFTs (the account's own view); ownerAddr: by public MCP address
export async function browse(db, { status = 'all', sort = 'id', character, rarity, ownerId, ownerAddr, limit = 200, offset = 0 } = {}) {
  const where = [];
  const p = [];
  if (status === 'listed') where.push('n.price is not null');
  if (status === 'unminted') where.push('n.minted_at is null');
  if (status === 'minted') where.push('n.minted_at is not null');
  if (character) { p.push(character); where.push(`lower(n.character) = lower($${p.length})`); }
  if (rarity) { p.push(rarity); where.push(`n.rarity = $${p.length}`); }
  if (ownerId != null) { p.push(ownerId); where.push(`n.owner_id = $${p.length}`); }
  if (ownerAddr) { p.push(ownerAddr); where.push(`u.public_id = $${p.length}`); }
  const order = { price_asc: 'n.price asc nulls last, n.id', price_desc: 'n.price desc nulls last, n.id', recent: 'n.listed_at desc nulls last, n.id', id: 'n.id' }[sort] || 'n.id';
  p.push(Math.min(limit, 200), offset);
  return db.query(`select ${NFT_COLS} from nfts n left join users u on u.id = n.owner_id
    ${where.length ? 'where ' + where.join(' and ') : ''} order by ${order} limit $${p.length - 1} offset $${p.length}`, p);
}

export async function stats(db) {
  const [s] = await db.query(`select
    (select count(*)::int from nfts) as supply,
    (select count(*)::int from nfts where minted_at is not null) as minted,
    (select count(*)::int from nfts where price is not null) as listed,
    (select min(price) from nfts where price is not null) as floor,
    (select coalesce(sum(price), 0) from sales) as volume,
    (select count(*)::int from sales) as sales,
    (select count(distinct owner_id)::int from nfts where owner_id is not null) as holders`);
  return { ...s, mint_price: CONFIG.mintPrice, fee_bps: CONFIG.feeBps };
}

export async function recentLedger(db, userId, limit = 8) {
  return db.query('select delta, kind, ref, created_at from ledger where user_id = $1 order by id desc limit $2', [userId, limit]);
}
