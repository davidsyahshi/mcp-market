// Smoke test for a deployed server (test mode with DEV_LOGIN=1): goes through the same steps as Claude
// does when you add the connector, then calls a few read-only tools.
//   node server/scripts/smoke.js https://your-site.netlify.app [handle]
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] || process.env.PUBLIC_URL || '').replace(/\/$/, '');
const handle = process.argv[3] || 'smoke_test';
if (!base) { console.error('usage: node server/scripts/smoke.js <base-url> [handle]'); process.exit(2); }

// prints a step's result only when it is a short string; codes and tokens are never printed
const step = async (name, fn, { show = true } = {}) => {
  const t = Date.now();
  try {
    const out = await fn();
    const note = show && typeof out === 'string' ? '  ' + out.replace(/\s+/g, ' ').slice(0, 110) : '';
    console.log(`ok   ${name} (${Date.now() - t} ms)${note}`);
    return out;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

try {
  await step('site', async () => {
    const r = await fetch(base + '/');
    must(r.ok && (await r.text()).includes('MCP'), `status ${r.status}`);
  });
  await step('static image', async () => {
    const r = await fetch(base + '/thumb/1.png');
    must(r.ok && r.headers.get('content-type') === 'image/png', `status ${r.status} ${r.headers.get('content-type')}`);
  });
  const stats = await step('api/stats', async () => {
    const s = await fetch(base + '/api/stats').then((r) => r.json());
    must(s.supply > 0, JSON.stringify(s));
    return `supply ${s.supply}, minted ${s.minted}, mcp_url ${s.mcp_url}`;
  });
  await step('mcp without token -> 401', async () => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    must(r.status === 401 && /resource_metadata/.test(r.headers.get('www-authenticate') || ''), `status ${r.status}`);
  });
  await step('oauth metadata', async () => {
    const m = await fetch(base + '/.well-known/oauth-authorization-server').then((r) => r.json());
    must(m.issuer?.startsWith(base), `issuer ${m.issuer} != ${base}`);
    const p = await fetch(base + '/.well-known/oauth-protected-resource/mcp').then((r) => r.json());
    must(p.resource === base + '/mcp', `resource ${p.resource}`);
  });

  const redirect = 'http://localhost:9/callback';
  const reg = await step('register client', async () => {
    const r = await fetch(base + '/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Smoke test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    }).then((x) => x.json());
    must(r.client_id, JSON.stringify(r));
    return r;
  });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const { req, cookie } = await step('authorize', async () => {
    const u = new URL(base + '/authorize');
    Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { redirect: 'manual' });
    must(r.status === 302, `status ${r.status}: ${await r.text()}`);
    const loc = new URL(r.headers.get('location'), base);
    const c = (r.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ');
    must(c.startsWith('mcp_login_'), 'no login cookie');
    return { req: loc.searchParams.get('req'), cookie: c };
  });
  await step('login link refused without the cookie', async () => {
    const r = await fetch(`${base}/login?req=${req}`);
    must(r.status === 403, `status ${r.status}`);
  });
  const code = await step('dev sign-in', async () => {
    const page = await fetch(`${base}/login?req=${req}`, { headers: { cookie } }).then((r) => r.text());
    must(page.includes('Test sign-in'), 'no test sign-in on the page (is DEV_LOGIN=1?)');
    const r = await fetch(base + '/login/dev', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ req, handle }),
    });
    must(r.status === 302, `status ${r.status}`);
    return new URL(r.headers.get('location')).searchParams.get('code');
  }, { show: false });
  const tok = await step('token', async () => {
    const t = await fetch(base + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }),
    }).then((r) => r.json());
    must(t.access_token, JSON.stringify(t));
    return t;
  });

  const client = new Client({ name: 'smoke', version: '1' });
  await step('mcp connect', () => client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } })));
  await step('tools/list', async () => (await client.listTools()).tools.map((t) => t.name).join(', '));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join(' | '), images: r.content.filter((x) => x.type === 'image').length, isError: r.isError };
  };
  await step('account', async () => (await call('account')).text.split('\n')[0].slice(0, 80));
  await step('market', async () => (await call('market')).text.slice(0, 100));
  await step('nft #1 with image', async () => {
    const r = await call('nft', { nft_id: 1 });
    must(r.images === 1, 'no image in the result');
    return r.text.slice(0, 80);
  });
  await client.close();
  console.log(process.exitCode ? '\nSMOKE FAILED' : `\nall good: connector URL ${stats.split('mcp_url ')[1]}`);
} catch {
  console.log('\nSMOKE FAILED');
  process.exitCode = 1;
}
