// Fills a local database with fake traders so the preview site has something to show.
// Usage: PGLITE_DIR=./data TEST_MODE=1 node scripts/demo-data.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MCP_TRADING ||= 'open'; // demo traders list MCP NFTs long before the sell-out
const { openDb } = await import('../src/db.js');
const m = await import('../src/market.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = await openDb();
await m.seedCollection(db, path.join(ROOT, 'collection', 'collection.json'));
const handles = ['artem', 'degen_kim', 'solmaxi', 'pixelpunk', 'gm_anon', 'wagmi_lu', 'ser_chad', 'nft_nina'];
const users = [];
for (const h of handles) {
  const u = await m.upsertUser(db, { xId: `dev:${h}`, handle: h });
  await m.credit(db, u.id, 60 * 1e6, 'deposit', `demo-${h}`).catch(() => {});
  users.push(u);
}
let r = 7;
const rnd = (n) => (r = (r * 9301 + 49297) % 233280) % n;
const owned = [];
for (const u of users) for (let i = 0; i < 4; i++) owned.push([u, await m.mint(db, u.id)]);
for (const [u, n] of owned) if (rnd(10) < 6) await m.list(db, u.id, n.id, (300 + rnd(16) * 50) * m.CENT); // $3.00–$10.50
for (let i = 0; i < 9; i++) {
  const listed = await m.browse(db, { status: 'listed' });
  const n = listed[rnd(listed.length)];
  const buyer = users.find((u) => u.handle !== n.owner && rnd(3) === 0) || users.find((u) => u.handle !== n.owner);
  await m.buy(db, buyer.id, n.id, Number(n.price)).catch(() => {});
}
for (const [u, n] of owned.slice(0, 6)) await m.list(db, u.id, n.id, (400 + rnd(10) * 60) * m.CENT).catch(() => {});
console.log(await m.stats(db));
await db.close();
