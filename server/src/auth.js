// OAuth for the MCP connector. Claude/ChatGPT register as clients, send the user to /authorize,
// the user signs in with X on our page, and we hand the AI app a token bound to that X account.
//
// Safety notes:
// - Authorization codes and tokens are stored only as sha256 hashes.
// - A sign-in must finish in the same browser that started it at /authorize (a short-lived cookie),
//   so nobody can send you a sign-in link that connects THEIR AI app to YOUR account.
// - The sign-in page shows which app and which website will receive access.
import crypto from 'node:crypto';
import express from 'express';
import { InvalidTokenError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { upsertUser } from './market.js';

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ACCESS_TTL = 7 * 24 * 3600;
const REFRESH_TTL = 180 * 24 * 3600;
const LOGIN_TTL_MIN = 15;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const REQ_ID = /^[A-Za-z0-9_-]{16,64}$/;
// where the official AI apps send the user back after sign-in
const KNOWN_APP_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com', 'chat.openai.com', 'localhost', '127.0.0.1'];

export function createAuth(db, { publicUrl, xClientId, xClientSecret, devLogin }) {
  const secureCookie = publicUrl.startsWith('https://');
  const cookieName = (id) => `mcp_login_${id}`;
  const startedHere = (req, id) => REQ_ID.test(id || '') && (req.get('cookie') || '').split(/;\s*/).includes(`${cookieName(id)}=1`);

  const clientsStore = {
    async getClient(id) {
      const [r] = await db.query('select data from oauth_clients where client_id = $1', [id]);
      return r?.data;
    },
    async registerClient(client) {
      const full = { ...client, client_id: rand(16), client_id_issued_at: Math.floor(Date.now() / 1000) };
      await db.query('insert into oauth_clients (client_id, data) values ($1, $2)', [full.client_id, full]);
      return full;
    },
  };

  async function issueTokens(clientId, userId) {
    const access = rand(), refresh = rand();
    await db.query(`insert into oauth_tokens (token, kind, client_id, user_id, expires_at) values
      ($1, 'access', $3, $4, now() + make_interval(secs => $5)), ($2, 'refresh', $3, $4, now() + make_interval(secs => $6))`,
    [hash(access), hash(refresh), clientId, userId, ACCESS_TTL, REFRESH_TTL]);
    if (Math.random() < 0.05) sweep().catch((e) => console.error('oauth sweep', e.message));
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'market' };
  }

  // housekeeping: drop expired codes, tokens and abandoned sign-ins
  async function sweep() {
    await db.query('delete from oauth_tokens where expires_at < now()');
    await db.query('delete from oauth_codes where expires_at < now()');
    await db.query("delete from oauth_pending where created_at < now() - interval '1 day'");
  }

  const provider = {
    clientsStore,
    // step 1: remember what the AI app asked for, mark this browser, then show our sign-in page
    async authorize(client, params, res) {
      const id = rand(16);
      await db.query('insert into oauth_pending (id, client_id, params) values ($1, $2, $3)', [id, client.client_id, {
        state: params.state, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri,
        client_name: client.client_name || 'An AI app',
      }]);
      res.cookie(cookieName(id), '1', { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/login', maxAge: LOGIN_TTL_MIN * 60 * 1000 });
      res.redirect(`/login?req=${id}`);
    },
    async challengeForAuthorizationCode(client, code) {
      const [r] = await db.query('select challenge from oauth_codes where code = $1 and client_id = $2', [hash(code), client.client_id]);
      if (!r) throw new InvalidGrantError('Invalid authorization code');
      return r.challenge;
    },
    async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri) {
      const [r] = await db.query('delete from oauth_codes where code = $1 and client_id = $2 and expires_at > now() returning user_id, redirect_uri',
        [hash(code), client.client_id]);
      if (!r) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri && redirectUri !== r.redirect_uri) throw new InvalidGrantError('redirect_uri does not match');
      return issueTokens(client.client_id, r.user_id);
    },
    async exchangeRefreshToken(client, token) {
      const [r] = await db.query("delete from oauth_tokens where token = $1 and kind = 'refresh' and client_id = $2 and expires_at > now() returning user_id",
        [hash(token), client.client_id]);
      if (!r) throw new InvalidGrantError('Invalid refresh token');
      return issueTokens(client.client_id, r.user_id);
    },
    async verifyAccessToken(token) {
      const [r] = await db.query("select client_id, user_id, extract(epoch from expires_at)::bigint as exp from oauth_tokens where token = $1 and kind = 'access' and expires_at > now()",
        [hash(token)]);
      if (!r) throw new InvalidTokenError('Invalid or expired token');
      return { token, clientId: r.client_id, scopes: ['market'], expiresAt: Number(r.exp), extra: { userId: r.user_id } };
    },
    async revokeToken(client, { token }) {
      await db.query('delete from oauth_tokens where token = $1 and client_id = $2', [hash(token), client.client_id]);
    },
  };

  const expired = (res) => res.status(400).send(page('Login expired', '<p>This sign-in link expired. Go back to the chat and press Connect again.</p>'));
  const foreign = (res) => res.status(403).send(page('Start from your AI app',
    `<p>For your safety, sign-in only works in the browser where it started. Go to Claude or ChatGPT, press <b>Connect</b>
     on the MCP connector, and finish signing in there.</p><p class="dim">If someone sent you this link, close it.</p>`));

  // step 2: the user signed in; send the AI app back an authorization code
  async function finish(req, res, pendingId, user) {
    const [p] = await db.query(`delete from oauth_pending where id = $1 and created_at > now() - make_interval(mins => $2) returning client_id, params`,
      [pendingId, LOGIN_TTL_MIN]);
    if (!p) return expired(res);
    const code = rand();
    await db.query("insert into oauth_codes (code, client_id, user_id, challenge, redirect_uri, expires_at) values ($1, $2, $3, $4, $5, now() + interval '5 minutes')",
      [hash(code), p.client_id, user.id, p.params.codeChallenge, p.params.redirectUri]);
    const url = new URL(p.params.redirectUri);
    url.searchParams.set('code', code);
    if (p.params.state) url.searchParams.set('state', p.params.state);
    res.clearCookie(cookieName(pendingId), { path: '/login' });
    res.redirect(url.toString());
  }

  const router = express.Router();
  router.use('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/login', async (req, res) => {
    const id = String(req.query.req || '');
    if (!REQ_ID.test(id)) return expired(res);
    const [p] = await db.query('select params from oauth_pending where id = $1', [id]);
    if (!p) return expired(res);
    if (!startedHere(req, id)) return foreign(res);
    let host = '?';
    try { host = new URL(p.params.redirectUri).hostname; } catch {}
    const known = KNOWN_APP_HOSTS.includes(host);
    const warn = known ? '' : `<p class="warn">⚠ Access goes to <b>${esc(host)}</b>, which is not Claude or ChatGPT. Only continue if you set this up yourself.</p>`;
    const x = xClientId ? `<a class="btn" href="/login/x?req=${id}">Sign in with X</a>` : '';
    const dev = devLogin ? `<form method="post" action="/login/dev"><input type="hidden" name="req" value="${id}">
      <input name="handle" placeholder="test handle, e.g. artem" required pattern="[A-Za-z0-9_]{1,15}" maxlength="15" autocomplete="off">
      <button class="btn ghost">Test sign-in</button></form>
      <p class="dim">Test server: any handle works, balances are test money and anyone can sign in as any handle.</p>` : '';
    res.send(page('Connect MCP', `<p><b>${esc(p.params.client_name)}</b> <span class="dim">(${esc(host)})</span> wants to use your MCP account:
      see your balance and NFTs, mint, buy and sell. Withdrawals only ever go to the address you bind yourself.</p>${warn}
      <p class="dim">One X account = one MCP account. We only read your handle, name and avatar.</p>${x}${dev}`));
  });

  if (devLogin) {
    router.post('/login/dev', async (req, res) => {
      const id = String(req.body.req || '');
      if (!startedHere(req, id)) return foreign(res);
      const handle = String(req.body.handle || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
      if (!handle) return res.status(400).send(page('Error', '<p>Enter a handle.</p>'));
      const user = await upsertUser(db, { xId: `dev:${handle.toLowerCase()}`, handle });
      await finish(req, res, id, user);
    });
  }

  if (xClientId) {
    const callback = `${publicUrl}/login/x/callback`;
    router.get('/login/x', async (req, res) => {
      const id = String(req.query.req || '');
      if (!startedHere(req, id)) return foreign(res);
      const verifier = rand();
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const rows = await db.query('update oauth_pending set x_verifier = $1 where id = $2 returning id', [verifier, id]);
      if (!rows.length) return expired(res);
      const u = new URL('https://x.com/i/oauth2/authorize');
      Object.entries({ response_type: 'code', client_id: xClientId, redirect_uri: callback, scope: 'users.read tweet.read',
        state: id, code_challenge: challenge, code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
      res.redirect(u.toString());
    });
    router.get('/login/x/callback', async (req, res) => {
      const id = String(req.query.state || '');
      if (!startedHere(req, id)) return foreign(res);
      try {
        const [p] = await db.query('select x_verifier from oauth_pending where id = $1', [id]);
        if (!p?.x_verifier || !req.query.code) throw new Error('Sign-in was cancelled or expired');
        const tok = await fetch('https://api.x.com/2/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${xClientId}:${xClientSecret}`).toString('base64') },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: callback, code_verifier: p.x_verifier }),
        }).then((r) => r.json());
        if (!tok.access_token) throw new Error('X token exchange failed');
        const me = await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url,created_at,public_metrics', {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        if (!me.data) throw new Error('X profile request failed');
        // anti-farm: very new accounts can't join
        const ageDays = (Date.now() - new Date(me.data.created_at).getTime()) / 864e5;
        const minAge = Number(process.env.X_MIN_ACCOUNT_AGE_DAYS || 30);
        if (ageDays < minAge) return res.status(403).send(page('Account too new', `<p>Your X account must be at least ${minAge} days old.</p>`));
        const user = await upsertUser(db, { xId: me.data.id, handle: me.data.username, name: me.data.name, avatar: me.data.profile_image_url });
        await finish(req, res, id, user);
      } catch (e) {
        res.status(400).send(page('Sign-in failed', `<p>${esc(e.message)}. Go back to the chat and try connecting again.</p>`));
      }
    });
  }

  return { provider, router };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.png"><link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0D0D0F;color:#F5F1E8;font:16px/1.5 ui-monospace,Menlo,monospace}
main{max-width:400px;margin:16px;padding:32px 24px;background:#16161A;border:2px solid #26262C}h1{font-family:Silkscreen,monospace;font-weight:400;color:#FF2A1F;margin:0 0 16px}
.dim{color:#8A8A93;font-size:14px}.warn{border:2px solid #FFE600;padding:10px;color:#FFE600;font-size:14px}
.btn{display:block;width:100%;box-sizing:border-box;margin-top:16px;padding:12px;border:0;background:#F5F1E8;color:#0D0D0F;
font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}.btn.ghost{background:transparent;color:#F5F1E8;border:2px solid #3A3A42}
input{width:100%;box-sizing:border-box;margin-top:16px;padding:10px;background:#0D0D0F;color:#F5F1E8;border:2px solid #3A3A42;font:inherit}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
