// Loads a backup made by MCP (downloaded from /admin, mcp-backup-<time>.json.gz) into a NEW, EMPTY database.
// Runs on your computer. The database address with its password goes in an environment variable, never on
// the command line where it would end up in your shell history:
//
//   RESTORE_DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
//     node server/scripts/restore-backup.js mcp-backup-2026-10-28T12-17-00Z.json.gz
//
// It creates the tables, loads every row, continues the id counters and then checks the money: every balance
// equals the sum of its ledger rows and the hash chain is intact (the same check the explorer's "Verify" does).
// Then point DATABASE_URL in Netlify at the new database and redeploy. It refuses a database that has data.
import fs from 'node:fs';
import { openPg } from '../src/pg.js';
import { migrate } from '../src/schema.js';
import { restoreBackup, readBackup } from '../src/backup.js';

const file = process.argv[2];
const url = process.env.RESTORE_DATABASE_URL;
if (!file || !fs.existsSync(file)) {
  console.error('Usage: RESTORE_DATABASE_URL=<new empty database> node server/scripts/restore-backup.js <backup.json.gz>');
  process.exit(1);
}
const buf = fs.readFileSync(file);
const doc = readBackup(buf);
console.log(`Backup from ${doc.created_at}:`, Object.entries(doc.counts).map(([k, v]) => `${k} ${v}`).join(', '));
if (!url) {
  console.error('\nThe file is fine. Set RESTORE_DATABASE_URL to the new, empty database to load it.');
  process.exit(1);
}
const db = openPg(url, { max: 1 });
try {
  await migrate(db);
  const out = await restoreBackup(db, buf);
  console.log('Restored:', Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(', '));
  const c = out.check;
  console.log(c.balancesMatch ? 'Balances: every balance equals its ledger rows.' : `Balances: ${c.balancesOff} accounts do NOT match their ledger!`);
  console.log(c.chainOk ? `Chain: all ${c.sealed} sealed entries match their hashes.` : `Chain: broken at entry ${c.brokenAt}!`);
  if (!c.balancesMatch || !c.chainOk) process.exitCode = 2;
} catch (e) {
  console.error('Restore failed:', e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
