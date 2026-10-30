// Database backups without a paid database plan. Every 2 hours a scheduled function (netlify/functions/backup.mjs)
// copies every table that matters into one gzipped JSON file in Netlify Blobs (store "db-backups"), apart from
// the database. The owner downloads them from /admin and keeps a copy elsewhere (Google Drive, a laptop).
// server/scripts/restore-backup.js loads a file into a new, empty database.
//
// Kept: the copies of the last 48 hours, then the first copy of each day for 30 days.
// Not kept: sign-in sessions, OAuth codes and logins in progress (short-lived; people just sign in again), and
// NFT send previews (a few minutes each; the user just asks again).
// There are no keys or seed phrases in the database, so there are none in a backup either.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { GENESIS, entryHash, ledgerEntry } from './explorer.js';

export const FORMAT = 'mcp-backup';
// table -> its order (primary key). The order of the list is also the restore order.
export const TABLES = {
  app_meta: 'key',
  users: 'id',
  collections: 'id',
  nfts: 'id',
  ledger: 'id',
  sales: 'id',
  mint_holds: 'nft_id',
  deposit_pool: 'network, idx',
  deposit_accounts: 'address',
  deposits: 'id',
  withdrawals: 'id',
  withdrawal_attempts: 'id',
  chain_anchors: 'id',
  promo_codes: 'code',
  promo_redemptions: 'id',
  promo_tasks_shown: 'code, user_id',
  oauth_clients: 'client_id',
  oauth_tokens: 'token',
};
// app_meta rows that describe this database rather than the market: a restore keeps the new database's own
const LOCAL_META = /^(schema$|data:)/;

export const backupKey = (at) => `b/${new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.json.gz`;
export const KEY_RE = /^b\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.json\.gz$/;
export const keyTime = (key) => {
  const m = KEY_RE.exec(key);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`).getTime() : NaN;
};

// One consistent snapshot of every table, read inside one repeatable-read transaction. Postgres itself writes each
// row as JSON (to_jsonb), so amounts, ids and times (to the microsecond) are copied exactly, never through JS numbers.
export async function makeBackup(db, { now = new Date() } = {}) {
  const counts = {};
  const parts = await db.tx(async (t) => {
    await t.query('set transaction isolation level repeatable read, read only');
    const out = [];
    for (const [name, order] of Object.entries(TABLES)) {
      const rows = await t.query(`select to_jsonb(x)::text as r from ${name} x order by ${order}`);
      counts[name] = rows.length;
      out.push(`${JSON.stringify(name)}:[${rows.map((r) => r.r).join(',')}]`);
    }
    return out;
  });
  const json = `{"format":${JSON.stringify(FORMAT)},"version":1,"created_at":${JSON.stringify(now.toISOString())},"counts":${JSON.stringify(counts)},"tables":{${parts.join(',')}}}`;
  const gz = zlib.gzipSync(Buffer.from(json), { level: 9 });
  return { key: backupKey(now), data: gz, counts, bytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex') };
}

// which copies to keep: everything from the last keepHours, then the first copy of each UTC day for keepDays
export function toDelete(keys, now = Date.now(), { keepHours = 48, keepDays = 30 } = {}) {
  const days = new Set();
  const doomed = [];
  for (const key of [...keys].filter((k) => KEY_RE.test(k)).sort()) {
    const age = now - keyTime(key);
    const day = key.slice(2, 12);
    if (age <= keepHours * 3600e3) continue;
    if (age <= keepDays * 86400e3 && !days.has(day)) { days.add(day); continue; }
    days.add(day);
    doomed.push(key);
  }
  return doomed;
}

async function setStatus(db, status) {
  await db.query("insert into app_meta (key, value) values ('backup', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(status)]);
}

export async function lastBackup(db) {
  const [r] = await db.query("select value from app_meta where key = 'backup'");
  return r ? JSON.parse(r.value) : null;
}

// make a copy, store it, drop the copies no longer kept, and note how it went (shown on /admin)
export async function runBackup(db, store, { now = new Date(), log = console } = {}) {
  const started = Date.now();
  try {
    const b = await makeBackup(db, { now });
    await store.put(b.key, b.data);
    const doomed = toDelete((await store.list()), now.getTime());
    for (const k of doomed) await store.del(k);
    const status = { ok: true, at: now.toISOString(), key: b.key, bytes: b.bytes, sha256: b.sha256, counts: b.counts, ms: Date.now() - started, removed: doomed.length };
    await setStatus(db, status);
    log.log?.('backup', JSON.stringify({ key: b.key, bytes: b.bytes, ms: status.ms, removed: doomed.length }));
    return status;
  } catch (e) {
    const status = { ok: false, at: now.toISOString(), error: String(e?.message || e).slice(0, 300) };
    log.error?.(`ALERT backup failed: ${status.error}`);
    await setStatus(db, status).catch(() => {});
    return status;
  }
}

// the scheduled run (netlify/functions/backup.mjs): its own small connection, closed when done
export async function runScheduledBackup() {
  const { openPg } = await import('./pg.js');
  const { migrate } = await import('./schema.js');
  const { defaultBackupStore } = await import('./storage.js');
  const db = openPg(process.env.DATABASE_URL, { max: 1 });
  try {
    await migrate(db);
    return await runBackup(db, await defaultBackupStore());
  } finally {
    await db.close().catch(() => {});
  }
}

export function readBackup(buf) {
  let doc;
  try {
    // integers too big for a JS number stay exact (as their text)
    doc = JSON.parse(zlib.gunzipSync(buf).toString('utf8'), (k, v, ctx) => (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) ? ctx.source : v));
  } catch {
    throw new Error('not a backup file (it should be a .json.gz made by MCP)');
  }
  if (doc?.format !== FORMAT || !doc.tables) throw new Error('not an MCP backup');
  return doc;
}

// Loads a backup into an EMPTY database whose tables were just created (migrate). Foreign keys and triggers
// are switched off for the load (session_replication_role = replica), so the order of tables doesn't matter
// and the ledger's write guard doesn't object. Then the id counters continue after the restored rows, and
// the money is checked: every balance equals the sum of its ledger rows, and the hash chain is intact.
export async function restoreBackup(db, buf, { batch = 500 } = {}) {
  const doc = readBackup(buf);
  const [{ n }] = await db.query('select (select count(*) from users) + (select count(*) from ledger) + (select count(*) from nfts) as n');
  if (Number(n) > 0) throw new Error('the target database is not empty: restore only into a new database');
  await db.tx(async (t) => {
    await t.query('set local session_replication_role = replica');
    for (const name of Object.keys(TABLES)) {
      const rows = doc.tables[name] || [];
      for (let i = 0; i < rows.length; i += batch) {
        const part = JSON.stringify(rows.slice(i, i + batch));
        if (name === 'app_meta') {
          await t.query(`insert into app_meta select * from jsonb_populate_recordset(null::app_meta, $1::jsonb) r
            where r.key !~ '${LOCAL_META.source}' on conflict (key) do update set value = excluded.value`, [part]);
        } else {
          await t.query(`insert into ${name} select * from jsonb_populate_recordset(null::${name}, $1::jsonb)`, [part]);
        }
      }
    }
    // the id counters carry on after the restored rows
    for (const name of ['users', 'collections', 'ledger', 'sales', 'deposits', 'withdrawals', 'withdrawal_attempts', 'chain_anchors', 'promo_redemptions']) {
      await t.query(`select setval(pg_get_serial_sequence('${name}', 'id'), greatest((select max(id) from ${name}), 1), (select max(id) from ${name}) is not null)`);
    }
    await t.query("select setval('nft_ids', greatest((select max(id) from nfts where id >= 100001), 100001), (select max(id) from nfts where id >= 100001) is not null)");
  });
  const counts = {};
  for (const name of Object.keys(TABLES)) counts[name] = Number((await db.query(`select count(*) as n from ${name}`))[0].n);
  return { counts, created_at: doc.created_at, check: await checkMoney(db) };
}

// the two things a restore must get exactly right
export async function checkMoney(db) {
  const off = await db.query(`select u.id, u.balance, coalesce(sum(l.delta), 0) as ledger from users u left join ledger l on l.user_id = u.id
    group by u.id having u.balance <> coalesce(sum(l.delta), 0)`);
  const rows = await db.query(`select l.id, l.user_id, l.delta, l.kind, l.ref, l.created_at, l.seq, l.hash, u.public_id
    from ledger l left join users u on u.id = l.user_id where l.seq is not null order by l.seq`);
  let prev = GENESIS;
  let chainOk = true;
  let brokenAt = null;
  for (const r of rows) {
    if (entryHash(prev, ledgerEntry(r)) !== r.hash) { chainOk = false; brokenAt = Number(r.seq); break; }
    prev = r.hash;
  }
  return { balancesMatch: off.length === 0, balancesOff: off.length, chainOk, sealed: rows.length, brokenAt };
}
