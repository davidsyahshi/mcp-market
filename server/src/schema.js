// Database schema and migration. The schema is idempotent ("if not exists"), and migrate() only runs it
// when its text changed since the last run, under an advisory lock, so many cold-starting serverless
// instances never race each other.
import crypto from 'node:crypto';

// Amounts are integer micro-units of $MCP (1 $MCP = $1 = 1,000,000 units), like USDC/USDT on Solana. See money.js.
export const SCHEMA = `
create table if not exists app_meta (
  key text primary key,
  value text not null
);

create table if not exists users (
  id serial primary key,
  x_id text unique not null,            -- X (Twitter) user id; 'dev:<handle>' for test logins
  handle text unique not null,
  name text,
  avatar text,
  balance bigint not null default 0 check (balance >= 0),
  deposit_address text,                 -- unused: deposit addresses live in deposit_pool
  withdraw_address text,                -- bound once; changing it needs support
  created_at timestamptz not null default now()
);

-- Collections. The market's own collection (MCP) has no creator: its mint money goes to the treasury.
create table if not exists collections (
  id serial primary key,
  slug text not null unique,            -- the collection's address on the site: /c/<slug>
  name text not null,
  description text,
  creator_id int references users(id),  -- null = the market's own collection
  supply int not null check (supply > 0),
  mint_price bigint not null check (mint_price > 0),
  mint_limit int not null check (mint_limit > 0), -- per account
  fee_bps int not null default 0,       -- the market's share of each mint (creator collections)
  status text not null default 'live',  -- live: mintable
  traits jsonb not null default '{}',   -- {"<trait>": {"<value>": count}}, for rarity percentages
  created_at timestamptz not null default now()
);
alter table collections add column if not exists trait_order jsonb not null default '[]'; -- the traits in the creator's order

create table if not exists nfts (
  id int primary key,                   -- the NFT's number everywhere (URLs, the chat, the ledger)
  name text not null,
  collection_id int references collections(id),
  edition int,                          -- its number inside the collection
  rarity text,                          -- the "Rarity" trait, if the collection has one
  attributes jsonb not null default '[]', -- [{"trait_type": "...", "value": "..."}]
  pixel boolean not null default false, -- /img is pixel art at its native size: scale it up without smoothing
  owner_id int references users(id),
  minted_at timestamptz,
  minted_by int references users(id),
  price bigint check (price > 0),       -- not null = listed for sale
  listed_at timestamptz
);
-- databases from before collections: the test NFTs' columns go, the new ones come (the old rows are
-- replaced by the data migration "mcp-collection" below)
alter table nfts add column if not exists collection_id int references collections(id);
alter table nfts add column if not exists edition int;
alter table nfts add column if not exists attributes jsonb not null default '[]';
alter table nfts add column if not exists pixel boolean not null default false;
alter table nfts add column if not exists minted_by int references users(id);
alter table nfts alter column rarity drop not null;
alter table nfts drop column if exists character;
alter table nfts drop column if exists shape;
alter table nfts drop column if exists palette;
create index if not exists nfts_owner on nfts(owner_id);
create index if not exists nfts_listed on nfts(price) where price is not null;
create unique index if not exists nfts_edition on nfts(collection_id, edition);
create index if not exists nfts_free on nfts(collection_id, id) where minted_at is null;
create index if not exists nfts_minted_by on nfts(collection_id, minted_by);
create index if not exists nfts_attributes on nfts using gin (attributes jsonb_path_ops);

-- The launchpad (launchpad.js): creators' collections, reviewed by the owner, mint money held in an escrow.
-- NFTs of creators' collections are numbered from 100001, after the market's own collection.
create sequence if not exists nft_ids start 100001;
alter table collections add column if not exists cover_nft int references nfts(id);
alter table collections add column if not exists hold_days int not null default 7;
alter table collections add column if not exists review_note text;    -- why it was rejected or frozen, shown to the creator
alter table collections add column if not exists submitted_at timestamptz;
alter table collections add column if not exists approved_at timestamptz;
alter table collections add column if not exists bytes bigint not null default 0; -- pictures uploaded, a quota
-- no listing or buying until every NFT of the collection is minted (the MCP collection, MCP_TRADING)
alter table collections add column if not exists trade_after_sold_out boolean not null default false;
create index if not exists collections_creator on collections(creator_id);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'collections_status_check') then
    alter table collections add constraint collections_status_check check (status in ('draft', 'review', 'rejected', 'live', 'paused', 'frozen'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collections_terms_check') then
    alter table collections add constraint collections_terms_check check (fee_bps between 0 and 10000 and hold_days >= 0 and bytes >= 0);
  end if;
end $c$;
-- status: draft (the creator uploads) -> review -> live / rejected; live <-> paused; live or paused -> frozen

-- one row per mint of a creator's collection: what the minter paid, the market's fee, what is held for the creator
create table if not exists mint_holds (
  nft_id int primary key references nfts(id),
  collection_id int not null references collections(id),
  minter_id int not null references users(id),
  price bigint not null check (price > 0),
  fee bigint not null check (fee >= 0),
  amount bigint not null check (amount >= 0),     -- price - fee, in the escrow until released or refunded
  created_at timestamptz not null default now(),
  released_at timestamptz,
  refunded_at timestamptz,
  check (amount + fee = price),
  check (released_at is null or refunded_at is null)
);
create index if not exists mint_holds_open on mint_holds(collection_id, created_at) where released_at is null and refunded_at is null;
-- the amounts never change; a hold ends once, either paid out or refunded
create or replace function mint_holds_guard() returns trigger language plpgsql as $g$
begin
  if tg_op = 'DELETE' then
    raise exception 'mint hold % can not be deleted', old.nft_id;
  end if;
  if new.nft_id <> old.nft_id or new.collection_id <> old.collection_id or new.minter_id <> old.minter_id
     or new.price <> old.price or new.fee <> old.fee or new.amount <> old.amount then
    raise exception 'mint hold %: amounts can not be changed', old.nft_id;
  end if;
  if (old.released_at is not null and new.released_at is distinct from old.released_at)
     or (old.refunded_at is not null and new.refunded_at is distinct from old.refunded_at) then
    raise exception 'mint hold % is already settled', old.nft_id;
  end if;
  return new;
end $g$;
drop trigger if exists mint_holds_guard on mint_holds;
create trigger mint_holds_guard before update or delete on mint_holds for each row execute function mint_holds_guard();

-- signed-in sessions on the site (the launchpad), stored as sha256 of the cookie
create table if not exists site_sessions (
  token text primary key,
  user_id int not null references users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists site_sessions_expiry on site_sessions(expires_at);


create table if not exists ledger (
  id bigserial primary key,
  user_id int references users(id),     -- null = project treasury (fees, mint revenue)
  delta bigint not null,
  kind text not null,                   -- deposit | faucet | mint | team_mint | free_mint | buy | sale | fee | send | receive | withdraw | ...
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_user on ledger(user_id, id desc);
create unique index if not exists ledger_deposit_tx on ledger(ref) where kind = 'deposit';

-- Deposits. deposit_pool holds public Solana addresses made offline from a phrase the server never sees
-- (server/scripts/deposit-pool.js, imported as CSV). Each user gets one. We watch its USDC and USDT token
-- accounts and credit what arrives. Each (transaction, token account) is credited at most once.
create table if not exists deposit_pool (
  network text not null,                -- mainnet | devnet
  idx int not null,                     -- the phrase's wallet number: m/44'/501'/idx'/0'
  address text not null unique,
  mac text not null,                    -- HMAC of network:idx:address with DEPOSIT_POOL_KEY (see pool.js)
  user_id int references users(id),
  assigned_at timestamptz,
  primary key (network, idx)
);
create unique index if not exists deposit_pool_user on deposit_pool(network, user_id);
create index if not exists deposit_pool_free on deposit_pool(network, idx) where user_id is null;

alter table users add column if not exists deposit_watch_until timestamptz; -- scan often until then

create table if not exists deposit_accounts (
  address text primary key,             -- the pool address's associated token account for one stablecoin
  user_id int not null references users(id),
  wallet text not null,                 -- the pool address that owns it
  token text not null,                  -- USDC | USDT
  mint text not null,
  cursor text,                          -- newest transaction signature already processed
  checked_at timestamptz
);
create index if not exists deposit_accounts_user on deposit_accounts(user_id);

create table if not exists deposits (
  id bigserial primary key,
  user_id int not null references users(id),
  signature text not null,
  token text not null,
  token_account text not null,
  amount bigint not null,               -- micro-units ($MCP = token amount, 6 decimals)
  slot bigint,
  status text not null,                 -- credited | too_small
  created_at timestamptz not null default now(),
  unique (signature, token_account)
);
create index if not exists deposits_user on deposits(user_id, id desc);

create table if not exists sales (
  id bigserial primary key,
  nft_id int not null references nfts(id),
  seller_id int not null references users(id),
  buyer_id int not null references users(id),
  price bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists withdrawals (
  id bigserial primary key,
  user_id int not null references users(id),
  amount bigint not null check (amount > 0),
  address text not null,
  status text not null default 'pending', -- review | pending | sending | sent | rejected | refunded (see withdrawals.js)
  tx text,
  created_at timestamptz not null default now()
);
-- amount = what arrives as USDC; fee is charged on top. mac signs the row (withdrawals.js).
alter table withdrawals add column if not exists fee bigint not null default 0;
alter table withdrawals add column if not exists network text;
alter table withdrawals add column if not exists mac text;
alter table withdrawals add column if not exists attempts int not null default 0;
alter table withdrawals add column if not exists error text;
alter table withdrawals add column if not exists sent_at timestamptz;
alter table withdrawals add column if not exists refunded_at timestamptz;
alter table withdrawals add column if not exists updated_at timestamptz;
alter table withdrawals add column if not exists client_key text; -- made by the withdrawal form: a retry never makes a second withdrawal
create unique index if not exists withdrawals_client_key on withdrawals(user_id, client_key) where client_key is not null;
create index if not exists withdrawals_status on withdrawals(network, status, id);
create index if not exists withdrawals_user on withdrawals(user_id, id desc);
-- every transaction ever signed for a withdrawal, stored before it is broadcast and never deleted
create table if not exists withdrawal_attempts (
  id bigserial primary key,
  withdrawal_id bigint not null references withdrawals(id),
  signature text not null unique,
  raw text not null,                    -- the signed transaction, to rebroadcast the very same bytes
  last_valid_height bigint not null,    -- past this block height it can never land
  created_at timestamptz not null default now()
);
create index if not exists withdrawal_attempts_w on withdrawal_attempts(withdrawal_id);
alter table users add column if not exists withdraw_address_set_at timestamptz;
alter table users add column if not exists withdraw_mac text;           -- HMAC of the binding (withdrawals.js)

-- Guards against mistakes in the table editor: sent and refunded are final, what a withdrawal pays
-- (amount, fee, address, user) never changes, and stored transactions are never changed or deleted.
create or replace function withdrawals_guard() returns trigger language plpgsql as $g$
begin
  if old.status in ('sent', 'refunded') and new.status is distinct from old.status then
    raise exception 'withdrawal % is %, which is final', old.id, old.status;
  end if;
  if new.amount <> old.amount or new.fee <> old.fee or new.address <> old.address or new.user_id <> old.user_id
     or new.network is distinct from old.network or (old.mac is not null and new.mac is distinct from old.mac)
     or new.client_key is distinct from old.client_key then
    raise exception 'withdrawal %: amount, fee, address, user, network, signature and request key can not be changed', old.id;
  end if;
  return new;
end $g$;
drop trigger if exists withdrawals_guard on withdrawals;
create trigger withdrawals_guard before update on withdrawals for each row execute function withdrawals_guard();
create or replace function withdrawal_attempts_guard() returns trigger language plpgsql as $g$
begin
  raise exception 'withdrawal_attempts can not be changed or deleted';
end $g$;
drop trigger if exists withdrawal_attempts_guard on withdrawal_attempts;
create trigger withdrawal_attempts_guard before update or delete on withdrawal_attempts for each row execute function withdrawal_attempts_guard();
-- a withdrawal is refunded at most once
create unique index if not exists ledger_withdraw_refund on ledger(ref) where kind = 'withdraw_refund';

-- The public record (the explorer, explorer.js). Public pages show an account's MCP address (users.public_id),
-- not its X handle, unless the user chooses to show the handle.
alter table users add column if not exists public_id text;
create unique index if not exists users_public_id on users(public_id);
alter table users add column if not exists show_handle boolean not null default false;
-- xact: the database transaction that wrote the row, so a buy (buyer, seller, fee) shows as one transaction.
-- Added without a default first: a volatile default would stamp every existing row with one value.
alter table ledger add column if not exists xact bigint;
alter table ledger alter column xact set default txid_current();
-- seq/hash: every row is chained to the one before (hash of the previous hash and the row), sealed in the
-- background; the latest hash is written to Solana now and then (chain_anchors), so history can't be rewritten unnoticed.
alter table ledger add column if not exists seq bigint;
alter table ledger add column if not exists hash text;
create unique index if not exists ledger_seq on ledger(seq);
create index if not exists ledger_xact on ledger(xact);
-- the explorer's type filter (mints, sales, transfers…), newest first
create index if not exists ledger_kind on ledger(kind, id desc);
create index if not exists ledger_unsealed on ledger(id) where seq is null;
create or replace function ledger_guard() returns trigger language plpgsql as $g$
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger row % can not be deleted', old.id;
  end if;
  if old.seq is not null and new is distinct from old then
    raise exception 'ledger row % is sealed and can not be changed', old.id;
  end if;
  if new.user_id is distinct from old.user_id or new.delta <> old.delta or new.kind <> old.kind
     or new.ref is distinct from old.ref or new.created_at <> old.created_at then
    raise exception 'ledger row %: only its seal can be added', old.id;
  end if;
  return new;
end $g$;
drop trigger if exists ledger_guard on ledger;
create trigger ledger_guard before update or delete on ledger for each row execute function ledger_guard();
create table if not exists chain_anchors (
  id serial primary key,
  network text not null,
  seq bigint not null,                  -- the last sealed ledger row it covers
  hash text not null,                   -- that row's hash, written in the memo
  signature text not null unique,
  last_valid_height bigint,
  status text not null default 'sent',  -- sent | confirmed | finalized | dropped
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
-- what an anchor says can't be changed after the fact; only its status moves on
create or replace function chain_anchors_guard() returns trigger language plpgsql as $g$
begin
  if tg_op = 'DELETE' then
    raise exception 'anchor % can not be deleted', old.id;
  end if;
  if new.network <> old.network or new.seq <> old.seq or new.hash <> old.hash or new.signature <> old.signature
     or new.created_at <> old.created_at or new.last_valid_height is distinct from old.last_valid_height then
    raise exception 'anchor %: only its status can change', old.id;
  end if;
  return new;
end $g$;
drop trigger if exists chain_anchors_guard on chain_anchors;
create trigger chain_anchors_guard before update or delete on chain_anchors for each row execute function chain_anchors_guard();

-- Promo codes (/admin): each account that redeems one in the chat gets one free random NFT of the market's own
-- collection, until max_uses accounts have (market.js redeemCode). Codes are stored upper case.
create table if not exists promo_codes (
  code text primary key,
  collection_id int not null references collections(id),
  max_uses int not null check (max_uses > 0),
  used int not null default 0 check (used >= 0 and used <= max_uses),
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now()
);
create table if not exists promo_redemptions (
  id serial primary key,
  code text not null references promo_codes(code),
  user_id int not null references users(id),
  nft_id int not null unique references nfts(id),
  created_at timestamptz not null default now(),
  unique (code, user_id)
);
-- wrong codes tried, per account: a few an hour, so codes can't be guessed by trying many (kept a day)
create table if not exists promo_misses (
  id bigserial primary key,
  user_id int not null references users(id),
  created_at timestamptz not null default now()
);
create index if not exists promo_misses_user on promo_misses(user_id, created_at);
-- social tasks before a free mint (optional, per code): follow this X account, like + repost this post. The assistant
-- shows them, the user sends a screenshot, the assistant checks it and redeems with a note of what it saw (proof).
alter table promo_codes add column if not exists follow_url text;
alter table promo_codes add column if not exists tweet_url text;
alter table promo_redemptions add column if not exists proof text;
-- when an account was shown a code's tasks: a redemption with proof needs them shown a little while before
create table if not exists promo_tasks_shown (
  code text not null references promo_codes(code),
  user_id int not null references users(id),
  shown_at timestamptz not null default now(),
  primary key (code, user_id)
);
-- sending NFTs from the chat (send_nft): the list the user was shown, kept under a one-time code until they say yes
-- (used once, within 10 minutes; old ones are cleared as new previews come). Not in backups.
create table if not exists nft_send_previews (
  code text primary key,
  user_id int not null references users(id),
  items jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists nft_send_previews_age on nft_send_previews(created_at);
-- lost deposits reported on the site (/lost-deposit): checked by the owner in /admin; a report never moves money
create table if not exists deposit_claims (
  id serial primary key,
  deposit_address text not null,        -- the Solana address MCP gave for deposits, as the person typed it
  from_wallet text not null,            -- the wallet they sent from
  tx text not null,                     -- the transaction signature
  user_id int references users(id),     -- signed in on the site when they reported it, if they were
  ip_hash text not null,                -- salted hash of the sender's IP address, for the rate limit only
  status text not null default 'new',   -- new | done | rejected
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create unique index if not exists deposit_claims_tx_addr on deposit_claims(tx, deposit_address);
create index if not exists deposit_claims_tx on deposit_claims(tx);
create index if not exists deposit_claims_ip on deposit_claims(ip_hash, created_at);

-- OAuth for the MCP connector. Codes and tokens are stored as sha256 hashes, never in plain text.
create table if not exists oauth_clients (
  client_id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists oauth_pending (
  id text primary key,                  -- one login attempt, from /authorize until the user signs in
  client_id text not null,
  params jsonb not null,
  x_verifier text,
  created_at timestamptz not null default now()
);
create table if not exists oauth_codes (
  code text primary key,                -- sha256 of the authorization code
  client_id text not null,
  user_id int not null references users(id),
  challenge text not null,
  redirect_uri text not null,
  expires_at timestamptz not null
);
create table if not exists oauth_tokens (
  token text primary key,               -- sha256 of the access / refresh token
  kind text not null,                   -- access | refresh
  client_id text not null,
  user_id int not null references users(id),
  expires_at timestamptz not null
);
create index if not exists oauth_tokens_expiry on oauth_tokens(expires_at);

-- Only this server talks to the database. Row level security with no policies means that even if
-- Supabase's auto-generated REST API is ever switched on, its roles see nothing.
alter table app_meta enable row level security;
alter table users enable row level security;
alter table collections enable row level security;
alter table nfts enable row level security;
alter table ledger enable row level security;
alter table sales enable row level security;
alter table withdrawals enable row level security;
alter table withdrawal_attempts enable row level security;
alter table deposit_pool enable row level security;
alter table deposit_accounts enable row level security;
alter table deposits enable row level security;
alter table oauth_clients enable row level security;
alter table oauth_pending enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;
alter table chain_anchors enable row level security;
alter table mint_holds enable row level security;
alter table site_sessions enable row level security;
alter table promo_codes enable row level security;
alter table promo_redemptions enable row level security;
alter table promo_misses enable row level security;
alter table promo_tasks_shown enable row level security;
alter table nft_send_previews enable row level security;
alter table deposit_claims enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end $$;
`;

// One-time data changes, applied once each, in order, under the same lock as the schema.
const DATA_MIGRATIONS = [
  // 2026-10-19: the currency moved from whole $MCP test tokens to US dollars. 1 old token = 1 cent,
  // so the old mint price of 500 becomes $5.00 and a sale at 999 becomes $9.99.
  ['usd-micro', `
    update users set balance = balance * 10000;
    alter table ledger disable trigger ledger_guard;
    update ledger set delta = delta * 10000;
    alter table ledger enable trigger ledger_guard;
    update nfts set price = price * 10000 where price is not null;
    update sales set price = price * 10000;
    alter table withdrawals disable trigger withdrawals_guard;
    update withdrawals set amount = amount * 10000;
    alter table withdrawals enable trigger withdrawals_guard;`],
  // 2026-10-19: automatic payouts. Withdrawals queued before them were never paid (nothing could pay them):
  // they are refunded. Addresses bound before signed bindings keep working but their withdrawals wait for review.
  ['withdraw-v2', `
    with legacy as (
      update withdrawals set status = 'refunded', refunded_at = now(), error = 'queued before automatic payouts: refunded'
      where status = 'pending' and mac is null returning id, user_id, amount + fee as total
    ), l as (
      insert into ledger (user_id, delta, kind, ref) select user_id, total, 'withdraw_refund', 'w' || id from legacy returning user_id, delta
    )
    update users u set balance = u.balance + s.total from (select user_id, sum(delta) as total from l group by user_id) s where u.id = s.user_id;
    update users set withdraw_address_set_at = now() where withdraw_address is not null and withdraw_address_set_at is null;`],
  // 2026-10-27: the explorer groups ledger rows by the transaction that wrote them. Rows from before that have
  // no xact; rows of one transaction share created_at (now() is the transaction's start time).
  ['ledger-xact', `
    update ledger l set xact = -g.first from (select created_at, min(id) as first from ledger where xact is null group by created_at) g
    where l.xact is null and l.created_at = g.created_at;`],
  // 2026-10-28: the final MCP collection (5,000) replaces the 120 test NFTs, which were never minted on the
  // real server. If any of them was minted or sold, nothing is replaced and the server refuses to start:
  // that database needs a decision by hand. The new NFTs are added by seedCollection (market.js).
  ['mcp-collection', `
    do $c$ begin
      if exists (select 1 from nfts where collection_id is null and (minted_at is not null or owner_id is not null))
         or exists (select 1 from sales s join nfts n on n.id = s.nft_id where n.collection_id is null) then
        raise exception 'the test NFTs were minted here: they can not be replaced by the final collection automatically';
      end if;
    end $c$;
    delete from nfts where collection_id is null;`],
];

const VERSION = crypto.createHash('sha256').update(SCHEMA + DATA_MIGRATIONS.map(([k]) => k).join(',')).digest('hex').slice(0, 16);

async function appliedVersion(q) {
  const [r] = await q("select to_regclass('app_meta') is not null as ok");
  if (!r.ok) return null;
  const [row] = await q("select value from app_meta where key = 'schema'");
  return row?.value ?? null;
}

export async function migrate(db) {
  if (await appliedVersion(db.query) === VERSION) return false;
  await db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock(727274001)');
    if (await appliedVersion(t.query) === VERSION) return;
    await t.exec(SCHEMA);
    for (const [name, sql] of DATA_MIGRATIONS) {
      const key = `data:${name}`;
      const [done] = await t.query('select 1 from app_meta where key = $1', [key]);
      if (done) continue;
      await t.exec(sql);
      await t.query('insert into app_meta (key, value) values ($1, now()::text)', [key]);
    }
    await t.query("insert into app_meta (key, value) values ('schema', $1) on conflict (key) do update set value = excluded.value", [VERSION]);
  });
  return true;
}
