// Sending NFTs to other MCP addresses (send_nft, /sendnft): one, several to one address, or each to its own, in one
// transaction. Two steps: a preview that moves nothing and returns a one-time code, then the send with that code.
// No money moves; the explorer and the NFT's history show a "transfer".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open'; // MCP NFTs trade (and can be sent) long before 5,000 are minted here
process.env.SEND_PER_HOUR = '8'; // small, so the hourly limit is easy to reach
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { entryHash, GENESIS } = await import('../src/explorer.js');
const { buildMcpServer, transferToken } = await import('../src/mcp.js');
const { COMMANDS, usage, promptText } = await import('../src/commands.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const m = await import('../src/market.js');

let db, app, server, base, explorer;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app, explorer } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

// someone in their AI chat: the MCP tools, signed in as this account
const chats = new Map();
async function chat(handle) {
  if (chats.has(handle)) return chats.get(handle);
  const [u] = await db.query(`insert into users (x_id, handle, public_id) values ($1, $2, $3)
    on conflict (x_id) do update set handle = excluded.handle returning id, public_id`, [`dev:${handle}`, handle, m.newPublicId()]);
  const srv = buildMcpServer(db, u.id, { publicUrl: 'https://mcp.example', thumbsDir: '/nonexistent', deposits: { enabled: false }, ui: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') };
  };
  // the two steps of the chat: preview, then (after the user's yes) send with the code the preview gave. The user takes
  // a while to answer: the preview is made 15 seconds older (a send right after it is refused, see below).
  const userReads = () => db.query("update nft_send_previews set created_at = created_at - interval '15 seconds' where user_id = $1", [u.id]);
  const preview = async (transfers) => {
    const r = await call('send_nft', { transfers });
    await userReads();
    return r;
  };
  const codeOf = (r) => /confirm "([^"]+)"/.exec(r.text)?.[1];
  const send = async (transfers) => {
    const p = await preview(transfers);
    if (p.error) return p;
    return call('send_nft', { transfers, confirm: codeOf(p) });
  };
  const one = { id: u.id, addr: u.public_id, client: c, call, preview, codeOf, send, userReads };
  chats.set(handle, one);
  return one;
}

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const ownerOf = async (id) => (await db.query('select owner_id from nfts where id = $1', [id]))[0].owner_id;
const owned = async (userId) => (await db.query('select id from nfts where owner_id = $1 order by id', [userId])).map((r) => Number(r.id));
const give = async (who, n) => (await m.teamMint(db, who.id, n)).minted.map((x) => x.id).sort((a, b) => a - b);
const ledgerMatches = async () => {
  const bad = await db.query(`select u.handle from users u left join (select user_id, sum(delta) s from ledger group by user_id) l on l.user_id = u.id
    where u.balance <> coalesce(l.s, 0)`);
  assert.deepEqual(bad, []);
};

test('send one NFT: the preview moves nothing, the send with its code does; no money moves, a listing comes off', async () => {
  const a = await chat('alice');
  const b = await chat('bob');
  const [x] = await give(a, 1);
  await m.list(db, a.id, x, 12_000_000);
  const before = (await db.query('select id, balance from users order by id')).map((r) => [r.id, String(r.balance)]);

  const p = await a.preview([{ nft_id: x, to: b.addr }]);
  assert.equal(p.error, false, p.text);
  assert.match(p.text, new RegExp(`Send MCP #${x} from ${a.addr}\\?`));
  assert.match(p.text, new RegExp(`to ${b.addr}:\\n  MCP #${x}.*\\(comes off the market\\)`));
  assert.match(p.text, /can't be taken back/);
  assert.match(p.text, /Note for the assistant.*nothing was sent yet.*only after they answer yes/i);
  assert.equal(await ownerOf(x), a.id, 'a preview moves nothing');

  const r = await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: a.codeOf(p) });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, new RegExp(`Sent MCP #${x}\\.`));
  assert.match(r.text, /https:\/\/mcp\.example\/tx\/\d+/);
  assert.equal(await ownerOf(x), b.id);
  const [n] = await db.query('select price, listed_at from nfts where id = $1', [x]);
  assert.equal(n.price, null, 'off the market');
  assert.equal(n.listed_at, null);
  const after = (await db.query('select id, balance from users order by id')).map((r) => [r.id, String(r.balance)]);
  assert.deepEqual(after, before, 'no balance changed');
  const rows = await db.query('select user_id, delta, kind, ref from ledger where ref = $1 and kind in ($2, $3) order by id', [String(x), 'send', 'receive']);
  assert.deepEqual(rows.map((l) => [l.user_id, Number(l.delta), l.kind]), [[a.id, 0, 'send'], [b.id, 0, 'receive']]);

  // the code works once
  const again = await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: a.codeOf(p) });
  assert.equal(again.error, true);
  assert.match(again.text, /no confirmation: it was used already/);
  await ledgerMatches();
});

test('batch: several NFTs to one address, and each to its own address, each batch in one explorer transaction', async () => {
  const a = await chat('alice');
  const b = await chat('bob');
  const c = await chat('carol');
  const ids = await give(a, 5);
  const r1 = await a.send(ids.slice(0, 3).map((id) => ({ nft_id: id, to: b.addr })));
  assert.equal(r1.error, false, r1.text);
  assert.match(r1.text, /Sent 3 NFTs\./);
  const r2 = await a.send([{ nft_id: ids[3], to: b.addr }, { nft_id: ids[4], to: c.addr }]);
  assert.equal(r2.error, false, r2.text);
  assert.match(r2.text, new RegExp(`to ${b.addr}:\\n  MCP #${ids[3]}`));
  assert.match(r2.text, new RegExp(`to ${c.addr}:\\n  MCP #${ids[4]}`));
  for (const id of ids.slice(0, 4)) assert.equal(await ownerOf(id), b.id);
  assert.equal(await ownerOf(ids[4]), c.id);

  await explorer.seal();
  const txs = (await get('/api/explorer/txs?limit=100')).body.filter((t) => t.type === 'transfer');
  const t1 = txs.find((t) => t.transfer.count === 3);
  assert.ok(t1, 'three NFTs in one transaction');
  assert.equal(t1.transfer.from, a.addr);
  assert.deepEqual(t1.transfer.to.map((x) => x.account), [b.addr]);
  assert.equal(t1.nft.id, ids[0], 'the first NFT, with its picture');
  assert.ok(t1.entries.every((e) => e.amount === 0 && ['send', 'receive'].includes(e.kind)));
  const t2 = txs.find((t) => t.transfer.recipients === 2);
  assert.ok(t2, 'two recipients in one transaction');
  assert.deepEqual(t2.transfer.to.map((x) => x.account).sort(), [b.addr, c.addr].sort());
  // the receiving account's page lists it too
  const forC = (await get(`/api/explorer/txs?addr=${c.addr}`)).body;
  assert.ok(forC.some((t) => t.type === 'transfer' && t.id === t2.id));
  // the chain still checks out
  const chain = (await get('/api/explorer/chain')).body;
  let prev = GENESIS;
  for (const e of chain) { assert.equal(entryHash(prev, e), e.hash, `entry ${e.seq}`); prev = e.hash; }
  await ledgerMatches();
});

test('NFT page, nft tool and account: the transfer shows in the history', async () => {
  const a = await chat('dora');
  const b = await chat('eve');
  const [x] = await give(a, 1);
  assert.equal((await a.send([{ nft_id: x, to: b.addr }])).error, false);
  const page = (await get(`/api/nfts/${x}`)).body;
  assert.deepEqual(page.activity.map((v) => [v.type, v.from_addr ?? null, v.to_addr]), [['transfer', a.addr, b.addr], ['mint', null, a.addr]]);
  const info = await b.call('nft', { nft_id: x });
  assert.match(info.text, new RegExp(`Sent \\(no sale\\):\\n${a.addr} → ${b.addr}`));
  assert.match((await a.call('account')).text, new RegExp(`sent MCP #${x} to another MCP address`));
  assert.match((await b.call('account')).text, new RegExp(`received MCP #${x} from another MCP address`));
});

test('refused, and nothing moves: not yours, unknown or own address, bad address, twice in the list, too many', async () => {
  const a = await chat('frank');
  const b = await chat('gina');
  const mine = await give(a, 2);
  const [hers] = await give(b, 1);
  const cases = [
    [[{ nft_id: mine[0], to: b.addr }, { nft_id: hers, to: b.addr }], new RegExp(`You don't own MCP #${hers}\\. Nothing was sent\\.`)],
    [[{ nft_id: 999999, to: b.addr }], /You don't own NFT #999999/],
    [[{ nft_id: mine[0], to: 'mcp_zzzzzzzzzzzz' }], /There is no MCP account mcp_zzzzzzzzzzzz/],
    [[{ nft_id: mine[0], to: a.addr }], /is your own MCP address/],
    [[{ nft_id: mine[0], to: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }], /is not an MCP address/],
    [[{ nft_id: mine[0], to: 'mcp_0OIl' }], /is not an MCP address/],
    [[{ nft_id: mine[0], to: b.addr }, { nft_id: mine[0], to: b.addr }], /is in the list twice/],
  ];
  for (const [transfers, why] of cases) {
    const r = await a.preview(transfers);
    assert.equal(r.error, true, JSON.stringify(transfers));
    assert.match(r.text, why);
  }
  const tooMany = Array.from({ length: m.SEND_MAX + 1 }, (_, i) => ({ nft_id: i + 1, to: b.addr }));
  await assert.rejects(m.previewSend(db, a.id, tooMany), /at most 50/);
  assert.deepEqual(await owned(a.id), mine);
  assert.deepEqual(await owned(b.id), [hers]);
});

test('confirmation: only for the list the user saw, by its own account, not right away, within 10 minutes, the newest preview only', async () => {
  const a = await chat('hank');
  const b = await chat('ivy');
  const c = await chat('jack');
  const [x, y] = await give(a, 2);
  // a made-up code
  assert.match((await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: 'made-up' })).text, /no confirmation/);
  // right after the preview: refused (the assistant has to ask the user first), and the code still works later
  const quick = await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }] });
  const quickCode = a.codeOf(quick);
  const tooSoon = await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: quickCode });
  assert.equal(tooSoon.error, true);
  assert.match(tooSoon.text, /Too soon/);
  assert.equal(await ownerOf(x), a.id);
  // the code of another list: other NFT, other address, an extra NFT
  const p = await a.preview([{ nft_id: x, to: b.addr }]);
  const code = a.codeOf(p);
  assert.match((await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: quickCode })).text, /a newer preview replaced it/);
  for (const other of [[{ nft_id: y, to: b.addr }], [{ nft_id: x, to: c.addr }], [{ nft_id: x, to: b.addr }, { nft_id: y, to: b.addr }]]) {
    const r = await a.call('send_nft', { transfers: other, confirm: code });
    assert.match(r.text, /not the list the user confirmed/);
  }
  // someone else can't use my code (refusals above rolled back: it is still unused)
  const stolen = await c.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: code });
  assert.match(stolen.text, /no confirmation/);
  // too old
  await db.query("update nft_send_previews set created_at = now() - interval '11 minutes' where code = $1", [code]);
  assert.match((await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: code })).text, /more than 10 minutes old/);
  assert.equal(await ownerOf(x), a.id);
  // the same list in another order is the same list; listed after the preview: still sent, and taken off the market
  const p2 = await a.preview([{ nft_id: y, to: b.addr }, { nft_id: x, to: b.addr }]);
  await m.list(db, a.id, y, 3_000_000);
  const r = await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }, { nft_id: y, to: b.addr }], confirm: a.codeOf(p2) });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /taken off the market/);
  assert.deepEqual([await ownerOf(x), await ownerOf(y)], [b.id, b.id]);
  // sold or sent away after the preview: refused at the send, nothing moves
  const p3 = await b.preview([{ nft_id: x, to: c.addr }, { nft_id: y, to: c.addr }]);
  const code3 = b.codeOf(p3);
  await db.query('update nfts set owner_id = $1 where id = $2', [a.id, y]); // as if sold a moment ago
  const late = await b.call('send_nft', { transfers: [{ nft_id: x, to: c.addr }, { nft_id: y, to: c.addr }], confirm: code3 });
  assert.equal(late.error, true);
  assert.match(late.text, new RegExp(`You don't own MCP #${y}`));
  assert.equal(await ownerOf(x), b.id, 'all or nothing');
});

test('an account sends at most SEND_PER_HOUR NFTs an hour', async () => {
  const a = await chat('quinn');
  const b = await chat('rita');
  const ids = await give(a, 10);
  assert.equal(m.SEND_PER_HOUR, 8);
  const nine = await a.preview(ids.slice(0, 9).map((id) => ({ nft_id: id, to: b.addr })));
  assert.equal(nine.error, true);
  assert.match(nine.text, /at most 8 NFTs an hour; this one sent 0 in the last hour\. Send 8 or fewer now/);
  assert.equal((await a.send(ids.slice(0, 6).map((id) => ({ nft_id: id, to: b.addr })))).error, false);
  const more = await a.preview(ids.slice(6, 9).map((id) => ({ nft_id: id, to: b.addr })));
  assert.match(more.text, /this one sent 6 in the last hour\. Send 2 or fewer now/);
  assert.equal((await a.send(ids.slice(6, 8).map((id) => ({ nft_id: id, to: b.addr })))).error, false);
  assert.match((await a.preview([{ nft_id: ids[8], to: b.addr }])).text, /sent 8 in the last hour\. Try again later/);
  // the limit counts sends, not previews or refusals: still 8 sent
  const [{ n }] = await db.query("select count(*)::int as n from ledger where user_id = $1 and kind = 'send'", [a.id]);
  assert.equal(n, 8);
  await ledgerMatches();
});

test('trading rules apply: not before the sell-out of a collection that trades only after it, not from a frozen one', async () => {
  const a = await chat('kate');
  const b = await chat('leo');
  const [x] = await give(a, 1);
  await db.query("update collections set trade_after_sold_out = true where slug = 'mcp'");
  try {
    const r = await a.preview([{ nft_id: x, to: b.addr }]);
    assert.equal(r.error, true);
    assert.match(r.text, /opens when the whole collection is minted.*can't be listed, bought or sent/);
  } finally {
    await db.query("update collections set trade_after_sold_out = false where slug = 'mcp'");
  }
  // a preview made while it was open doesn't get around a freeze that came after it
  const p = await a.preview([{ nft_id: x, to: b.addr }]);
  await db.query("update collections set status = 'frozen' where slug = 'mcp'");
  try {
    const r = await a.call('send_nft', { transfers: [{ nft_id: x, to: b.addr }], confirm: a.codeOf(p) });
    assert.equal(r.error, true);
    assert.match(r.text, /frozen/);
  } finally {
    await db.query("update collections set status = 'live' where slug = 'mcp'");
  }
  assert.equal(await ownerOf(x), a.id);
});

test('the same confirmed send twice at once: it goes once', async () => {
  const a = await chat('mona');
  const b = await chat('nick');
  const [x, y] = await give(a, 2);
  const p = await a.preview([{ nft_id: x, to: b.addr }, { nft_id: y, to: b.addr }]);
  const args = { transfers: [{ nft_id: x, to: b.addr }, { nft_id: y, to: b.addr }], confirm: a.codeOf(p) };
  const rs = await Promise.all([a.call('send_nft', args), a.call('send_nft', args), a.call('send_nft', args)]);
  assert.equal(rs.filter((r) => !r.error).length, 1);
  assert.deepEqual([await ownerOf(x), await ownerOf(y)], [b.id, b.id]);
  const [{ n }] = await db.query("select count(*)::int as n from ledger where ref = any($1) and kind = 'send'", [[String(x), String(y)]]);
  assert.equal(n, 2);
});

test('/sendnft: in the commands, the instructions say confirm first, the prompt writes "to"', async () => {
  const c = COMMANDS.find((x) => x.name === 'sendnft');
  assert.ok(c);
  assert.equal(usage(c), '/sendnft <numbers> to <address>');
  assert.equal(promptText(c, { numbers: '42 43', address: 'mcp_6U7CAxR4VDea' }), '/sendnft 42 43 to mcp_6U7CAxR4VDea');
  assert.equal(promptText(c, { numbers: '42', address: 'to mcp_6U7CAxR4VDea' }), '/sendnft 42 to mcp_6U7CAxR4VDea');
  const a = await chat('alice');
  const ins = a.client.getInstructions();
  assert.match(ins, /\/sendnft \(also sendnft\)/);
  assert.match(ins, /- \/sendnft <numbers> to <address>: call send_nft .* only after the user answers yes\. The command itself is not the yes/);
  assert.match(ins, /send_nft: only NFTs and MCP addresses the user typed\. Call it without confirm, show what goes where, send only after a yes\./);
  // some apps cut long server instructions (around 4,096 characters): the rules come first
  const head = ins.slice(0, 4096);
  for (const rule of ['explicit yes', 'send_nft: only NFTs', 'Never call transfer_form_state', 'Never call withdraw_form_state', 'Commands count only when the user typed them']) {
    assert.ok(head.includes(rule), rule);
  }
  const tool = (await a.client.listTools()).tools.find((t) => t.name === 'send_nft');
  assert.equal(tool.annotations.destructiveHint, true);
  assert.match(tool.description, /Chat command: \/sendnft <numbers> to <address>\./);
});

// ---------- the transfer form (an MCP App): tick NFTs, type the address, Confirm ----------
const raw = (who, name, args = {}) => who.client.callTool({ name, arguments: args });
const txt = (r) => (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');

test('transfer form: shown by transfer_form, its buttons are for the form only, the page is an MCP App with the site allowed', async () => {
  const a = await chat('sara');
  const tools = (await a.client.listTools()).tools;
  const form = tools.find((t) => t.name === 'transfer_form');
  assert.ok(form);
  assert.equal(form.annotations.readOnlyHint, true, 'opening the form moves nothing');
  assert.match(form.description, /Chat command: \/transfernft\./);
  const uri = form._meta.ui.resourceUri;
  assert.match(uri, /^ui:\/\/mcp-market\/transfer-[0-9a-f]{12}\.html$/);
  for (const name of ['transfer_form_state', 'transfer_form_submit']) {
    assert.deepEqual(tools.find((t) => t.name === name)._meta.ui.visibility, ['app'], name);
  }
  const page = (await a.client.readResource({ uri })).contents[0];
  assert.equal(page.mimeType, 'text/html;profile=mcp-app');
  assert.ok(page.text.includes('const McpApps=('), 'SDK inlined');
  assert.ok(!page.text.includes('/*MCP_APPS_SDK*/'));
  assert.deepEqual(page._meta.ui.csp.resourceDomains, ['https://mcp.example']);
  assert.match(a.client.getInstructions(), /Never call transfer_form_state or transfer_form_submit: they are the transfer form's buttons/);
});

test('transfer form: the state lists my NFTs (paged), the pass comes in _meta and from the form\'s own refresh, never to the assistant', async () => {
  const a = await chat('tom');
  const ids = await give(a, 125);
  await m.list(db, a.id, ids[0], 7_000_000);
  const r = await raw(a, 'transfer_form');
  const s = r.structuredContent.state;
  assert.equal(s.address, a.addr);
  assert.equal(s.total, 125);
  assert.equal(s.nfts.length, 120, 'first page');
  assert.deepEqual(s.nfts.slice(0, 3).map((n) => n.id), ids.slice(0, 3));
  assert.equal(s.nfts[0].listed, 7);
  assert.equal(s.nfts[0].image_url, `https://mcp.example/thumb/${ids[0]}.png`);
  assert.equal(s.prefill, undefined, 'the assistant can not pre-fill the address');
  assert.equal(s.max, 50);
  assert.match(r._meta['mcp-market/transfer-token'], /^\d{13}\.[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(r.structuredContent).includes(r._meta['mcp-market/transfer-token'].split('.')[1]), 'no pass in what the assistant may see');
  assert.match(txt(r), /Nothing is sent until the user ticks NFTs/);
  const p2 = await raw(a, 'transfer_form_state', { offset: 120 });
  assert.deepEqual(p2.structuredContent.state.nfts.map((n) => n.id), ids.slice(120));
  assert.match(p2.structuredContent.form_token, /^\d{13}\.[0-9a-f]{64}$/, 'for apps that drop _meta');
  assert.equal(p2._meta['mcp-market/transfer-token'], p2.structuredContent.form_token);
  // after a lost answer the form asks who owns its NFTs now
  const own = await raw(a, 'transfer_form_state', { check: [ids[0], ids[1]] });
  assert.deepEqual(own.structuredContent.owners, { [ids[0]]: a.addr, [ids[1]]: a.addr });
});

test('transfer form: Confirm sends the ticked NFTs with the pass; without one, with another\'s or an expired one, nothing moves', async () => {
  const a = await chat('uma');
  const b = await chat('vic');
  const [x, y, z] = await give(a, 3);
  await m.list(db, a.id, y, 2_000_000);
  // a pass works 5 seconds after it was issued: a brand new one is refused with "try again"
  const fresh = (await raw(a, 'transfer_form_state')).structuredContent.form_token;
  const young = await raw(a, 'transfer_form_submit', { nft_ids: [x], to: b.addr, form_token: fresh });
  assert.equal(young.structuredContent.refused, true);
  assert.equal(young.structuredContent.retry_ms, 5000);
  assert.match(txt(young), /Too soon/);
  const token = transferToken(a.id, Date.now() - 6000); // as if the user took 6 seconds to tick and type
  const bToken = transferToken(b.id, Date.now() - 6000);
  const tries = [
    [undefined, /Only the transfer form can do this/],
    ['garbage', /Only the transfer form can do this/],
    [bToken, /expired/], // well-formed but not this account's
    [`${Date.now() - 1000}.${'a'.repeat(64)}`, /expired/],
  ];
  for (const [t, why] of tries) {
    const r = await raw(a, 'transfer_form_submit', { nft_ids: [x], to: b.addr, form_token: t ?? '' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent?.refused, true);
    assert.match(txt(r), why);
  }
  assert.equal(await ownerOf(x), a.id);
  // not mine in the list: refused, nothing moves
  const [hers] = await give(b, 1);
  const mixed = await raw(a, 'transfer_form_submit', { nft_ids: [x, hers], to: b.addr, form_token: token });
  assert.equal(mixed.structuredContent?.refused, true);
  assert.match(txt(mixed), /You don't own/);
  assert.equal(await ownerOf(x), a.id);
  // the real thing
  const r = await raw(a, 'transfer_form_submit', { nft_ids: [y, x], to: b.addr, form_token: token });
  assert.equal(r.isError, undefined, txt(r));
  const sent = r.structuredContent.sent;
  assert.equal(sent.count, 2);
  assert.equal(sent.to, b.addr);
  assert.match(sent.explorer, /^https:\/\/mcp\.example\/tx\/\d+$/);
  assert.deepEqual(sent.nfts.map((n) => n.id), [x, y]);
  assert.deepEqual([await ownerOf(x), await ownerOf(y), await ownerOf(z)], [b.id, b.id, a.id]);
  assert.equal((await db.query('select price from nfts where id = $1', [y]))[0].price, null, 'off the market');
  assert.deepEqual(r.structuredContent.state.nfts.map((n) => n.id), [z], 'the form shows what is left');
  assert.equal(r.structuredContent.state.left_this_hour, 6);
  // the same limits as /sendnft: 8 an hour here
  const more = await give(a, 7);
  const over = await raw(a, 'transfer_form_submit', { nft_ids: more, to: b.addr, form_token: token });
  assert.match(txt(over), /at most 8 NFTs an hour; this one sent 2/);
  await ledgerMatches();
});

test('/transfernft opens the transfer form', () => {
  const c = COMMANDS.find((x) => x.name === 'transfernft');
  assert.ok(c);
  assert.equal(c.tool, 'transfer_form');
  assert.equal(usage(c), '/transfernft');
});
