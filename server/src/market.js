// Market rules: balances, mint, listings, buys. Every balance change writes a ledger row
// in the same transaction, so sum(ledger) per user always equals users.balance.
// All amounts are integer micro-units of $MCP, 1 $MCP = $1 (see money.js).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { mcp, toMicro, MoneyError } from './money.js';
import { mintIntoEscrow } from './launchpad.js';

// MCP_TRADING: "after_sold_out" (the default) keeps MCP NFTs off the market until all of them are minted;
// "open" lets people trade them right away. Read on every start, like the mint price.
export function mcpTradeAfterSoldOut() {
  const v = String(process.env.MCP_TRADING || 'after_sold_out').trim().toLowerCase();
  if (v === 'open') return false;
  if (v !== 'after_sold_out') console.error(`ALERT MCP_TRADING=${v} is not "open" or "after_sold_out"; trading opens after the sell-out`);
  return true;
}

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
// how an NFT is named when only its number is at hand (messages); the real name comes from the database
export const nftName = (id) => `NFT #${Number(id)}`;
export const OWN_COLLECTION = 'mcp';

// The market's own collection (collection/collection.json): added once, with every NFT and the trait counts
// (for rarity percentages). Mint price and limit come from MINT_PRICE_USD / MINT_LIMIT_PER_USER and are
// brought up to date on every start, so changing them needs only a redeploy.
export async function seedCollection(db, collectionPath) {
  const c = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  // the traits in the order the artist gave them (Rarity, Render Engine, Chassis, ...)
  const order = [];
  for (const it of c.items) for (const [type] of it.a) if (!order.includes(type)) order.push(type);
  const traits = countTraits(c.items.map((it) => it.a.map(([trait_type, value]) => ({ trait_type, value }))));
  // the details follow collection.json and the settings on every start (cheap when nothing changed)
  const sync = async () => {
    const lock = mcpTradeAfterSoldOut();
    const [was] = await db.query('select trade_after_sold_out from collections where slug = $1', [c.slug]);
    await db.query(`update collections set mint_price = $2, mint_limit = $3, trait_order = $4, traits = $5, name = $6, description = $7,
        trade_after_sold_out = $8
      where slug = $1 and (mint_price <> $2 or mint_limit <> $3 or trait_order <> $4 or traits <> $5 or name <> $6 or description is distinct from $7
        or trade_after_sold_out <> $8)`,
    [c.slug, CONFIG.mintPrice, CONFIG.mintLimit, JSON.stringify(order), JSON.stringify(traits), c.name, c.description, lock]);
    // a switch of MCP_TRADING shows in the log: two servers on one database with different settings would flip it back and forth
    if (was && was.trade_after_sold_out !== lock) console.error(`ALERT MCP_TRADING: ${c.slug} trading now ${lock ? 'opens after the sell-out' : 'open'}`);
  };
  const have = async (q) => (await q(`select c.id, (select count(*)::int from nfts where collection_id = c.id) as n
    from collections c where c.slug = $1`, [c.slug]))[0];
  const now = await have(db.query);
  if (now && now.n === c.items.length) {
    await sync();
    await lockListings(db, c.slug);
    return now.n;
  }
  const rows = c.items.map((it) => ({
    id: it.id,
    name: it.name,
    edition: it.id,
    rarity: it.a.find(([t]) => t === 'Rarity')?.[1] ?? null,
    attributes: it.a.map(([trait_type, value]) => ({ trait_type, value })),
    pixel: !!it.px,
  }));
  await db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock(727274002)'); // cold starts in parallel: one seeds
    const again = await have(t.query);
    if (again && again.n === c.items.length) return;
    let id = again?.id;
    if (!id) {
      [{ id }] = await t.query(`insert into collections (slug, name, description, supply, mint_price, mint_limit, traits, trade_after_sold_out)
        values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [c.slug, c.name, c.description, c.items.length, CONFIG.mintPrice, CONFIG.mintLimit, JSON.stringify(traits), mcpTradeAfterSoldOut()]);
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await t.query(`insert into nfts (id, name, collection_id, edition, rarity, attributes, pixel)
        select x.id, x.name, $1, x.edition, x.rarity, x.attributes, x.pixel
        from jsonb_to_recordset($2::jsonb) as x(id int, name text, edition int, rarity text, attributes jsonb, pixel boolean)
        on conflict (id) do nothing`, [id, JSON.stringify(rows.slice(i, i + 1000))]);
    }
    // a number already used by another collection would leave a gap: stop rather than seed again on every start
    const [{ n }] = await t.query('select count(*)::int as n from nfts where collection_id = $1', [id]);
    if (n !== c.items.length) throw new Error(`collection ${c.slug}: ${c.items.length - n} of its NFT numbers belong to another collection`);
  });
  await sync();
  await lockListings(db, c.slug);
  return c.items.length;
}

// trading closed until the sell-out: listings made while it was open come off the market
async function lockListings(db, slug) {
  const r = await db.query(`update nfts n set price = null, listed_at = null from collections c
    where c.slug = $1 and n.collection_id = c.id and n.price is not null and c.trade_after_sold_out
      and exists (select 1 from nfts f where f.collection_id = c.id and f.minted_at is null) returning n.id`, [slug]);
  if (r.length) console.error(`ALERT ${slug}: ${r.length} listings taken off until the sell-out`);
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

export async function getCollection(db, slug) {
  return (await db.query('select * from collections where slug = $1', [String(slug || OWN_COLLECTION).toLowerCase()]))[0] || null;
}

// one random NFT of the collection that nobody has minted yet
export async function mint(db, userId, { collection = OWN_COLLECTION } = {}) {
  return db.tx(async (t) => {
    // the collection first, shared: a freeze or a payout waits for mints in progress, and a mint after a freeze
    // sees it. Then the account (one mint at a time per account, so the limit holds with parallel requests).
    // Freeze and release lock the collection first too, so they never deadlock with a mint.
    const [c] = await t.query('select * from collections where slug = $1 for share', [String(collection).toLowerCase()]);
    if (!c) fail(`There is no collection "${collection}". Ask for the list of collections.`);
    await t.query('select id from users where id = $1 for update', [userId]);
    if (c.status !== 'live') fail(`${c.name} is not open for minting.`);
    const [{ n }] = await t.query('select count(*)::int as n from nfts where collection_id = $1 and minted_by = $2', [c.id, userId]);
    if (n >= c.mint_limit) fail(`Mint limit reached: ${c.mint_limit} per account in ${c.name}.`);
    const free = await t.query('select * from nfts where collection_id = $1 and minted_at is null order by random() limit 1 for update skip locked', [c.id]);
    if (!free.length) fail(`${c.name} is sold out: every NFT is minted. Check the market.`);
    const nft = free[0];
    const price = Number(c.mint_price);
    if (c.creator_id != null) {
      // a launchpad collection: the market's fee, the rest held in the escrow (launchpad.js)
      await mintIntoEscrow(t, c, userId, nft);
    } else {
      // the market's own collection: all to the treasury
      await move(t, userId, -price, 'mint', String(nft.id));
      await move(t, null, price, 'mint', String(nft.id));
    }
    const [row] = await t.query('update nfts set owner_id = $1, minted_by = $1, minted_at = now() where id = $2 returning *', [userId, nft.id]);
    const [{ left }] = await t.query('select exists (select 1 from nfts where collection_id = $1 and minted_at is null) as left', [c.id]);
    return { ...row, price, collection: c.slug, collection_name: c.name, minted_by_you: n + 1, mint_limit: c.mint_limit,
      trade_after_sold_out: c.trade_after_sold_out, sold_out: !left };
  });
}

// Trading locks in one order everywhere: the collection (shared), then the NFT, then the accounts by id. A freeze
// locks the collection first too, so a listing or a sale either finishes before it or sees it.
async function lockCollectionOf(t, nftId) {
  const [c] = await t.query(`select c.id, c.name, c.status, c.supply, c.trade_after_sold_out from collections c
    where c.id = (select collection_id from nfts where id = $1) for share`, [nftId]);
  return c || null;
}

// a collection that trades only after its sell-out: nothing is listed or bought before the last NFT is minted.
// Mints only ever bring the sell-out closer, so a count read while they run can only refuse a bit early.
async function tradingClosed(t, c) {
  if (!c.trade_after_sold_out) return false;
  const [{ left }] = await t.query('select exists (select 1 from nfts where collection_id = $1 and minted_at is null) as left', [c.id]);
  if (!left) return false;
  const [{ n, total }] = await t.query('select count(*) filter (where minted_at is not null)::int as n, count(*)::int as total from nfts where collection_id = $1', [c.id]);
  return `Trading in ${c.name} opens when the whole collection is minted: ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} so far. Until then its NFTs can't be listed or bought.`;
}

export async function list(db, userId, nftId, price) {
  if (!Number.isInteger(price) || price <= 0 || price % CENT) fail('Price must be above zero with at most 2 decimals.');
  return db.tx(async (t) => {
    const c = await lockCollectionOf(t, nftId);
    const [own] = await t.query('select id from nfts where id = $1 and owner_id = $2 for update', [nftId, userId]);
    if (!c || !own) fail(`You don't own ${nftName(nftId)}.`);
    if (c.status === 'frozen') fail('This collection is frozen: it can not be traded.');
    const closed = await tradingClosed(t, c);
    if (closed) fail(closed);
    return (await t.query('update nfts set price = $1, listed_at = now() where id = $2 returning *', [price, nftId]))[0];
  });
}

export async function unlist(db, userId, nftId) {
  const rows = await db.query('update nfts set price = null, listed_at = null where id = $1 and owner_id = $2 returning *', [nftId, userId]);
  if (!rows.length) fail(`You don't own ${nftName(nftId)}.`);
  return rows[0];
}

export async function buy(db, buyerId, nftId, expectedPrice) {
  return db.tx(async (t) => {
    const col = await lockCollectionOf(t, nftId);
    const [nft] = await t.query('select * from nfts where id = $1 for update', [nftId]);
    if (!col || !nft) fail(`${nftName(nftId)} does not exist.`);
    if (col.status === 'frozen') fail('This collection is frozen: it can not be traded.');
    const closed = await tradingClosed(t, col);
    if (closed) fail(closed);
    if (nft.price == null) fail(`${nft.name} is not for sale.`);
    if (nft.owner_id === buyerId) fail('You already own this NFT.');
    await t.query('select id from users where id = any($1::int[]) order by id for update', [[buyerId, nft.owner_id]]);
    const price = Number(nft.price);
    // the buyer agreed to a price; never charge more than that
    if (expectedPrice != null && price !== expectedPrice) fail(`Price changed: ${nft.name} now costs ${fmt(price)}. Confirm the new price first.`);
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
const NFT_COLS = `n.id, n.name, n.edition, n.rarity, n.attributes, n.pixel, n.price, n.listed_at, n.minted_at,
  c.slug as collection, c.name as collection_name, c.status as collection_status,
  u.public_id as owner_addr, case when u.show_handle then u.handle end as owner_name`;
const NFT_FROM = 'from nfts n join collections c on c.id = n.collection_id left join users u on u.id = n.owner_id';
export const PUBLIC_NAME = (alias, as) => `${alias}.public_id as ${as}_addr, case when ${alias}.show_handle then ${alias}.handle end as ${as}_name`;

// {trait: {value: count}} over a collection. Trait names come from creators: no prototype, so a trait called
// "__proto__" or "constructor" is just a name
export function countTraits(attributeLists) {
  const traits = Object.create(null);
  for (const list of attributeLists) {
    for (const { trait_type: t, value: v } of list) {
      if (!Object.hasOwn(traits, t)) traits[t] = Object.create(null);
      traits[t][v] = (Object.hasOwn(traits[t], v) ? traits[t][v] : 0) + 1;
    }
  }
  return traits;
}

// how many NFTs of the collection share each trait: [{trait_type, value, count, percent}]
export function traitsWithRarity(attributes, traits, supply) {
  return (attributes || []).map((a) => {
    const byType = traits && Object.hasOwn(traits, a.trait_type) ? traits[a.trait_type] : null;
    const count = byType && Object.hasOwn(byType, a.value) && Number.isInteger(byType[a.value]) ? byType[a.value] : null;
    return { ...a, count, percent: count != null && supply ? Math.round((count / supply) * 10000) / 100 : null };
  });
}

export async function getNft(db, id, { anyStatus = false } = {}) {
  const [nft] = await db.query(`select ${NFT_COLS}, c.traits as collection_traits, c.supply as collection_supply, c.creator_id as collection_creator
    ${NFT_FROM} where n.id = $1 ${anyStatus ? '' : `and ${PUBLIC_SQL}`}`, [id]);
  if (!nft) return null;
  nft.attributes = traitsWithRarity(nft.attributes, nft.collection_traits, nft.collection_supply);
  delete nft.collection_traits;
  delete nft.collection_supply;
  if (!anyStatus) delete nft.collection_creator;
  nft.history = await db.query(
    `select s.price, s.created_at, ${PUBLIC_NAME('se', 'seller')}, ${PUBLIC_NAME('b', 'buyer')} from sales s
     join users se on se.id = s.seller_id join users b on b.id = s.buyer_id where s.nft_id = $1 order by s.id desc limit 20`, [id]);
  nft.activity = await activity(db, id);
  return nft;
}

// the NFT's own transactions from the ledger (mint and sales), newest first; tx = the explorer's transaction number
export async function activity(db, id) {
  const rows = await db.query(`select l.id, l.xact, l.kind, l.delta, l.created_at, ${PUBLIC_NAME('u', 'user')}
    from ledger l join users u on u.id = l.user_id where l.ref = $1 and l.kind in ('mint', 'buy', 'sale') order by l.id`, [String(id)]);
  const byX = new Map();
  for (const r of rows) {
    const key = String(r.xact);
    if (!byX.has(key)) byX.set(key, { tx: Number(r.id), at: r.created_at });
    const a = byX.get(key);
    if (r.kind === 'mint') Object.assign(a, { type: 'mint', to_addr: r.user_addr, to_name: r.user_name, price: -Number(r.delta) });
    if (r.kind === 'buy') Object.assign(a, { type: 'sale', to_addr: r.user_addr, to_name: r.user_name, price: -Number(r.delta) });
    if (r.kind === 'sale') Object.assign(a, { from_addr: r.user_addr, from_name: r.user_name });
  }
  return [...byX.values()].filter((a) => a.type).reverse();
}

// traits: [[type, value], ...]: values of one type are alternatives, different types must all match
function traitFilter(traits, where, p) {
  const byType = new Map();
  for (const [type, value] of traits || []) {
    if (typeof type !== 'string' || typeof value !== 'string' || !type || !value) continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(value);
  }
  for (const [type, values] of [...byType].slice(0, 12)) {
    const ors = values.slice(0, 30).map((value) => {
      p.push(JSON.stringify([{ trait_type: type, value }]));
      return `n.attributes @> $${p.length}::jsonb`;
    });
    where.push(`(${ors.join(' or ')})`);
  }
}

// what anyone can see: collections the owner approved. Drafts and collections in review only on their creator's
// and the owner's pages (anyStatus).
export const PUBLIC_STATUSES = ['live', 'paused', 'frozen'];
const PUBLIC_SQL = `c.status in (${PUBLIC_STATUSES.map((s) => `'${s}'`).join(', ')})`;

function browseWhere({ status = 'all', collection, rarity, traits, ownerId, ownerAddr, anyStatus = false } = {}) {
  const where = anyStatus ? [] : [PUBLIC_SQL];
  const p = [];
  if (status === 'listed') where.push('n.price is not null');
  if (status === 'unminted') where.push('n.minted_at is null');
  if (status === 'minted') where.push('n.minted_at is not null');
  if (collection) { p.push(String(collection).toLowerCase()); where.push(`c.slug = $${p.length}`); }
  if (rarity) { p.push(String(rarity)); where.push(`lower(n.rarity) = lower($${p.length})`); }
  traitFilter(traits, where, p);
  if (ownerId != null) { p.push(ownerId); where.push(`n.owner_id = $${p.length}`); }
  if (ownerAddr) { p.push(ownerAddr); where.push(`u.public_id = $${p.length}`); }
  return { where: where.length ? 'where ' + where.join(' and ') : '', p };
}

const ORDER = {
  price_asc: 'n.price asc nulls last, n.id',
  price_desc: 'n.price desc nulls last, n.id',
  recent: 'n.listed_at desc nulls last, n.id',
  minted: 'n.minted_at desc nulls last, n.id',
  id: 'n.id',
};

// ownerId: one account's NFTs (the account's own view); ownerAddr: by public MCP address
export async function browse(db, { sort = 'id', limit = 200, offset = 0, ...filters } = {}) {
  const { where, p } = browseWhere(filters);
  p.push(Math.min(Math.max(Number(limit) || 200, 1), 200), Math.max(Number(offset) || 0, 0));
  const order = Object.hasOwn(ORDER, sort) ? ORDER[sort] : ORDER.id;
  return db.query(`select ${NFT_COLS} ${NFT_FROM} ${where} order by ${order} limit $${p.length - 1} offset $${p.length}`, p);
}

export async function browseCount(db, filters = {}) {
  const { where, p } = browseWhere(filters);
  return (await db.query(`select count(*)::int as n ${NFT_FROM} ${where}`, p))[0].n;
}

// per collection, or the whole market without one
export async function stats(db, { collection, anyStatus = false } = {}) {
  const c = collection ? await getCollection(db, collection) : null;
  if (collection && (!c || (!anyStatus && !PUBLIC_STATUSES.includes(c.status)))) return null;
  const p = c ? [c.id] : [];
  // the whole market: collections anyone can see
  const only = c ? 'collection_id = $1' : `collection_id in (select id from collections c where ${PUBLIC_SQL})`;
  const [s] = await db.query(`select
    (select count(*)::int from nfts where ${only}) as supply,
    (select count(*)::int from nfts where ${only} and minted_at is not null) as minted,
    (select count(*)::int from nfts where ${only} and price is not null) as listed,
    (select min(price) from nfts where ${only} and price is not null) as floor,
    (select coalesce(sum(s.price), 0) from sales s join nfts n on n.id = s.nft_id where n.${only}) as volume,
    (select count(*)::int from sales s join nfts n on n.id = s.nft_id where n.${only}) as sales,
    (select count(distinct owner_id)::int from nfts where ${only} and owner_id is not null) as holders`, p);
  const own = c || await getCollection(db, OWN_COLLECTION);
  return { ...s, mint_price: own ? Number(own.mint_price) : CONFIG.mintPrice, mint_limit: own ? own.mint_limit : CONFIG.mintLimit, fee_bps: CONFIG.feeBps };
}

// the collections people can see, with their numbers
// public: live and paused ones; the creator and the owner also see their collections in other states
export async function collections(db, { statuses = ['live', 'paused'] } = {}) {
  return db.query(`select c.id, c.slug, c.name, c.description, c.supply, c.mint_price, c.mint_limit, c.status, c.created_at, c.cover_nft, c.review_note,
      c.trade_after_sold_out,
      (select pixel from nfts where id = c.cover_nft) as cover_pixel,
      ${PUBLIC_NAME('cu', 'creator')},
      (select count(*)::int from nfts where collection_id = c.id and minted_at is not null) as minted,
      (select min(price) from nfts where collection_id = c.id and price is not null) as floor,
      (select count(*)::int from nfts where collection_id = c.id and price is not null) as listed,
      (select coalesce(sum(s.price), 0) from sales s join nfts n on n.id = s.nft_id where n.collection_id = c.id) as volume
    from collections c left join users cu on cu.id = c.creator_id where c.status = any($1) order by c.creator_id nulls first, c.id`, [statuses]);
}

export async function recentLedger(db, userId, limit = 8) {
  // NFT rows carry the NFT's number as ref: show its name
  return db.query(`select l.delta, l.kind, l.ref, l.created_at, n.name as nft_name from ledger l
    left join nfts n on l.ref ~ '^[0-9]{1,9}$' and n.id = (case when l.ref ~ '^[0-9]{1,9}$' then l.ref::int end)
    where l.user_id = $1 order by l.id desc limit $2`, [userId, limit]);
}
