// End-to-end suite: real HTTP, real OAuth flow, real MCP client, two users trading.
// Runs against any `setup()` that returns { base, db, close }: a plain Express server or the Lambda handler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deriveAddress, associatedTokenAddress } from '../src/solana.js';
import { webhookSecretFor } from '../src/deposits.js';
import { TEST_SEED, TEST_POOL_KEY, DEV_USDC, FAKE_USDT, randomAddress } from './fakechain.js';

const D = (dollars) => Math.round(dollars * 1e6); // dollars to micro-dollars, as stored

export function runSuite(setup) {
  let base, db, close, chain, cron;

  before(async () => { ({ base, db, close, chain, cron } = await setup()); });
  after(async () => { await close?.(); });

  const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

  // what the AI app does when the user adds the connector: register, open /authorize in the browser,
  // the user signs in on our page (dev sign-in in place of X), the app swaps the code for a token
  async function startLogin(redirect = 'http://localhost:9999/callback') {
    const reg = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test AI', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    }).then((r) => r.json());
    assert.ok(reg.client_id, 'client registered: ' + JSON.stringify(reg));
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const auth = new URL(`${base}/authorize`);
    Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })
      .forEach(([k, v]) => auth.searchParams.set(k, v));
    const r1 = await fetch(auth, { redirect: 'manual' });
    assert.equal(r1.status, 302, await r1.text());
    const loginUrl = new URL(r1.headers.get('location'), base);
    assert.equal(loginUrl.pathname, '/login');
    return { reg, verifier, redirect, loginUrl, cookie: cookieOf(r1), req: loginUrl.searchParams.get('req') };
  }

  async function connect(handle) {
    const s = await startLogin();
    const page = await fetch(s.loginUrl, { headers: { cookie: s.cookie } }).then((r) => r.text());
    assert.match(page, /Test sign-in/);
    const r2 = await fetch(`${base}/login/dev`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: s.cookie },
      body: new URLSearchParams({ req: s.req, handle }),
    });
    assert.equal(r2.status, 302, await r2.text());
    const back = new URL(r2.headers.get('location'));
    assert.equal(back.searchParams.get('state'), 'xyz');
    const tok = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: s.verifier, client_id: s.reg.client_id, redirect_uri: s.redirect }),
    }).then((r) => r.json());
    assert.ok(tok.access_token, 'got access token: ' + JSON.stringify(tok));
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
    return { client, tok, reg: s.reg };
  }

  const call = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), images: r.content.filter((x) => x.type === 'image'), isError: !!r.isError, sc: r.structuredContent, meta: r._meta };
  };
  const balanceOf = async (handle) => Number((await db.query('select balance from users where handle = $1', [handle]))[0].balance);
  const ledgerMatchesBalances = async () => {
    const bad = await db.query(`select u.handle from users u left join (select user_id, sum(delta) s from ledger group by user_id) l on l.user_id = u.id
      where u.balance <> coalesce(l.s, 0)`);
    assert.deepEqual(bad, []);
  };

  test('discovery: unauthenticated MCP calls get 401 pointing at our OAuth metadata', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((x) => x.json());
    assert.ok(meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint);
    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((x) => x.json());
    assert.match(prm.resource, /\/mcp$/);
  });

  test('sign-in links only work in the browser that started them', async () => {
    const s = await startLogin();
    assert.ok(s.cookie.startsWith('mcp_login_'), 'authorize marks the browser');
    // someone else opens the link (no cookie): refused
    const stolen = await fetch(s.loginUrl);
    assert.equal(stolen.status, 403);
    const post = await fetch(`${base}/login/dev`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ req: s.req, handle: 'victim' }),
    });
    assert.equal(post.status, 403);
    // the right browser: allowed
    assert.equal((await fetch(s.loginUrl, { headers: { cookie: s.cookie } })).status, 200);
  });

  test('sign-in page warns when access goes somewhere other than Claude, ChatGPT or Grok', async () => {
    const warned = async (cb) => {
      const s = await startLogin(cb);
      return /not Claude, ChatGPT or Grok/.test(await fetch(s.loginUrl, { headers: { cookie: s.cookie } }).then((r) => r.text()));
    };
    const s = await startLogin('https://evil.example/cb');
    const page = await fetch(s.loginUrl, { headers: { cookie: s.cookie } }).then((r) => r.text());
    assert.match(page, /evil\.example/);
    assert.match(page, /not Claude, ChatGPT or Grok/);
    assert.equal(await warned('https://grok.com/connectors/oauth/callback'), false);
    // the rule itself, without registering more clients (the SDK allows 20 registrations an hour)
    const { knownApp } = await import('../src/auth.js');
    for (const h of ['claude.ai', 'chatgpt.com', 'grok.com', 'api.x.ai', 'x.ai']) assert.equal(knownApp(h), true, h);
    for (const h of ['evil.example', 'grok.com.evil.example', 'notgrok.com', 'x.ai.evil.example', 'fakeclaude.ai']) assert.equal(knownApp(h), false, h);
  });

  test('full market flow between two users', async () => {
    const { client: alice, tok } = await connect('alice');
    const { client: bob } = await connect('bob');

    // tokens are stored hashed
    const plain = await db.query('select 1 from oauth_tokens where token = $1 or token = $2', [tok.access_token, tok.refresh_token]);
    assert.equal(plain.length, 0, 'no plain-text tokens in the database');

    const tools = (await alice.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['account', 'buy', 'cancel_listing', 'collections', 'deposit', 'faucet', 'help', 'holders_chat', 'market', 'mcpcredit', 'mint', 'my_nfts', 'nft', 'public_profile', 'redeem_code', 'sell', 'send_nft', 'show_my_nfts', 'transfer_form', 'transfer_form_state', 'transfer_form_submit',
      'withdraw_form', 'withdraw_form_state', 'withdraw_form_bind', 'withdraw_form_submit', 'my_withdrawals'].sort());

    // no money yet
    assert.equal((await call(alice, 'mint')).isError, true);
    assert.match((await call(alice, 'faucet')).text, /Added 20 \$MCP of test money/);
    assert.equal((await call(alice, 'faucet')).isError, true, 'faucet once a day');

    const m1 = await call(alice, 'mint');
    assert.equal(m1.isError, false, m1.text);
    assert.equal(m1.images.length, 1, 'mint returns the NFT image');
    const id1 = Number(m1.text.match(/MCP #(\d+)/)[1]);
    const m2 = await call(alice, 'mint');
    const id2 = Number(m2.text.match(/MCP #(\d+)/)[1]);
    assert.notEqual(id1, id2);
    assert.equal(await balanceOf('alice'), D(10));

    // only the owner can list; prices have at most 2 decimals
    assert.equal((await call(bob, 'sell', { nft_id: id1, price: 5 })).isError, true);
    const fraction = await call(alice, 'sell', { nft_id: id1, price: 8.005 });
    assert.equal(fraction.isError, true);
    assert.match(fraction.text, /at most 2 decimals/);
    const listed = await call(alice, 'sell', { nft_id: id1, price: 8 });
    assert.match(listed.text, /listed at 8 \$MCP\. If it sells you get 7\.80 \$MCP/);
    assert.match((await call(bob, 'market')).text, new RegExp(`MCP #${id1} .* 8 \\$MCP`));

    await call(bob, 'faucet');
    // price guard: bob agreed to $7, the listing says $8
    const wrong = await call(bob, 'buy', { nft_id: id1, expected_price: 7 });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /Price changed: .* now costs 8 \$MCP/);
    const ok = await call(bob, 'buy', { nft_id: id1, expected_price: 8 });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(await balanceOf('bob'), D(12));
    assert.equal(await balanceOf('alice'), D(10) + D(8) - D(0.2), 'seller gets price minus 2.5% fee');
    assert.equal((await call(bob, 'buy', { nft_id: id1, expected_price: 8 })).isError, true, 'no longer for sale');

    // others see MCP addresses, not X handles, unless the account shows its handle
    const addrOf = async (h) => (await db.query('select public_id from users where handle = $1', [h]))[0].public_id;
    const [aliceAddr, bobAddr] = [await addrOf('alice'), await addrOf('bob')];
    assert.match(aliceAddr, /^mcp_[1-9A-HJ-NP-Za-km-z]{12}$/);
    let nft = await call(alice, 'nft', { nft_id: id1 });
    assert.match(nft.text, new RegExp(`owner ${bobAddr}`));
    assert.match(nft.text, new RegExp(`8 \\$MCP ${aliceAddr} → ${bobAddr}`));
    assert.doesNotMatch(nft.text, /@bob|@alice/);
    assert.equal(nft.images.length, 1);
    assert.match((await call(bob, 'public_profile', { show_x_handle: true })).text, /now show @bob/);
    nft = await call(alice, 'nft', { nft_id: id1 });
    assert.match(nft.text, /owner @bob\n/);
    assert.match(nft.text, new RegExp(`${aliceAddr} → @bob`));
    assert.match((await call(alice, 'account')).text, new RegExp(`MCP address: ${aliceAddr} \\(public pages show this; the X handle is hidden\\)`));

    // listing then cancel
    await call(alice, 'sell', { nft_id: id2, price: 3 });
    assert.match((await call(alice, 'cancel_listing', { nft_id: id2 })).text, /no longer for sale/);

    // withdrawals (the form's buttons): address first, bound once
    const key = () => crypto.randomBytes(16).toString('hex');
    const form_token = (await call(alice, 'withdraw_form')).meta['mcp-market/form-token'];
    const refusal = async (name, args, re) => {
      const r = await call(alice, name, { form_token, ...args });
      assert.equal(r.isError, true, r.text);
      assert.equal(r.sc?.refused, true, `${name} says nothing happened`);
      if (re) assert.match(r.text, re);
    };
    await refusal('withdraw_form_submit', { amount: 100, request_key: key() }, /Bind a withdrawal address first/);
    await refusal('withdraw_form_bind', { address: 'not-an-address-not-an-address-xx' });
    const addr = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const bound = await call(alice, 'withdraw_form_bind', { address: addr, form_token });
    assert.equal(bound.isError, false, bound.text);
    assert.equal(bound.sc.state.address, addr, 'the form gets the new state back');
    await refusal('withdraw_form_bind', { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }, /already bound/);
    await refusal('withdraw_form_submit', { amount: 1, request_key: key() }, /Minimum withdrawal is 5 \$MCP/);
    await refusal('withdraw_form_submit', { amount: 999.99, request_key: key() }, /Not enough \$MCP/);
    assert.equal((await call(alice, 'withdraw_form_submit', { amount: 5, request_key: 'short', form_token })).isError, true, 'request key required');
    assert.equal(await balanceOf('alice'), D(17.8), 'refused requests take nothing');

    // mint limit
    for (let i = 0; i < 3; i++) await call(alice, 'mint');
    const over = await call(alice, 'mint');
    assert.equal(over.isError, true);
    assert.match(over.text, /limit/i);

    // every balance equals the sum of its ledger rows
    await ledgerMatchesBalances();

    const acct = await call(alice, 'account');
    assert.match(acct.text, /@alice/);
    assert.match(acct.text, /Balance: 2\.80 \$MCP/);
    assert.match(acct.text, /-5 \$MCP mint MCP #/);
  });

  test('refresh token rotates and the old one stops working', async () => {
    const { tok, reg } = await connect('refresher');
    const refresh = (t) => fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t, client_id: reg.client_id }),
    });
    const r1 = await refresh(tok.refresh_token);
    assert.equal(r1.status, 200);
    const t2 = await r1.json();
    assert.ok(t2.access_token && t2.refresh_token);
    assert.equal((await refresh(tok.refresh_token)).status, 400, 'old refresh token is single-use');
  });

  test('concurrent buys of one NFT: exactly one wins', async () => {
    const { client: seller } = await connect('seller');
    await call(seller, 'faucet');
    const id = Number((await call(seller, 'mint')).text.match(/MCP #(\d+)/)[1]);
    await call(seller, 'sell', { nft_id: id, price: 10 });
    const buyers = await Promise.all(['c1', 'c2', 'c3'].map(connect));
    await Promise.all(buyers.map((b) => call(b.client, 'faucet')));
    const results = await Promise.all(buyers.map((b) => call(b.client, 'buy', { nft_id: id, expected_price: 10 })));
    assert.equal(results.filter((r) => !r.isError).length, 1);
    const total = (await Promise.all(['c1', 'c2', 'c3'].map(balanceOf))).reduce((a, b) => a + b, 0);
    assert.equal(total, D(3 * 20 - 10));
  });

  test('manual credit needs the admin token and credits once per reference', async () => {
    const post = (body, token) => fetch(`${base}/admin/deposit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post({ handle: 'bob', amount: 5, tx: 'sig1' })).status, 401);
    assert.equal((await post({ handle: 'bob', amount: 5, tx: 'sig1' }, 'wrong-secret')).status, 401);
    assert.equal((await post({ handle: 'bob', amount: -5, tx: 'sig1' }, 'admin-secret')).status, 400);
    const before = await balanceOf('bob');
    assert.deepEqual(await (await post({ handle: 'bob', amount: 5, tx: 'sig1' }, 'admin-secret')).json(), { duplicate: false });
    assert.deepEqual(await (await post({ handle: 'bob', amount: 5, tx: 'sig1' }, 'admin-secret')).json(), { duplicate: true });
    assert.equal(await balanceOf('bob'), before + D(5));
  });

  test('withdrawal form: the AI can only open it, the buttons are tools only the form can call', async () => {
    const { client } = await connect('formy');
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    const uri = by.withdraw_form._meta.ui.resourceUri;
    assert.match(uri, /^ui:\/\/mcp-market\/withdraw-[0-9a-f]{12}\.html$/);
    assert.equal(by.withdraw_form._meta['ui/resourceUri'], uri, 'legacy key for older hosts');
    assert.equal(by.withdraw_form._meta.ui.visibility, undefined, 'the AI sees withdraw_form');
    assert.equal(by.withdraw_form.annotations.readOnlyHint, true);
    for (const n of ['withdraw_form_state', 'withdraw_form_bind', 'withdraw_form_submit']) {
      assert.deepEqual(by[n]._meta.ui.visibility, ['app'], `${n} is for the form only`);
      assert.equal(by[n]._meta.ui.resourceUri, uri);
    }
    // what an MCP Apps host lists for the model: nothing that binds or moves money
    const forModel = tools.filter((t) => (t._meta?.ui?.visibility || ['model', 'app']).includes('model')).map((t) => t.name);
    assert.ok(forModel.includes('withdraw_form') && forModel.includes('my_withdrawals'));
    for (const n of forModel) assert.doesNotMatch(n, /bind|submit|^withdraw$|set_withdraw/);

    const res = await client.readResource({ uri });
    const page = res.contents[0];
    assert.equal(page.mimeType, 'text/html;profile=mcp-app');
    assert.match(page.text, /const McpApps=\(\(\)=>\{\n[\s\S]*\nreturn \{[^}]*App:\w+[^}]*\};\n\}\)\(\);/, 'SDK inlined in its own scope');
    assert.doesNotMatch(page.text, /MCP_APPS_SDK/);
    assert.doesNotMatch(page.text, /<script[^>]+src=/i, 'loads no outside scripts');
    assert.deepEqual(page._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.equal(page._meta.ui.prefersBorder, true);
    assert.ok((await client.listResources()).resources.some((r) => r.uri === uri));

    assert.equal(by.withdraw_form.inputSchema.properties.address, undefined, 'the AI can not pre-fill an address');
    const old = await client.readResource({ uri: 'ui://mcp-market/withdraw-000000000000.html' });
    assert.equal(old.contents[0].text, page.text, 'a chat opened before a deploy still gets the form');
    const r = await call(client, 'withdraw_form', { amount: 5 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.sc.state.v, 1);
    assert.deepEqual(r.sc.state.prefill, { amount: 5 });
    assert.equal(r.sc.state.address, null);
    assert.equal(r.sc.state.fee, 0.5);
    assert.equal(r.sc.state.min, 5);
    assert.match(r.text, /Nothing is sent or bound until the user presses the button in the form/);
    const [u] = await db.query("select withdraw_address from users where handle = 'formy'");
    assert.equal(u.withdraw_address, null);
  });

  test('withdrawals through the chat: paid on chain, big ones wait, rejected ones come back', async () => {
    const { client: wendy } = await connect('wendy');
    const fund = await fetch(`${base}/admin/deposit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ handle: 'wendy', amount: 400, tx: 'fund-wendy' }),
    });
    assert.equal(fund.status, 200);
    const [w] = await db.query("select id from users where handle = 'wendy'");
    const tokenAccount = chain.fund(randomAddress(), DEV_USDC, 1);
    const form = await call(wendy, 'withdraw_form', { amount: 50 });
    assert.equal(form.sc.state.address, null);
    assert.match(form.text, /No withdrawal address yet/);
    const form_token = form.meta['mcp-market/form-token'];
    assert.match(form_token, /^\d{13}\.[0-9a-f]{64}$/, 'the form gets its pass in _meta');
    assert.doesNotMatch(JSON.stringify(form.sc) + form.text, /[0-9a-f]{64}/, 'and the pass is not in what the AI reads');
    assert.match((await call(wendy, 'withdraw_form_bind', { address: tokenAccount, form_token })).text, /token account, not a wallet/);
    const addr = randomAddress();

    // without the form's pass (an assistant calling the buttons itself in an app that ignores visibility): refused
    for (const t of [undefined, '', '1234567890123.' + 'ab'.repeat(32), `${Date.now() - 1000}.${'0'.repeat(64)}`]) {
      const r = await call(wendy, 'withdraw_form_bind', { address: addr, ...(t === undefined ? {} : { form_token: t }) });
      assert.equal(r.isError, true, String(t));
    }
    const other = (await call((await connect('mallory')).client, 'withdraw_form')).meta['mcp-market/form-token'];
    assert.match((await call(wendy, 'withdraw_form_bind', { address: addr, form_token: other })).text, /expired/, "another user's pass");
    assert.equal((await db.query('select withdraw_address from users where id = $1', [w.id]))[0].withdraw_address, null, 'nothing bound');

    assert.match((await call(wendy, 'withdraw_form_bind', { address: addr, form_token })).text, /Withdrawal address bound/);

    const k1 = crypto.randomBytes(16).toString('hex');
    const noPass = await call(wendy, 'withdraw_form_submit', { amount: 50, request_key: k1, form_token: other });
    assert.equal(noPass.sc.refused, true);
    assert.equal(await balanceOf('wendy'), D(400), 'nothing taken without the pass');
    const paid = await call(wendy, 'withdraw_form_submit', { amount: 50, request_key: k1, form_token });
    assert.equal(paid.isError, false, paid.text);
    assert.match(paid.text, new RegExp(`Sent: 50 USDC to ${addr} on Solana devnet`));
    assert.match(paid.text, /https:\/\/solscan\.io\/tx\/\w+\?cluster=devnet/);
    assert.match(paid.text, /Fee: 0\.50 \$MCP\. Balance: 349\.50 \$MCP/);
    assert.equal(paid.sc.withdrawal.status, 'sent');
    assert.match(paid.sc.withdrawal.explorer, /\?cluster=devnet$/);
    assert.equal(paid.sc.state.balance, 349.5);
    assert.equal(chain.tokenBalance(addr, DEV_USDC), BigInt(D(50)), 'the USDC arrived');

    // the same confirmation again (an answer lost on the way, a double click, a replay): the same withdrawal, nothing new
    const again = await Promise.all([1, 2, 3].map(() => call(wendy, 'withdraw_form_submit', { amount: 50, request_key: k1, form_token })));
    for (const r of again) assert.equal(r.sc.withdrawal.id, paid.sc.withdrawal.id);
    assert.equal(chain.tokenBalance(addr, DEV_USDC), BigInt(D(50)), 'paid once');
    assert.equal(await balanceOf('wendy'), D(349.5), 'debited once');
    assert.equal((await db.query('select count(*)::int as n from withdrawals where user_id = $1', [w.id]))[0].n, 1);

    const look = await call(wendy, 'withdraw_form_state', { request_key: k1 });
    assert.equal(look.sc.by_key.id, paid.sc.withdrawal.id, 'the form can ask what happened to its request');
    const big = await call(wendy, 'withdraw_form_submit', { amount: 150, request_key: crypto.randomBytes(16).toString('hex'), form_token });
    assert.match(big.text, /waits for a manual check/);
    assert.equal(big.sc.withdrawal.status, 'review');
    assert.equal(await balanceOf('wendy'), D(349.5 - 150.5), 'reserved while it waits');
    const list = (await call(wendy, 'my_withdrawals')).text;
    assert.match(list, /50 USDC to \w{4}…\w{4} · sent · https:\/\/solscan/);
    assert.match(list, /150 USDC to \w{4}…\w{4} · waiting for a manual check/);

    // the owner rejects it in the database; the next scheduled run gives it back
    await db.query("update withdrawals set status = 'rejected' where user_id = $1 and status = 'review'", [w.id]);
    const run = await cron();
    assert.equal(run.withdrawals.refunded, 1);
    assert.equal(await balanceOf('wendy'), D(349.5));
    assert.match((await call(wendy, 'my_withdrawals')).text, /rejected, refunded to your balance/);
    assert.equal(run.withdrawals.errors.length, 0, JSON.stringify(run.withdrawals.errors));
    const acct = (await call(wendy, 'account')).text;
    assert.match(acct, /-50 \$MCP withdraw #\d+/);
    assert.match(acct, /\+150\.50 \$MCP withdraw_refund #\d+/, "amount and fee back in one ledger row");
    await ledgerMatchesBalances();
  });

  test('deposits: personal address, webhook, on-demand check, each transaction credited once', async () => {
    const { client: dora } = await connect('dora');
    const [u] = await db.query("select id from users where handle = 'dora'");
    const deposit = () => call(dora, 'deposit');
    assert.match((await call(dora, 'account')).text, /Deposit address \(Solana\): none yet/);

    // first call hands out the next address of the pool (made offline from the phrase) and watches
    // its USDC and USDT accounts
    const first = await deposit();
    assert.equal(first.isError, false, first.text);
    const [p] = await db.query("select idx, address from deposit_pool where network = 'devnet' and user_id = $1", [u.id]);
    const wallet = p.address;
    assert.equal(wallet, deriveAddress(TEST_SEED, p.idx), 'the address is wallet #idx of the phrase');
    const usdcAta = associatedTokenAddress(wallet, DEV_USDC);
    const usdtAta = associatedTokenAddress(wallet, FAKE_USDT);
    assert.match(first.text, new RegExp(`\\n${wallet}\\n`));
    assert.match(first.text, /USDC or USDT on Solana devnet/);
    assert.match(first.text, /No deposits yet/);
    assert.match(first.text, /faucet\.circle\.com/);
    assert.match((await deposit()).text, new RegExp(`\\n${wallet}\\n`), 'same address every time');
    const watched = await db.query('select address, token from deposit_accounts where user_id = $1 order by token', [u.id]);
    assert.deepEqual(watched, [{ address: usdcAta, token: 'USDC' }, { address: usdtAta, token: 'USDT' }]);
    assert.match((await call(dora, 'account')).text, new RegExp(`Deposit address \\(Solana\\): ${wallet}`));

    // Helius calls the webhook; only with the right password
    const sig1 = chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(25.5), before: null });
    const hook = (body, auth) => fetch(`${base}/hooks/helius`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
    });
    const secret = webhookSecretFor(TEST_POOL_KEY);
    assert.equal((await hook([chain.webhookItem(sig1)])).status, 401);
    assert.equal((await hook([chain.webhookItem(sig1)], 'nope')).status, 401);
    // a forged payload is not believed: the amount comes from the chain
    const forged = chain.webhookItem(sig1);
    forged.meta.postTokenBalances[1].uiTokenAmount.amount = String(D(1_000_000));
    const r1 = await (await hook([forged], secret)).json();
    assert.equal(r1.credited, 1);
    assert.equal(await balanceOf('dora'), D(25.5));
    // replays credit nothing
    assert.equal((await (await hook([chain.webhookItem(sig1)], secret)).json()).credited, 0);
    const again = await deposit();
    assert.match(again.text, /Deposits in the last 24 hours:\n\+25\.50 \$MCP \(25\.50 USDC, tx /);
    assert.equal(await balanceOf('dora'), D(25.5));

    // no webhook at all: the deposit tool finds it (USDT, receiving account in a v0 lookup table)
    chain.transfer({ mint: FAKE_USDT, to: usdtAta, owner: wallet, amount: D(10), inLookupTable: true });
    assert.match((await deposit()).text, /New deposits:\n\+10 \$MCP \(10 USDT, tx /);
    assert.equal(await balanceOf('dora'), D(35.5));

    // not credited: dust, failed transactions, money going out, other tokens, accounts that aren't the user's
    chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: 900, before: D(25.5) });
    chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(50), before: D(25.5), err: { InstructionError: [0, 'Custom'] } });
    const fakeMint = randomAddress();
    chain.transfer({ mint: fakeMint, to: usdcAta, owner: wallet, amount: D(500) });
    chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(70), before: D(25.5), ownerInPost: randomAddress() });
    chain.addTx({
      accountKeys: [usdcAta, randomAddress()],
      pre: [{ accountIndex: 0, mint: DEV_USDC, owner: wallet, uiTokenAmount: { amount: String(D(25.5)), decimals: 6 } }],
      post: [{ accountIndex: 0, mint: DEV_USDC, owner: wallet, uiTokenAmount: { amount: String(D(5)), decimals: 6 } }],
    });
    const quiet = await deposit();
    assert.match(quiet.text, /0\.0009 USDC received, not credited: below the 0\.01 USDC minimum/);
    assert.equal(await balanceOf('dora'), D(35.5));

    // a node that can't see the transaction yet: nothing is skipped, it is credited on the next check
    const late = chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(3), before: D(5) });
    chain.hidden.add(late);
    await deposit();
    assert.equal(await balanceOf('dora'), D(35.5));
    chain.hidden.delete(late);
    assert.match((await deposit()).text, /New deposits:\n\+3 \$MCP \(3 USDC, tx /);
    assert.equal(await balanceOf('dora'), D(38.5));

    // one transaction paying two of our users (an exchange batch payout) credits both
    const { client: eve } = await connect('eve');
    await call(eve, 'deposit');
    const [e] = await db.query("select p.address from deposit_pool p join users u on u.id = p.user_id where u.handle = 'eve'");
    assert.notEqual(e.address, wallet, 'everyone gets their own address');
    const eveAta = associatedTokenAddress(e.address, DEV_USDC);
    const both = chain.batch(DEV_USDC, [{ to: eveAta, owner: e.address, amount: D(7) }, { to: usdcAta, owner: wallet, amount: D(1.25) }]);
    assert.equal((await (await hook([chain.webhookItem(both)], secret)).json()).credited, 2);
    assert.equal(await balanceOf('eve'), D(7));
    assert.equal(await balanceOf('dora'), D(39.75));

    // support can't credit by hand what the scanner already credited, even pasted as an explorer link
    const manual = await fetch(`${base}/admin/deposit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ handle: 'dora', amount: 25.5, tx: ` https://solscan.io/tx/${sig1}?cluster=devnet ` }),
    });
    assert.equal(manual.status, 409);
    assert.equal(await balanceOf('dora'), D(39.75));

    const acct = await call(dora, 'account');
    assert.match(acct.text, /\+1\.25 \$MCP deposit USDC \(tx \w{6}…\w{4}\)/);
    await ledgerMatchesBalances();
  });

  test('public preview API', async () => {
    const s = await fetch(`${base}/api/stats`).then((r) => r.json());
    assert.equal(s.supply, 5000);
    assert.equal(s.minted, 6, 'alice minted 5, seller minted 1');
    assert.equal(s.test_mode, true);
    assert.equal(s.currency, 'MCP');
    assert.equal(s.usd_per_mcp, 1);
    assert.equal(s.mint_price, 5);
    assert.deepEqual(s.deposits, { network: 'solana-devnet', tokens: ['USDC', 'USDT'] });
    const listed = await fetch(`${base}/api/nfts?status=listed&sort=price_asc`).then((r) => r.json());
    assert.ok(Array.isArray(listed));
    const one = await fetch(`${base}/api/nfts/1`).then((r) => r.json());
    assert.equal(one.name, 'MCP #1');
    assert.equal(one.collection, 'mcp');
    assert.equal(one.attributes[0].trait_type, 'Rarity');
    assert.ok(one.attributes.every((a) => a.count > 0 && a.percent > 0 && a.percent <= 100), 'every trait says how many NFTs share it');
    assert.equal((await fetch(`${base}/api/nfts/abc`)).status, 404);
    // NFT owners are shown by MCP address; a handle only when its owner chose to show it
    assert.ok(listed.every((n) => !('owner' in n) && /^mcp_/.test(n.owner_addr) && (n.owner_name === null || n.owner_name === 'bob')));
    assert.equal((await fetch(`${base}/api/users/alice`)).status, 404, 'hidden handles can not be looked up');
    const bob = await fetch(`${base}/api/users/bob`).then((r) => r.json());
    assert.match(bob.public_id, /^mcp_/);
    assert.ok(bob.nfts.length >= 1);
    const sales = await fetch(`${base}/api/sales`).then((r) => r.text());
    assert.doesNotMatch(sales, /alice/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test('database: row level security is on for every table', async () => {
    const rows = await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    assert.deepEqual(rows, []);
  });

  return { get base() { return base; } };
}
