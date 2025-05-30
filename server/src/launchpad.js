// The launchpad: anyone signed in with X can put up a collection; it goes live only after the market's
// owner reviews it. Mint money of a creator's collection:
//   minter -price ("mint") · treasury +fee ("mint_fee", LAUNCH_FEE_BPS, 10% by default) · escrow +rest ("hold")
// The rest is held at least HOLD_DAYS (7) per mint, and goes to the creator's balance only when the owner
// releases it ("hold_release" from the escrow, "payout" to the creator). If a collection turns out to be a scam,
// the owner freezes it: minting and trading stop and every mint still held is refunded in full
// ("hold_refund" + "fee_refund" from the market, "mint_refund" to the minter).
// The escrow is its own account in the ledger and the explorer ("escrow"): money nobody can spend yet, and it
// counts as owed in the proof of reserves.
import { MarketError, countTraits } from './market.js';
import { toMicro } from './money.js';

const fail = (msg) => { throw new MarketError(msg); };

// a setting from the environment, or its default (with an ALERT in the log) when it is out of range
function setting(name, def, ok) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const v = Number(raw);
  if (Number.isInteger(v) && ok(v)) return v;
  console.error(`ALERT ${name}=${raw} is not allowed; using ${def}`);
  return def;
}

export const LAUNCH = {
  feeBps: setting('LAUNCH_FEE_BPS', 1000, (v) => v >= 0 && v <= 5000), // the market's share of a mint, at most half
  holdDays: setting('HOLD_DAYS', 7, (v) => v >= 7 && v <= 365), // never less than a week
  maxSupply: Number(process.env.LAUNCH_MAX_SUPPLY || 10000),
  maxImageBytes: 1024 * 1024,
  maxThumbBytes: 256 * 1024,
  minPrice: toMicro('0.5'),
  maxPrice: toMicro('10000'),
  maxOpen: 3, // drafts, collections in review and rejected ones (delete those to make room) per account
  maxBytes: Number(process.env.LAUNCH_MAX_MB || 2048) * 2 ** 20, // pictures uploaded per collection, counting re-uploads
};

// the ledger rows that belong to the escrow account (user_id is null, like the treasury's)
export const ESCROW_KINDS = ['hold', 'hold_release', 'hold_refund'];
export const isEscrowKind = (k) => ESCROW_KINDS.includes(k);

const RESERVED = new Set(['mcp', 'admin', 'launch', 'new', 'api', 'img', 'thumb', 'covers', 'explorer', 'collections', 'treasury', 'escrow', 'market']);
export const slugOk = (s) => /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(String(s || '')) && !RESERVED.has(String(s));
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

// a ledger row plus the balance change, inside a transaction (null user = the market's own accounts)
async function move(t, userId, delta, kind, ref) {
  if (userId != null) {
    const rows = await t.query('update users set balance = balance + $1 where id = $2 and balance + $1 >= 0 returning balance', [delta, userId]);
    if (!rows.length) fail('Not enough $MCP on your balance.');
  }
  await t.query('insert into ledger (user_id, delta, kind, ref) values ($1, $2, $3, $4)', [userId, delta, kind, ref]);
}

// ---------- a creator's collection ----------

export async function createDraft(db, userId, input) {
  const name = clean(input.name, 40);
  const slug = String(input.slug || '').toLowerCase();
  const description = clean(input.description, 300);
  if (name.length < 2) fail('Give the collection a name (2 to 40 characters).');
  if (!slugOk(slug)) fail('The collection id must be 3 to 30 lowercase letters, digits and dashes, and not a reserved word.');
  const terms = draftTerms(input);
  try {
    return await db.tx(async (t) => {
      // one new collection at a time per account, so the limit holds with parallel requests
      await t.query('select id from users where id = $1 for update', [userId]);
      const [{ n }] = await t.query("select count(*)::int as n from collections where creator_id = $1 and status in ('draft', 'review', 'rejected')", [userId]);
      if (n >= LAUNCH.maxOpen) fail(`You already have ${n} collections being prepared, in review or rejected. Delete a rejected one to start another.`);
      const [c] = await t.query(`insert into collections (slug, name, description, creator_id, supply, mint_price, mint_limit, fee_bps, status, hold_days)
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9) returning *`,
      [slug, name, description, userId, terms.supply, terms.mintPrice, terms.mintLimit, LAUNCH.feeBps, LAUNCH.holdDays]);
      return c;
    });
  } catch (e) {
    if (e.code === '23505') fail(`The collection id "${slug}" is taken.`);
    throw e;
  }
}

function draftTerms(input) {
  const supply = Number(input.supply);
  if (!Number.isInteger(supply) || supply < 1 || supply > LAUNCH.maxSupply) fail(`Supply must be 1 to ${LAUNCH.maxSupply}.`);
  let mintPrice;
  try {
    mintPrice = toMicro(input.mint_price, { what: 'Mint price' });
  } catch (e) {
    fail(e.message);
  }
  if (mintPrice < LAUNCH.minPrice || mintPrice > LAUNCH.maxPrice || mintPrice % 10_000) fail('Mint price must be 0.50 to 10,000 $MCP with at most 2 decimals.');
  const mintLimit = Number(input.mint_limit);
  if (!Number.isInteger(mintLimit) || mintLimit < 1 || mintLimit > 100) fail('Per-account limit must be 1 to 100.');
  return { supply, mintPrice, mintLimit };
}

export async function updateDraft(db, userId, id, input) {
  return db.tx(async (t) => {
    const c = await ownDraft(t, userId, id, 'update');
    const name = input.name != null ? clean(input.name, 40) : c.name;
    const description = input.description != null ? clean(input.description, 300) : c.description;
    const terms = draftTerms({ supply: input.supply ?? c.supply, mint_price: input.mint_price ?? Number(c.mint_price) / 1e6, mint_limit: input.mint_limit ?? c.mint_limit });
    const [{ hi }] = await t.query('select coalesce(max(edition), 0)::int as hi from nfts where collection_id = $1', [c.id]);
    if (terms.supply < hi) fail(`NFT #${hi} is uploaded already: the supply can't be smaller.`);
    if (name.length < 2) fail('Give the collection a name (2 to 40 characters).');
    return (await t.query('update collections set name = $2, description = $3, supply = $4, mint_price = $5, mint_limit = $6 where id = $1 returning *',
      [c.id, name, description, terms.supply, terms.mintPrice, terms.mintLimit]))[0];
  });
}

// the creator's draft, locked inside a transaction: 'update' to change it, 'share' to add NFTs to it (uploads run
// side by side, while a change, a submit or a delete waits for them and they wait for it)
async function ownDraft(t, userId, id, lock) {
  const [c] = await t.query(`select * from collections where id = $1 and creator_id = $2 for ${lock === 'share' ? 'share' : 'update'}`, [Number(id) || 0, userId]);
  return mustBeDraft(c);
}

function mustBeDraft(c) {
  if (!c) fail('No such collection of yours.');
  if (c.status !== 'draft') fail(c.status === 'review' ? 'This collection is in review: it can not be changed now.' : 'This collection can not be changed any more.');
  return c;
}

// one batch of NFTs: [{ edition, name?, attributes?, image: Buffer, thumb: Buffer, pixel }]
// Pictures go to storage first, then the rows; uploading an edition again replaces it.
export async function addItems(db, storage, sniff, userId, id, items) {
  const c = mustBeDraft((await db.query('select * from collections where id = $1 and creator_id = $2', [Number(id) || 0, userId]))[0]);
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('Send 1 to 100 NFTs at a time.');
  const rows = [];
  for (const it of items) {
    const edition = Number(it.edition);
    if (!Number.isInteger(edition) || edition < 1 || edition > c.supply) fail(`NFT number ${it.edition} is outside 1 to ${c.supply}.`);
    const image = Buffer.from(it.image || []);
    const thumb = Buffer.from(it.thumb || []);
    const type = sniff(image);
    const thumbType = sniff(thumb);
    if (!type) fail(`#${edition}: the picture must be PNG, JPEG, GIF or WEBP.`);
    if (!thumbType) fail(`#${edition}: the thumbnail must be PNG, JPEG, GIF or WEBP.`);
    if (image.length > LAUNCH.maxImageBytes) fail(`#${edition}: the picture is over 1 MB.`);
    if (thumb.length > LAUNCH.maxThumbBytes) fail(`#${edition}: the thumbnail is over 256 KB.`);
    const attributes = (Array.isArray(it.attributes) ? it.attributes : []).slice(0, 20)
      .map((a) => ({ trait_type: clean(a?.trait_type, 40), value: clean(a?.value, 60) }))
      .filter((a) => a.trait_type && a.value && !RESERVED_KEYS.has(a.trait_type) && !RESERVED_KEYS.has(a.value));
    const rarity = attributes.find((a) => a.trait_type.toLowerCase() === 'rarity')?.value || null;
    rows.push({ edition, name: clean(it.name, 60) || `${c.name} #${edition}`, attributes, rarity, pixel: !!it.pixel, image, type, thumb, thumbType });
  }
  const bytes = rows.reduce((s, r) => s + r.image.length + r.thumb.length, 0);
  // the quota first, in one statement, so parallel uploads can't all pass it
  const [room] = await db.query("update collections set bytes = bytes + $2 where id = $1 and status = 'draft' and bytes + $2 <= $3 returning id", [c.id, bytes, LAUNCH.maxBytes]);
  if (!room) {
    mustBeDraft((await db.query('select * from collections where id = $1', [c.id]))[0]); // not a draft any more: says so
    fail(`This collection is over ${Math.round(LAUNCH.maxBytes / 2 ** 30)} GB of pictures.`);
  }
  try {
    await db.tx(async (t) => {
      // held while the pictures are written: a submit or a delete waits until this batch is in, and a batch that
      // comes after them fails here, before writing anything
      const d = await ownDraft(t, userId, c.id, 'share');
      const over = rows.find((r) => r.edition > d.supply);
      if (over) fail(`NFT number ${over.edition} is outside 1 to ${d.supply}.`);
      const jobs = rows.flatMap((r) => [[`c${c.id}/img/${r.edition}`, r.image, r.type], [`c${c.id}/thumb/${r.edition}`, r.thumb, r.thumbType]]);
      for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(([k, data, type]) => storage.put(k, data, type)));
      await insertItems(t, c, rows);
    });
  } catch (e) {
    await db.query('update collections set bytes = greatest(bytes - $2, 0) where id = $1', [c.id, bytes]);
    throw e;
  }
  const [{ n }] = await db.query('select count(*)::int as n from nfts where collection_id = $1', [c.id]);
  return { uploaded: n, supply: c.supply };
}

async function insertItems(t, c, rows) {
  for (const r of rows) {
    await t.query(`insert into nfts (id, name, collection_id, edition, rarity, attributes, pixel)
      values (nextval('nft_ids'), $1, $2, $3, $4, $5, $6)
      on conflict (collection_id, edition) do update set name = excluded.name, rarity = excluded.rarity, attributes = excluded.attributes, pixel = excluded.pixel`,
    [r.name, c.id, r.edition, r.rarity, JSON.stringify(r.attributes), r.pixel]);
  }
}

export async function setCover(db, userId, id, edition) {
  return db.tx(async (t) => {
    const c = await ownDraft(t, userId, id, 'update');
    const [nft] = await t.query('select id from nfts where collection_id = $1 and edition = $2', [c.id, Number(edition)]);
    if (!nft) fail('Upload that NFT first.');
    await t.query('update collections set cover_nft = $2 where id = $1', [c.id, nft.id]);
    return nft.id;
  });
}

// every NFT uploaded, numbered 1..supply, a cover chosen: the owner reviews it next
export async function submit(db, userId, id) {
  return db.tx(async (t) => {
    const c = await ownDraft(t, userId, id, 'update');
    const [{ n, lo, hi }] = await t.query('select count(*)::int as n, min(edition) as lo, max(edition) as hi from nfts where collection_id = $1', [c.id]);
    if (n !== c.supply || lo !== 1 || hi !== c.supply) fail(`Upload all ${c.supply} NFTs first (${n} so far).`);
    const all = await t.query('select attributes from nfts where collection_id = $1 order by edition', [c.id]);
    const traits = countTraits(all.map((r) => r.attributes));
    const order = [];
    for (const { attributes } of all) for (const a of attributes) if (!order.includes(a.trait_type)) order.push(a.trait_type);
    const cover = c.cover_nft || (await t.query('select id from nfts where collection_id = $1 and edition = 1', [c.id]))[0].id;
    return (await t.query(`update collections set status = 'review', submitted_at = now(), traits = $2, trait_order = $3, cover_nft = $4, review_note = null
      where id = $1 and status = 'draft' returning *`, [c.id, JSON.stringify(traits), JSON.stringify(order), cover]))[0];
  });
}

// a draft or a rejected collection can be thrown away, with its pictures
export async function removeCollection(db, storage, userId, id) {
  const c = await db.tx(async (t) => {
    const [row] = await t.query("select * from collections where id = $1 and creator_id = $2 and status in ('draft', 'rejected') for update", [Number(id) || 0, userId]);
    if (!row) fail('Only a collection that is not live can be deleted.');
    // nothing of it was ever minted (only live collections mint), so every NFT row goes
    const [{ minted }] = await t.query('select count(*)::int as minted from nfts where collection_id = $1 and minted_at is not null', [row.id]);
    if (minted) fail('NFTs of this collection were minted: it can not be deleted.');
    await t.query('update collections set cover_nft = null where id = $1', [row.id]);
    await t.query('delete from nfts where collection_id = $1', [row.id]);
    await t.query("delete from collections where id = $1 and status in ('draft', 'rejected')", [row.id]);
    return row;
  });
  await storage.remove(`c${c.id}/`);
  return true;
}

// ---------- the owner's review ----------

export async function review(db, id, { approve, note = '' }) {
  const [c] = await db.query("update collections set status = $2, review_note = $3, approved_at = case when $2 = 'live' then now() end where id = $1 and status = 'review' returning *",
    [id, approve ? 'live' : 'rejected', clean(note, 300) || null]);
  if (!c) fail('That collection is not waiting for review.');
  return c;
}

export async function setPaused(db, id, paused) {
  const [c] = await db.query(`update collections set status = $2 where id = $1 and creator_id is not null and status = $3 returning *`,
    [id, paused ? 'paused' : 'live', paused ? 'live' : 'paused']);
  if (!c) fail(paused ? 'Only a live collection can be paused.' : 'Only a paused collection can be resumed.');
  return c;
}

// ---------- minting a creator's collection (called inside market.mint's transaction) ----------

export async function mintIntoEscrow(t, c, userId, nft) {
  const price = Number(c.mint_price);
  const fee = Math.floor((price * Number(c.fee_bps)) / 10000);
  const held = price - fee;
  const ref = String(nft.id);
  await move(t, userId, -price, 'mint', ref);
  if (fee) await move(t, null, fee, 'mint_fee', ref);
  if (held) await move(t, null, held, 'hold', ref);
  await t.query('insert into mint_holds (nft_id, collection_id, minter_id, price, fee, amount) values ($1, $2, $3, $4, $5, $6)',
    [nft.id, c.id, userId, price, fee, held]);
  return { price, fee, held };
}

// ---------- payouts: only when the owner releases them, and only mints older than the hold ----------

export async function releasable(db, id) {
  const [r] = await db.query(`select coalesce(sum(h.amount), 0)::bigint as amount, count(*)::int as mints from mint_holds h
    join collections c on c.id = h.collection_id
    where h.collection_id = $1 and h.released_at is null and h.refunded_at is null and h.created_at <= now() - make_interval(days => c.hold_days)`, [id]);
  return { amount: Number(r.amount), mints: r.mints };
}

// the owner's money actions: if Postgres picks one as a deadlock victim, run it again (it rolled back whole)
async function retrying(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 2 || !['40P01', '40001'].includes(e.code)) throw e;
    }
  }
}

export async function release(db, id) {
  return retrying(() => db.tx(async (t) => {
    const [c] = await t.query('select * from collections where id = $1 for update', [id]);
    if (!c || c.creator_id == null) fail('No such creator collection.');
    if (c.status === 'frozen') fail('This collection is frozen: its money goes back to the minters, not to the creator.');
    const holds = await t.query(`update mint_holds set released_at = now()
      where collection_id = $1 and released_at is null and refunded_at is null and created_at <= now() - make_interval(days => $2)
      returning amount`, [c.id, c.hold_days]);
    const total = holds.reduce((s, h) => s + Number(h.amount), 0);
    if (!total) return { released: 0, mints: holds.length };
    await move(t, null, -total, 'hold_release', `c${c.id}`);
    await move(t, c.creator_id, total, 'payout', `c${c.id}`);
    return { released: total, mints: holds.length };
  }));
}

// A scam: stop it, and give the mint price of every mint still held back to whoever holds that NFT now (the person
// left with it; a scammer's own accounts that minted and sold get nothing back). Set-based, so even a collection
// of 10,000 mints is refunded in one quick transaction.
export async function freeze(db, id, note) {
  return retrying(() => db.tx(async (t) => {
    const [c] = await t.query("update collections set status = 'frozen', review_note = $2 where id = $1 and creator_id is not null and status in ('live', 'paused') returning *",
      [id, clean(note, 300) || null]);
    if (!c) fail('Only a live or paused creator collection can be frozen.');
    // trading and minting wait for the collection now, so owners can't change from here on
    await t.query('update nfts set price = null, listed_at = null where collection_id = $1 and price is not null', [c.id]);
    // the accounts in id order, like a sale locks them, so the two never deadlock
    await t.query(`select id from users where id in (select coalesce(n.owner_id, h.minter_id) from mint_holds h join nfts n on n.id = h.nft_id
      where h.collection_id = $1 and h.released_at is null and h.refunded_at is null) order by id for update`, [c.id]);
    const [r] = await t.query(`with h as (
        update mint_holds set refunded_at = now() where collection_id = $1 and released_at is null and refunded_at is null
        returning nft_id, price, fee, amount, minter_id
      ), x as (
        -- an NFT always has an owner once minted; the minter is only a safety net, never the treasury
        select h.nft_id, h.price, h.fee, h.amount, coalesce(n.owner_id, h.minter_id) as owner_id from h join nfts n on n.id = h.nft_id
      ), rows as (
        insert into ledger (user_id, delta, kind, ref)
        select null::int, -amount, 'hold_refund', nft_id::text from x where amount > 0
        union all select null::int, -fee, 'fee_refund', nft_id::text from x where fee > 0
        union all select owner_id, price, 'mint_refund', nft_id::text from x
        returning 1
      ), paid as (
        update users u set balance = u.balance + s.total from (select owner_id, sum(price) as total from x group by owner_id) s
        where u.id = s.owner_id returning 1
      )
      select (select coalesce(sum(price), 0)::bigint from x) as refunded, (select count(*)::int from x) as mints,
        (select count(*)::int from rows) as rows, (select count(*)::int from paid) as accounts`, [c.id]);
    return { refunded: Number(r.refunded), mints: r.mints, accounts: r.accounts };
  }));
}

// what a creator sees about the money of one collection
export async function earnings(db, id) {
  const [r] = await db.query(`select
      coalesce(sum(amount) filter (where released_at is null and refunded_at is null), 0)::bigint as held,
      coalesce(sum(amount) filter (where released_at is not null), 0)::bigint as paid,
      coalesce(sum(price) filter (where refunded_at is not null), 0)::bigint as refunded,
      count(*)::int as mints
    from mint_holds where collection_id = $1`, [id]);
  const ready = await releasable(db, id);
  return { held: Number(r.held), paid: Number(r.paid), refunded: Number(r.refunded), mints: r.mints, releasable: ready.amount };
}
