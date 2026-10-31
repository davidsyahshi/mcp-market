// $CREDIT: MCP NFTs burned for $CREDIT (10,000 each) in the burn form, $CREDIT claimed to a Solana wallet for the airdrop
// in the claim form (fee 0.5 $MCP), the owner's list in /admin, the burn card for X, the explorer, and the Tokens page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { base58 } from '@scure/base';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open'; // MCP NFTs trade (and burn) long before 5,000 are minted here
process.env.ADMIN_X_IDS = 'dev:crboss';
delete process.env.CREDIT_LAUNCH_AT;
const { openDb } = await import('../src/db.js');
const { createApp, SITE_PAGES } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { buildMcpServer, creditToken, transferToken } = await import('../src/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { readPng } = await import('../src/png.js');
const { findRoot } = await import('../src/paths.js');
const { checkMoney } = await import('../src/backup.js');
const sol = await import('../src/solana.js');
const credit = await import('../src/credit.js');
const m = await import('../src/market.js');

const root = findRoot();
let db, app, server, base, explorer;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app, explorer } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = () => [...crypto.randomBytes(88)].map((b) => B58[b % 58]).join('');
// a real wallet address: an ed25519 public key (on the curve)
const wallet = () => base58.encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
let n = 0;
async function user(handle = `cr${++n}`, dollars = 10) {
  const u = await m.upsertUser(db, { xId: `dev:${handle}`, handle });
  await m.ensurePublicIds(db);
  if (dollars) await m.credit(db, u.id, dollars * 1e6, 'deposit', `USDC ${sig()} ${sig().slice(0, 44)}`);
  return (await db.query('select * from users where id = $1', [u.id]))[0];
}
const nftsOf = async (u, k) => (await m.teamMint(db, u.id, k)).minted.map((x) => x.id);
const creditOf = async (u) => Number((await db.query('select credit_balance from users where id = $1', [u.id]))[0].credit_balance);
// the invariant: an account's $CREDIT is what its burns gave minus what its claims took
async function creditMatches() {
  const off = await db.query(`select u.id from users u where u.credit_balance <>
    coalesce((select sum(credit) from burns where user_id = u.id), 0)
    + coalesce((select sum(amount) from credit_drop_claims where user_id = u.id and stage = 'done'), 0)
    - coalesce((select sum(amount) from credit_claims where user_id = u.id and status <> 'void'), 0)`);
  return off.length === 0;
}

// someone in their AI chat
async function chat(u) {
  const srv = buildMcpServer(db, u.id, { publicUrl: 'https://mcp.example', thumbsDir: path.join(root, 'collection', 'thumbs'), deposits: { enabled: false }, ui: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  const raw = (name, args = {}) => c.callTool({ name, arguments: args });
  const txt = (r) => (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return { client: c, raw, txt };
}

test('burn: NFTs gone for good, 10,000 $CREDIT each, one explorer transaction, listed ones off the market', async () => {
  const a = await user();
  const [x, y, z, keep] = await nftsOf(a, 4);
  await m.list(db, a.id, y, 7_000_000);
  const b = await credit.burn(db, a.id, [z, x, y]);
  assert.equal(b.count, 3);
  assert.equal(b.credit, 30_000);
  assert.equal(b.balance, 30_000);
  assert.deepEqual(b.nfts.map((q) => q.id), [x, y, z].sort((p, q) => p - q));
  const rows = await db.query('select id, owner_id, price, listed_at, burned_at, burned_by, minted_at from nfts where id = any($1::int[])', [[x, y, z, keep]]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const r of [x, y, z].map((id) => byId.get(id))) {
    assert.equal(r.owner_id, null);
    assert.equal(r.price, null);
    assert.ok(r.burned_at);
    assert.equal(Number(r.burned_by), a.id);
    assert.ok(r.minted_at, 'stays minted: never minted again');
  }
  assert.equal(Number(byId.get(keep).owner_id), a.id);
  const led = await db.query("select user_id, delta, kind, ref, xact from ledger where kind = 'burn' and user_id = $1 order by id", [a.id]);
  assert.equal(led.length, 3);
  assert.ok(led.every((l) => Number(l.delta) === 0 && String(l.xact) === String(led[0].xact)));
  assert.equal(await creditOf(a), 30_000);
  assert.ok(await creditMatches());
  assert.equal((await checkMoney(db)).balancesMatch, true);
  // a burned NFT can't be listed, bought, sent or burned again
  await assert.rejects(m.list(db, a.id, x, 5_000_000), /don't own/);
  await assert.rejects(credit.burn(db, a.id, [x]), /don't own/);
  await assert.rejects(m.sendNftsFromForm(db, a.id, [{ nft_id: y, to: (await user()).public_id }]), /don't own/);
  // the NFT's page and the chat say burned; its history has the burn
  const nft = await m.getNft(db, x);
  assert.ok(nft.burned_at);
  assert.equal(nft.owner_addr, null);
  assert.equal(nft.activity[0].type, 'burn'); // newest first
  assert.equal(nft.activity[0].from_addr, a.public_id);
  // the collection counts burned NFTs
  assert.ok((await m.stats(db, { collection: 'mcp' })).burned >= 3);
});

test('burn: all or nothing; only your own MCP NFTs; not before the sell-out of a mint-phase collection', async () => {
  const a = await user();
  const b = await user();
  const [x] = await nftsOf(a, 1);
  const [other] = await nftsOf(b, 1);
  const before = await creditOf(a);
  await assert.rejects(credit.burn(db, a.id, [x, other]), /You don't own .*Nothing was burned/);
  await assert.rejects(credit.burn(db, a.id, []), /Pick the NFTs/);
  await assert.rejects(credit.burn(db, a.id, [x, x]), /twice/);
  await assert.rejects(credit.burn(db, a.id, [...Array(credit.BURN_MAX + 1).keys()].map((i) => i + 1)), /at most 500/);
  await assert.rejects(credit.burn(db, a.id, [999999]), /don't own/);
  assert.equal((await db.query('select owner_id from nfts where id = $1', [x]))[0].owner_id, a.id);
  assert.equal(await creditOf(a), before);
  // another collection's NFT
  const slug = `crx${crypto.randomBytes(3).toString('hex')}`;
  const [col] = await db.query("insert into collections (slug, name, supply, mint_price, mint_limit, status) values ($1, 'CRX', 1, 1000000, 1, 'live') returning id", [slug]);
  const [{ id: otherId }] = await db.query("insert into nfts (id, name, collection_id, edition, owner_id, minted_at) values (nextval('nft_ids'), 'CRX #1', $1, 1, $2, now()) returning id", [col.id, a.id]);
  await assert.rejects(credit.burn(db, a.id, [otherId]), /Only MCP NFTs/);
  // while MCP is still in its mint phase
  await db.query("update collections set trade_after_sold_out = true where slug = 'mcp'");
  try {
    await assert.rejects(credit.burn(db, a.id, [x]), /opens when the whole MCP collection is minted/);
  } finally {
    await db.query("update collections set trade_after_sold_out = false where slug = 'mcp'");
  }
  assert.ok(await creditMatches());
});

test('claim: all the $CREDIT to a wallet for 0.5 $MCP to the treasury; a retry never claims twice; bad addresses refused', async () => {
  const a = await user(undefined, 1);
  const w = wallet();
  assert.ok(sol.isWallet(w));
  await assert.rejects(credit.claim(db, a.id, { wallet: w }), /No \$CREDIT to claim yet/);
  await credit.burn(db, a.id, await nftsOf(a, 2));
  // not a wallet
  await assert.rejects(credit.claim(db, a.id, { wallet: 'mcp_AbC123xyZ789' }), /not a Solana address/);
  const ata = sol.associatedTokenAddress(w, sol.STABLECOINS.mainnet[0].mint);
  assert.ok(sol.isAddress(ata) && !sol.isWallet(ata));
  await assert.rejects(credit.claim(db, a.id, { wallet: ata }), /token account, not a wallet/);
  const [pool] = await db.query("insert into deposit_pool (network, idx, address, mac) values ('mainnet', $2, $1, 'x') returning address", [wallet(), 900000 + crypto.randomInt(90000)]);
  await assert.rejects(credit.claim(db, a.id, { wallet: pool.address }), /an address of this market/);
  const treasury = async () => Number((await db.query("select coalesce(sum(delta), 0) as s from ledger where user_id is null and kind = 'claim_fee'"))[0].s);
  const t0 = await treasury();
  const c = await credit.claim(db, a.id, { wallet: ` ${w} `, requestKey: 'key-one-12345' });
  assert.equal(c.amount, 20_000);
  assert.equal(c.wallet, w);
  assert.equal(c.fee, 500_000);
  assert.equal(c.status, 'pending');
  assert.equal(c.credit_balance, 0);
  assert.equal(c.mcp_balance, 500_000);
  assert.equal(await treasury(), t0 + 500_000);
  // the same request again (a lost answer): the same claim, no second fee
  const again = await credit.claim(db, a.id, { wallet: w, requestKey: 'key-one-12345' });
  assert.equal(again.id, c.id);
  assert.equal(again.repeated, true);
  assert.equal(await treasury(), t0 + 500_000);
  await assert.rejects(credit.claim(db, a.id, { wallet: w, requestKey: 'key-two-12345' }), /No \$CREDIT to claim yet/);
  // more burns later: claim again; not enough $MCP for the fee
  const poor = await user(undefined, 0);
  await credit.burn(db, poor.id, await nftsOf(poor, 1));
  await assert.rejects(credit.claim(db, poor.id, { wallet: w }), /Claiming costs 0\.50 \$MCP, and the balance is 0 \$MCP\. Top up 0\.50 \$MCP or more/);
  assert.equal(await creditOf(poor), 10_000);
  assert.ok(await creditMatches());
  assert.equal((await checkMoney(db)).balancesMatch, true);
  // a claim's wallet and amount never change; it is never deleted
  await assert.rejects(db.query('update credit_claims set wallet = $1 where id = $2', [wallet(), c.id]), /only its status/);
  await assert.rejects(db.query('update credit_claims set amount = 1 where id = $1', [c.id]), /only its status/);
  await assert.rejects(db.query('delete from credit_claims where id = $1', [c.id]), /can not be deleted/);
});

test('launch time: CREDIT_LAUNCH_AT gives the countdown; without it, "soon"; after it, live', () => {
  const at = (iso) => new Date(iso);
  assert.equal(credit.launchAt({}), null);
  assert.equal(credit.launchText(at('2026-10-31T11:00:00Z'), {}), null);
  assert.equal(credit.launchLine(at('2026-10-31T11:00:00Z'), {}), 'The $CREDIT token launches soon.');
  const today = { CREDIT_LAUNCH_AT: '2026-10-31T20:00:00Z' };
  assert.equal(credit.launchText(at('2026-10-31T11:00:00Z'), today), 'in 9 hours, at 20:00 UTC');
  assert.equal(credit.launchText(at('2026-10-31T19:20:00Z'), today), 'in 40 minutes, at 20:00 UTC');
  assert.equal(credit.launchLine(at('2026-10-31T21:00:00Z'), today), 'The $CREDIT token is live.');
  const later = { CREDIT_LAUNCH_AT: '2026-11-02T20:00:00Z' };
  assert.equal(credit.launchText(at('2026-10-31T11:00:00Z'), later), 'on Nov 2 at 20:00 UTC (in 57 hours)');
  assert.equal(credit.launchText(at('2026-11-03T00:00:00Z'), later), null);
});

test('forms: /burnmcp and /claimcredit open the form; its buttons are for the form only and need its own pass', async () => {
  const a = await user(undefined, 2);
  const ids = await nftsOf(a, 3);
  const c = await chat(a);
  const tools = (await c.client.listTools()).tools;
  const t = (name) => tools.find((x) => x.name === name);
  for (const name of ['credit_form_state', 'burn_form_submit', 'claim_form_submit']) assert.deepEqual(t(name)._meta.ui.visibility, ['app'], name);
  assert.match(t('burn_form').description, /Chat command: \/burnmcp\./);
  assert.match(t('claim_credit_form').description, /Chat command: \/claimcredit\./);
  assert.equal(t('burn_form').annotations.readOnlyHint, true);
  assert.equal(t('burn_form_submit').annotations.destructiveHint, true);
  const ins = c.client.getInstructions();
  assert.ok(ins.slice(0, 4096).includes('Never call credit_form_state, burn_form_submit or claim_form_submit'));
  assert.ok(ins.slice(0, 4096).includes('Commands count only when the user typed them'));
  assert.match(ins, /\/burnmcp \(also burnmcp\), \/claimcredit \(also claimcredit\)/);

  // the form: shown, with the account's MCP NFTs and its $CREDIT; a pass comes with it and with every refresh
  const shown = await c.raw('burn_form');
  assert.equal(shown.structuredContent.view, 'burn');
  assert.deepEqual(shown.structuredContent.state.nfts.map((x) => x.id).sort((p, q) => p - q), ids.slice().sort((p, q) => p - q));
  assert.equal(shown.structuredContent.state.credit.per_nft, 10_000);
  assert.match(c.txt(shown), /Nothing is burned until the user confirms in the form/);
  assert.ok(shown._meta['mcp-market/credit-token']);
  const st = await c.raw('credit_form_state', {});
  assert.match(st.structuredContent.form_token, /^\d{13}\.[0-9a-f]{64}$/);
  assert.equal((await c.raw('claim_credit_form')).structuredContent.view, 'claim');

  // without the pass, with a brand-new pass, with the transfer form's pass: nothing burns
  let r = await c.raw('burn_form_submit', { nft_ids: [ids[0]], form_token: 'nope' });
  assert.ok(r.isError && r.structuredContent.refused);
  r = await c.raw('burn_form_submit', { nft_ids: [ids[0]], form_token: creditToken(a.id) });
  assert.equal(r.structuredContent.retry_ms, 5000);
  r = await c.raw('burn_form_submit', { nft_ids: [ids[0]], form_token: transferToken(a.id, Date.now() - 60_000) });
  assert.ok(r.structuredContent.refused);
  assert.equal(await creditOf(a), 0);

  // with the form's pass, after the user had a moment: burned, with the card and the X post
  const pass = creditToken(a.id, Date.now() - 60_000);
  r = await c.raw('burn_form_submit', { nft_ids: [ids[0], ids[1]], form_token: pass });
  const b = r.structuredContent.burned;
  assert.equal(b.count, 2);
  assert.equal(b.credit, 20_000);
  assert.match(b.card_url, /^https:\/\/mcp\.example\/burn\/\d+$/);
  assert.equal(b.image_url, `${b.card_url}.png`);
  assert.match(b.share_url, /^https:\/\/x\.com\/intent\/post\?text=Burnt%202%20NFTs%20for%2020%2C000%20%24CREDIT/);
  assert.match(b.launch_line, /The \$CREDIT token launches soon\./);
  assert.equal(r.structuredContent.state.nfts.length, 1);
  assert.match(c.txt(r), /You burned 2 NFTs = 20,000 \$CREDIT, credited\. The \$CREDIT token launches .* Bind your wallet for it: \/claimcredit/);
  // after a lost answer the form asks which are burned
  const chk = await c.raw('credit_form_state', { check: [ids[0], ids[2]] });
  assert.deepEqual(chk.structuredContent.burned, { [ids[0]]: 'burned', [ids[2]]: 'yours' });
  assert.equal(chk.structuredContent.state.credit.last_burn.count, 2);

  // the claim, in the form
  const w = wallet();
  r = await c.raw('claim_form_submit', { wallet: w, request_key: 'form-key-0001', form_token: pass });
  assert.equal(r.structuredContent.claimed.amount, 20_000);
  assert.equal(r.structuredContent.claimed.fee, 0.5);
  assert.equal(r.structuredContent.state.credit.balance, 0);
  assert.equal(r.structuredContent.state.credit.claims[0].wallet, w);
  r = await c.raw('claim_form_submit', { wallet: w, request_key: 'form-key-0001', form_token: pass });
  assert.equal(r.structuredContent.claimed.repeated, true);
  r = await c.raw('claim_form_submit', { wallet: 'bad', request_key: 'form-key-0002', form_token: pass });
  assert.ok(r.structuredContent.refused);
  // the account shows $CREDIT; the form page is an MCP App that allows the site's pictures
  await credit.burn(db, a.id, [ids[2]]);
  assert.match(c.txt(await c.raw('account')), /\$CREDIT: 10,000 \(claim it to a Solana wallet: \/claimcredit\)/);
  assert.match(c.txt(await c.raw('account')), /burned MCP #\d+ for \$CREDIT/);
  const uri = t('burn_form')._meta.ui.resourceUri;
  assert.match(uri, /^ui:\/\/mcp-market\/credit-[0-9a-f]{12}\.html$/);
  const page = (await c.client.readResource({ uri })).contents[0];
  assert.match(page.text, /const McpApps=/);
  assert.deepEqual(page._meta.ui.csp.resourceDomains, ['https://mcp.example']);
  assert.ok(await creditMatches());
});

test('the burn card: a 1600 x 900 PNG and a page that previews it on X; the explorer shows burns and claims', async () => {
  const a = await user(undefined, 1);
  const ids = await nftsOf(a, 12);
  const b = await credit.burn(db, a.id, ids);
  const png = await fetch(`${base}/burn/${b.id}.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('netlify-cdn-cache-control') || '', /immutable/);
  const img = readPng(Buffer.from(await png.arrayBuffer()));
  assert.deepEqual([img.width, img.height], [1600, 900]);
  const page = await fetch(`${base}/burn/${b.id}`);
  const html = await page.text();
  assert.match(html, new RegExp(`<meta property="og:image" content="http://localhost/burn/${b.id}\\.png">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /BURNT 12 NFTs · 120,000 \$CREDIT/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${base}/burn/99999.png`)).status, 404);
  assert.equal((await fetch(`${base}/burn/99999`)).status, 404);

  // explorer: a "burn" transaction with its $CREDIT and card; the burns filter; a claim's fee
  const burns = await (await fetch(`${base}/api/explorer/txs?type=burn`)).json();
  const tx = burns.find((x) => x.burn?.id === b.id);
  assert.ok(tx);
  assert.equal(tx.type, 'burn');
  assert.deepEqual([tx.burn.count, tx.burn.credit, tx.burn.account], [12, 120_000, a.public_id]);
  assert.equal(tx.nft.id, Math.min(...ids));
  assert.ok(burns.every((x) => x.type === 'burn'));
  await credit.claim(db, a.id, { wallet: wallet() });
  const all = await (await fetch(`${base}/api/explorer/txs?addr=${a.public_id}`)).json();
  const fee = all.find((x) => x.type === 'claim');
  assert.ok(fee);
  assert.equal(fee.entries.find((e) => e.account === a.public_id).amount, -0.5);
  assert.equal(fee.entries.find((e) => e.account === 'treasury').amount, 0.5);
  const nft = await (await fetch(`${base}/api/nfts/${ids[0]}`)).json();
  assert.ok(nft.burned_at);
  assert.equal(nft.activity[0].type, 'burn');
});

test('admin: claims with wallets, copied as wallet,amount lines (one per wallet), marked sent; owner only', async () => {
  const boss = await browserAs('crboss');
  const nobody = await browserAs('crnobody');
  assert.equal((await nobody.call('GET', '/admin/credit')).status, 403);
  const w = wallet();
  const a = await user(undefined, 2);
  const b = await user(undefined, 1);
  await credit.burn(db, a.id, await nftsOf(a, 1));
  const c1 = await credit.claim(db, a.id, { wallet: w });
  await credit.burn(db, a.id, await nftsOf(a, 2));
  const c2 = await credit.claim(db, a.id, { wallet: w });
  await credit.burn(db, b.id, await nftsOf(b, 3));
  const w2 = wallet();
  const c3 = await credit.claim(db, b.id, { wallet: w2 });
  const r = await boss.call('GET', '/admin/credit');
  assert.equal(r.status, 200);
  const lines = r.body.airdrop.split('\n');
  assert.ok(lines.includes(`${w},30000`), 'two claims to one wallet are one line');
  assert.ok(lines.includes(`${w2},30000`));
  assert.ok(r.body.totals.burned_nfts >= 6);
  const mine = r.body.claims.filter((c) => [c1.id, c2.id, c3.id].includes(c.id));
  assert.equal(mine.length, 3);
  assert.ok(mine.every((c) => c.status === 'pending' && c.addr && c.handle));
  // marked sent: out of the airdrop list; and back
  const marked = await boss.call('POST', '/admin/credit/mark', { ids: [c1.id, c2.id], status: 'sent' });
  assert.equal(marked.body.updated, 2);
  const after2 = await boss.call('GET', '/admin/credit');
  assert.ok(!after2.body.airdrop.includes(w));
  assert.ok(after2.body.airdrop.includes(`${w2},30000`));
  assert.equal((await boss.call('POST', '/admin/credit/mark', { ids: [c1.id], status: 'pending' })).body.updated, 1);
  assert.equal((await boss.call('POST', '/admin/credit/mark', { ids: [c1.id], status: 'deleted' })).status, 400);
  assert.equal((await nobody.call('POST', '/admin/credit/mark', { ids: [c3.id], status: 'sent' })).status, 403);
  // the admin page has the section and the copy button
  const js = fs.readFileSync(path.join(root, 'site', 'launch.js'), 'utf8');
  assert.match(js, /\$CREDIT claims/);
  assert.match(js, /navigator\.clipboard\.writeText\(lines\)/);
});

test('Tokens page: its own address, in the menu, "$CREDIT IS GOING LIVE SOON"', () => {
  assert.ok(SITE_PAGES.test('/tokens'));
  const site = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  assert.match(site, /<a href="\/tokens" data-nav="tokens">Tokens<\/a>/);
  assert.match(site, /<span class="tk">\$CREDIT<\/span> IS GOING<br>LIVE SOON/);
  assert.match(site, /if \(pathPart === '\/tokens'\) return renderTokens\(\);/);
  assert.match(fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8'), /from = "\/tokens"/);
});

test('free $CREDIT drop through the promo-code tool: tasks, the card to post, the post, then the $CREDIT; once per account', async () => {
  const d = await credit.createDrop(db, { code: 'free1000', amount: 1000, uses: 2, follow_url: 'https://x.com/mcpmarkets', tweet_url: 'https://x.com/mcpmarkets/status/123456789' });
  assert.equal(d.code, 'FREE1000');
  await assert.rejects(m.createPromo(db, { code: 'FREE1000', uses: 5 }), /already a \$CREDIT drop/);
  await assert.rejects(credit.createDrop(db, { code: 'FREE-1000', amount: 5, uses: 5 }), /already exists/);
  await assert.rejects(credit.createDrop(db, { code: 'CREDIT', amount: 5, uses: 5 }), /more than the words/);
  await assert.rejects(credit.createDrop(db, { code: 'BIGDROP', amount: 0, uses: 5 }), /per account/);
  for (const typed of ['FREE 1000 $CREDIT MCP', '/mcpcredit FREE1000', 'free 1,000 $CREDIT', 'FREE1000']) assert.equal(await credit.findDrop(db, typed), 'FREE1000', typed);
  assert.equal(await credit.findDrop(db, 'EARLY'), null);

  const a = await user(undefined, 0);
  const c = await chat(a);
  const say = (code, proof) => c.raw('redeem_code', { code, ...(proof ? { proof } : {}) });
  const older = () => db.query("update credit_drop_claims set shown_at = shown_at - interval '20 seconds' where user_id = $1", [a.id]);
  // /mcpcredit says the drop is live
  assert.match(c.txt(await c.raw('mcpcredit')), /FREE 1,000 \$CREDIT airdrop is live: send \/mcpcredit FREE1000/);
  // 1. the tasks
  let r = await say('FREE 1000 $CREDIT MCP');
  assert.match(c.txt(r), /FREE 1,000 \$CREDIT airdrop 🎁 Before you get it:\n1\. Follow us on X: https:\/\/x\.com\/mcpmarkets\n2\. Like \+ RT this post/);
  assert.equal(r.structuredContent.nfts.view, 'tasks');
  assert.match(r.structuredContent.nfts.intro, /FREE 1,000 \$CREDIT/);
  r = await say('FREE1000', 'liked, reposted, following');
  assert.match(c.txt(r), /Do the tasks first/, 'a screenshot right away is too soon');
  await older();
  // 2. the card to post: a use is counted, no $CREDIT yet
  r = await say('FREE1000', 'post liked and reposted, following @mcpmarkets');
  assert.match(c.txt(r), /Your FREE 1,000 \$CREDIT AIRDROP is reserved 🎁\nTo confirm your allocation you must post your card on X: https:\/\/x\.com\/intent\/post\?text=/);
  assert.ok(r.content.some((x) => x.type === 'image' && x.mimeType === 'image/png'), 'the card comes as a picture too');
  const card = r.structuredContent.nfts;
  assert.equal(card.view, 'drop');
  assert.match(card.image_url, /^https:\/\/mcp\.example\/airdrop\/\d+\.png$/);
  assert.match(r._meta['mcp-market/images'].drop, /^data:image\/png;base64,/);
  assert.equal(await creditOf(a), 0);
  assert.equal((await credit.drops(db))[0].used, 1);
  r = await say('FREE1000', 'a post with the card');
  assert.match(c.txt(r), /Post it first/, 'a screenshot right away is too soon');
  await older();
  // 3. the post: the $CREDIT
  r = await say('FREE1000', 'their post on X with the FREE 1,000 $CREDIT card');
  assert.match(c.txt(r), /Allocation confirmed ✅ FREE 1,000 \$CREDIT is on your account\. Your \$CREDIT: 1,000\./);
  assert.match(c.txt(r), /\/claimcredit/);
  assert.equal(await creditOf(a), 1000);
  r = await say('FREE1000', 'again');
  assert.match(c.txt(r), /already got your FREE 1,000 \$CREDIT/);
  assert.equal(await creditOf(a), 1000);
  assert.ok(await creditMatches());
  // the card's picture and page
  const id = Number(/airdrop\/(\d+)/.exec(card.image_url)[1]);
  const png = await fetch(`${base}/airdrop/${id}.png`);
  assert.equal(png.status, 200);
  assert.deepEqual([readPng(Buffer.from(await png.arrayBuffer())).width], [1600]);
  assert.match(await (await fetch(`${base}/airdrop/${id}`)).text(), /<meta property="og:image" content="http:\/\/localhost\/airdrop\/\d+\.png">/);
  // the uses run out; a paused drop takes no one new
  const b = await user(undefined, 0);
  const cb = await chat(b);
  await cb.raw('redeem_code', { code: 'FREE1000' });
  await db.query("update credit_drop_claims set shown_at = shown_at - interval '20 seconds' where user_id = $1", [b.id]);
  assert.match(cb.txt(await cb.raw('redeem_code', { code: 'FREE1000', proof: 'tasks done' })), /reserved/);
  const late = await chat(await user(undefined, 0));
  r = await late.raw('redeem_code', { code: 'FREE1000' });
  assert.ok(r.isError);
  assert.match(late.txt(r), /All 2 free airdrops of FREE1000 are taken/);
  await credit.updateDrop(db, 'FREE1000', { uses: 10, status: 'paused' });
  assert.match(late.txt(await late.raw('redeem_code', { code: 'FREE1000' })), /paused/);
  await assert.rejects(credit.updateDrop(db, 'FREE1000', { uses: 1 }), /can't go below/);
  // the owner's list
  const boss = await browserAs('crboss');
  const list = await boss.call('GET', '/admin/drops');
  assert.equal(list.status, 200);
  const row = list.body.find((x) => x.code === 'FREE1000');
  assert.deepEqual([row.amount, row.used, row.done, row.max_uses, row.status], [1000, 2, 1, 10, 'paused']);
  assert.equal((await boss.call('POST', '/admin/drops/FREE1000', { status: 'active' })).body.status, 'active');
  assert.equal((await boss.call('POST', '/admin/drops', { code: 'MORE500', amount: 500, uses: 100 })).body.code, 'MORE500');
  const totals = (await boss.call('GET', '/admin/credit')).body.totals;
  assert.ok(totals.drops >= 1 && totals.drop_credit >= 1000);
});

test('review fixes: void returns the $CREDIT, the copied claims are what gets marked, retries and changed amounts, closed burns, one card address', async () => {
  const a = await user(undefined, 3);
  await credit.burn(db, a.id, await nftsOf(a, 1));
  // the amount the user confirmed has to be the amount claimed
  await assert.rejects(credit.claim(db, a.id, { wallet: wallet(), expected: 5 }), /Your \$CREDIT is now 10,000, not 5\. Check it and confirm again\./);
  // the market's own payout wallet
  const hot = wallet();
  await assert.rejects(credit.claim(db, a.id, { wallet: hot, blocked: [hot] }), /an address of this market/);
  const c1 = await credit.claim(db, a.id, { wallet: wallet(), expected: 10_000 });
  // void: the $CREDIT comes back, the fee stays; only a pending claim; mark leaves it alone
  const v = await credit.voidClaim(db, c1.id);
  assert.deepEqual([v.returned, v.credit_balance], [10_000, 10_000]);
  await assert.rejects(credit.voidClaim(db, c1.id), /only a pending claim/);
  assert.equal((await credit.markClaims(db, [c1.id], 'sent')).updated, 0);
  assert.ok(await creditMatches());
  assert.equal((await checkMoney(db)).creditMatch, true);
  const c2 = await credit.claim(db, a.id, { wallet: wallet() });
  await credit.markClaims(db, [c2.id], 'sent');
  await assert.rejects(credit.voidClaim(db, c2.id), /is sent/);
  // the airdrop list: every pending claim, with the ids it covers
  const b = await user(undefined, 1);
  await credit.burn(db, b.id, await nftsOf(b, 1));
  const c3 = await credit.claim(db, b.id, { wallet: wallet() });
  const ad = await credit.airdrop(db);
  assert.ok(ad.airdrop_ids.includes(c3.id) && !ad.airdrop_ids.includes(c2.id) && !ad.airdrop_ids.includes(c1.id));
  // the claim form: a retry of a claim that went through answers with it, even with a pass that ran out
  const k = await user(undefined, 1);
  await credit.burn(db, k.id, await nftsOf(k, 1));
  const ck = await chat(k);
  const pass = creditToken(k.id, Date.now() - 60_000);
  const w = wallet();
  let r = await ck.raw('claim_form_submit', { wallet: w, request_key: 'retry-key-0001', expected: 10_000, form_token: pass });
  assert.equal(r.structuredContent.claimed.amount, 10_000);
  r = await ck.raw('claim_form_submit', { wallet: w, request_key: 'retry-key-0001', expected: 10_000, form_token: 'expired' });
  assert.equal(r.structuredContent.claimed.repeated, true);
  r = await ck.raw('claim_form_submit', { wallet: w, request_key: 'retry-key-0002', form_token: 'expired' });
  assert.ok(r.structuredContent.refused, 'a new claim still needs the pass');
  // burning closed while MCP is minting: the form says so before anyone presses anything
  await db.query("update collections set trade_after_sold_out = true where slug = 'mcp'");
  try {
    const shown = await ck.raw('burn_form');
    assert.equal(shown.structuredContent.state.burn_open, false);
    assert.match(shown.structuredContent.state.burn_closed, /whole MCP collection is minted/);
    assert.match(ck.txt(shown), /burning is closed/);
  } finally {
    await db.query("update collections set trade_after_sold_out = false where slug = 'mcp'");
  }
  // one address per card
  const bb = await credit.burn(db, k.id, await nftsOf(k, 1));
  for (const p of [`/burn/0${bb.id}.png`, `/burn/${bb.id}.png?x=1`]) {
    const res = await fetch(base + p, { redirect: 'manual' });
    assert.equal(res.status, 301, p);
    assert.equal(res.headers.get('location'), `/burn/${bb.id}.png`);
  }
  assert.equal((await fetch(`${base}/burn/${bb.id}.png`, { redirect: 'manual' })).status, 200);
  // a finished free drop can't be edited
  const [done] = await db.query("select id from credit_drop_claims where stage = 'done' limit 1");
  if (done) await assert.rejects(db.query('update credit_drop_claims set amount = 1 where id = $1', [done.id]), /is done/);
});

// a signed-in browser on the site (test sign-in), cookies kept by hand
async function browserAs(handle) {
  const jar = new Map();
  const keep = (r) => {
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (v) jar.set(k, v); else jar.delete(k);
    }
    return r;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const raw = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: cookie(), ...(opts.headers || {}) } }).then(keep);
  const start = await raw('/login/site?return=%2Fadmin');
  const id = new URL(start.headers.get('location'), base).searchParams.get('req');
  await raw('/login/dev', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${id}&handle=${handle}` });
  const call = async (method, p, body) => {
    const r = await raw('/api' + p, { method, headers: { 'content-type': 'application/json', 'X-MCP-Site': '1', origin: 'http://localhost' }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
