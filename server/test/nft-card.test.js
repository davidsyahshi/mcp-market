// The NFT card (an MCP App, server/ui/nfts.html): /showmynfts shows the account's NFTs as pictures, and a mint, a free
// mint and the nft tool show one NFT big. The card gets its data from structuredContent.nfts and the pictures from the
// result's _meta; apps without MCP Apps still get the text and the picture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TEST_MODE = '1';
const { openDb } = await import('../src/db.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { nftsUi, withdrawUi } = await import('../src/ui.js');
const { COMMANDS } = await import('../src/commands.js');
const m = await import('../src/market.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let db, c, userId, thumbs;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  const { findRoot } = await import('../src/paths.js');
  await m.seedCollection(db, path.join(findRoot(), 'collection', 'collection.json'));
  // a few pictures on disk, like the bundled thumbnails
  thumbs = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  for (let i = 1; i <= 5000; i++) fs.writeFileSync(path.join(thumbs, `${i}.png`), png);
  [{ id: userId }] = await db.query("insert into users (x_id, handle, public_id) values ('dev:card', 'card', $1) returning id", [m.newPublicId()]);
  const server = buildMcpServer(db, userId, { publicUrl: 'https://mcp.example', thumbsDir: thumbs, deposits: { enabled: false }, ui: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
});
after(async () => { await db?.close(); fs.rmSync(thumbs, { recursive: true, force: true }); });

test('the card page: SDK inlined, its own versioned URI, readable as an MCP App with the site allowed for pictures', async () => {
  const ui = nftsUi();
  assert.match(ui.uri, /^ui:\/\/mcp-market\/nfts-[0-9a-f]{12}\.html$/);
  assert.ok(!ui.html.includes('/*MCP_APPS_SDK*/'));
  assert.match(ui.html, /const McpApps=/);
  assert.notEqual(ui.uri, withdrawUi().uri);
  const r = await c.readResource({ uri: ui.uri });
  assert.equal(r.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(r.contents[0]._meta.ui.csp.resourceDomains, ['https://mcp.example']);
  // an older chat asks for an older version: it gets the current card
  const old = await c.readResource({ uri: 'ui://mcp-market/nfts-000000000000.html' });
  assert.equal(old.contents[0].text, ui.html);
  const tools = (await c.listTools()).tools;
  for (const name of ['show_my_nfts', 'mint', 'redeem_code', 'nft']) {
    assert.equal(tools.find((t) => t.name === name)._meta.ui.resourceUri, ui.uri, name);
  }
});

test('/showmynfts: the account\'s NFTs as pictures, nothing to show when there are none', async () => {
  assert.equal(COMMANDS.find((x) => x.name === 'showmynfts').tool, 'show_my_nfts');
  const empty = await c.callTool({ name: 'show_my_nfts', arguments: {} });
  assert.equal(empty.structuredContent.nfts.view, 'many');
  assert.deepEqual(empty.structuredContent.nfts.items, []);
  assert.match(empty.content[0].text, /^0 NFTs of mcp_/);

  await m.teamMint(db, userId, 70);
  const r = await c.callTool({ name: 'show_my_nfts', arguments: {} });
  const d = r.structuredContent.nfts;
  assert.equal(d.v, 1);
  assert.equal(d.total, 70);
  assert.equal(d.items.length, 60, 'at most 60 on the card');
  assert.match(d.more_url, /^https:\/\/mcp\.example\/a\/mcp_/);
  const it = d.items[0];
  assert.match(it.url, /^https:\/\/mcp\.example\/nft\/\d+$/);
  assert.match(it.image_url, /^https:\/\/mcp\.example\/thumb\/\d+\.png$/);
  assert.ok(it.traits.length > 5);
  // every picture comes with the result, for the card only (not in the text the AI reads)
  const pics = r._meta['mcp-market/images'];
  assert.equal(Object.keys(pics).length, 60);
  assert.match(pics[String(it.id)], /^data:image\/png;base64,/);
  assert.ok(!r.content.some((x) => x.type === 'text' && x.text.includes('base64')));
  assert.match(r.content[0].text, /^70 NFTs of mcp_.*\n.*MCP #\d+/);
  assert.match(r.content[0].text, /…and 10 more/);
});

test('mint, free mint and nft: one NFT big, the text and picture as before', async () => {
  await m.credit(db, userId, 10e6, 'deposit', 'seed card');
  const mint = await c.callTool({ name: 'mint', arguments: {} });
  assert.match(mint.content[0].text, /^Minted MCP #\d+/);
  assert.equal(mint.content[1].type, 'image');
  const one = mint.structuredContent.nfts;
  assert.equal(one.view, 'one');
  assert.equal(one.title, 'Minted');
  assert.equal(one.items.length, 1);
  assert.ok(one.items[0].traits.some((t) => t.percent != null), 'with how rare each trait is');

  await m.createPromo(db, { code: 'CARD', uses: 5 });
  const free = await c.callTool({ name: 'redeem_code', arguments: { code: 'with code card' } });
  assert.equal(free.isError, undefined, JSON.stringify(free.content));
  assert.equal(free.structuredContent.nfts.title, 'Free mint');
  assert.match(free.structuredContent.nfts.subtitle, /Code CARD · 4 of 5 left/);

  const id = one.items[0].id;
  const nft = await c.callTool({ name: 'nft', arguments: { nft_id: id } });
  assert.equal(nft.structuredContent.nfts.items[0].id, id);
  assert.match(nft.structuredContent.nfts.subtitle, /^owned by mcp_/);

  // a code with tasks: the card lists them first, and after the mint offers reply / quote on X
  await m.createPromo(db, { code: 'SOCIAL', uses: 5, follow_url: 'https://x.com/mcpmarkets', tweet_url: 'https://x.com/mcpmarkets/status/2116226786858328452' });
  const ask = await c.callTool({ name: 'redeem_code', arguments: { code: 'SOCIAL' } });
  assert.equal(ask.structuredContent.nfts.view, 'tasks');
  assert.deepEqual(ask.structuredContent.nfts.tasks.map((t) => t.kind), ['follow', 'like_rt']);
  assert.match(ask.content[1].text, /^Note for the assistant/);
  await db.query("update promo_tasks_shown set shown_at = now() - interval '1 minute'");
  const got = await c.callTool({ name: 'redeem_code', arguments: { code: 'SOCIAL', proof: 'liked, reposted, following' } });
  const share = got.structuredContent.nfts.share;
  assert.deepEqual(share.map((x) => x.label), ['Reply on X', 'Quote on X']);
  assert.match(share[0].url, /^https:\/\/x\.com\/intent\/post\?in_reply_to=2116226786858328452&text=Just%20minted%20MCP%20%23\d+/);
  assert.match(share[1].url, /&url=https%3A%2F%2Fx\.com%2Fmcpmarkets%2Fstatus%2F2116226786858328452$/);

  // a refusal is plain text: the card shows it as a message
  const bad = await c.callTool({ name: 'redeem_code', arguments: { code: 'CARD' } });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent, undefined);
});
