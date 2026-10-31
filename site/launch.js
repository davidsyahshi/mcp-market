// The launchpad pages (/launch) and the owner's review page (/admin). Loaded by index.html, uses its helpers
// ($, esc, fmt, api, rarClass). Pictures are read in the browser (a folder or a .zip), thumbnails are made here
// with a canvas, and everything is uploaded in small batches.
(() => {
  const H = { 'Content-Type': 'application/json', 'X-MCP-Site': '1' };
  const send = async (method, path, body) => {
    const r = await fetch('/api' + path, { method, headers: H, body: body == null ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  };
  const me = () => fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const signIn = (back) => `/login/site?return=${encodeURIComponent(back)}`;
  const money = (micro) => fmt(Math.round(Number(micro) / 1e4) / 100);
  const STATUS = { draft: 'being prepared', review: 'in review', live: 'live', paused: 'paused', rejected: 'rejected', frozen: 'frozen, minters refunded' };
  const pill = (s) => `<span class="pill ${s === 'live' ? 'ok' : s === 'rejected' || s === 'frozen' ? 'bad' : 'wait'}">${esc(STATUS[s] || s)}</span>`;

  // ---------- reading a folder or a .zip ----------

  // a .zip read with the browser's own inflate (no library); stored and deflated entries, no zip64
  async function unzip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This is not a .zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The .zip is damaged');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = buf.subarray(start, start + csize);
      out.push({ path: name, blob: async () => {
        if (method === 0) return new Blob([raw]);
        if (method !== 8) throw new Error(`${name}: unsupported compression`);
        return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      } });
    }
    return out;
  }

  const IMG = /(?:^|\/)(\d{1,5})\.(png|jpe?g|gif|webp)$/i;
  // OpenSea-style metadata: <n>.json per NFT, or one _metadata.json / metadata.json array
  async function readCollection(entries) {
    const images = new Map();
    const metaFiles = new Map();
    let metaAll = null;
    for (const e of entries) {
      const m = IMG.exec(e.path);
      if (m) { images.set(Number(m[1]), e); continue; }
      const base = e.path.split('/').pop().toLowerCase();
      if (base === '_metadata.json' || base === 'metadata.json') metaAll = e;
      else if (/^\d{1,5}\.json$/.test(base)) metaFiles.set(Number(base.split('.')[0]), e);
    }
    if (!images.size) throw new Error('No pictures found: name them 1.png, 2.png, … (PNG, JPEG, GIF or WEBP).');
    const nums = [...images.keys()].sort((a, b) => a - b);
    // numbering may start at 0 or 1; on the market it always starts at 1
    const shift = nums[0] === 0 ? 1 : 0;
    nums.forEach((n, i) => { if (n + shift !== i + 1) throw new Error(`Pictures must be numbered without gaps: #${i + 1 - shift} is missing.`); });
    const meta = new Map();
    if (metaAll) {
      const list = JSON.parse(await (await metaAll.blob()).text());
      if (!Array.isArray(list)) throw new Error(`${metaAll.path} must be a list`);
      list.forEach((x, i) => {
        const n = Number.isInteger(x?.edition) ? x.edition : Number(/(\d+)\s*$/.exec(String(x?.name || ''))?.[1] ?? i + (nums[0]));
        meta.set(n, x);
      });
    }
    for (const [n, e] of metaFiles) if (!meta.has(n)) meta.set(n, JSON.parse(await (await e.blob()).text()));
    return nums.map((n) => {
      const x = meta.get(n) || {};
      const attributes = Array.isArray(x.attributes) ? x.attributes.filter((a) => a && a.trait_type != null && a.value != null)
        .map((a) => ({ trait_type: String(a.trait_type).slice(0, 40), value: String(a.value).slice(0, 60) })) : [];
      return { edition: n + shift, name: typeof x.name === 'string' ? x.name.slice(0, 60) : '', attributes, entry: images.get(n) };
    });
  }

  // 252 px thumbnail; small pictures are pixel art and are scaled without smoothing
  async function thumbnail(blob) {
    const bmp = await createImageBitmap(blob);
    const pixel = bmp.width <= 128 && bmp.height <= 128;
    const c = document.createElement('canvas');
    c.width = c.height = 252;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = !pixel;
    const s = Math.min(252 / bmp.width, 252 / bmp.height);
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    g.drawImage(bmp, (252 - w) / 2, (252 - h) / 2, w, h);
    bmp.close?.();
    return { thumb: await new Promise((r) => c.toBlob(r, 'image/png')), pixel };
  }
  const b64 = (blob) => new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1]);
    fr.onerror = () => no(fr.error);
    fr.readAsDataURL(blob);
  });

  // ---------- /launch ----------

  async function renderLaunch() {
    const app = $('#app');
    app.innerHTML = '<div class="wrap"><div class="note" style="padding:30px 0">Loading…</div></div>';
    const who = await me();
    const rules = `<div class="panel" style="margin:14px 0">
      <h2 class="px">How it works</h2>
      <div class="kv"><span>Who can launch</span><span>anyone signed in with X</span>
        <span>Before it goes live</span><span>the MCP team reviews it</span>
        <span>Market fee</span><span>${(window.LAUNCH_FEE_BPS || 1000) / 100}% of each mint</span>
        <span>Your share</span><span>the rest, held 7 days, then paid to your balance</span>
        <span>Trading</span><span>2.5% of each sale to the market</span></div>
      <p class="note">Mint money is held for at least 7 days after each mint and paid out after a check, so people can trust a new collection: if a collection turns out to be a scam, it is frozen and every minter whose money is still held gets their full mint price back. Upload only art you own. Stolen art, other people's characters and brands, and anything illegal are rejected.</p></div>`;
    if (!who) {
      app.innerHTML = `<div class="wrap"><div class="crumbs"><a href="/collections">Collections</a> / Launch</div>
        <div class="ex-head"><div><h1 class="px">Launch your collection</h1>
        <p>Put your NFT collection on MCP: people mint and trade it by talking to Claude or ChatGPT.</p></div></div>
        ${rules}<a class="btn red" href="${signIn('/launch')}">Sign in with X to start</a><div style="height:60px"></div></div>`;
      return;
    }
    const mine = await send('GET', '/launch/mine');
    app.innerHTML = `<div class="wrap"><div class="crumbs"><a href="/collections">Collections</a> / Launch</div>
      <div class="ex-head"><div><h1 class="px">Launch your collection</h1>
      <p>Signed in as @${esc(who.handle)} (${esc(who.public_id)}). ${who.admin ? '<a href="/admin">Review queue →</a>' : ''}</p></div></div>
      ${mine.length ? `<h2 class="px" style="font-size:18px;margin:18px 0 10px">Your collections</h2>
        <table class="txs"><thead><tr><th>Collection</th><th>Status</th><th class="hide-sm">NFTs</th><th style="text-align:right">Held</th><th style="text-align:right" class="hide-sm">Ready</th><th style="text-align:right">Paid</th><th></th></tr></thead><tbody>
        ${mine.map((c) => `<tr><td><a href="/c/${esc(c.slug)}">${esc(c.name)}</a><div class="note">${esc(c.slug)}</div></td><td>${pill(c.status)}${c.review_note ? `<div class="note">${esc(c.review_note)}</div>` : ''}</td>
          <td class="hide-sm">${c.status === 'draft' ? `${c.uploaded}/${c.supply} uploaded` : `${c.minted}/${c.supply} minted`}</td>
          <td class="num">${money(c.earnings.held)}</td><td class="num hide-sm">${money(c.earnings.releasable)}</td><td class="num">${money(c.earnings.paid)}</td>
          <td>${c.status === 'draft' ? `<button class="btn ghost" data-continue="${c.id}" style="padding:4px 8px">Continue</button>` : ''}
            ${['draft', 'rejected'].includes(c.status) ? `<button class="btn ghost" data-del="${c.id}" style="padding:4px 8px">Delete</button>` : ''}</td></tr>`).join('')}
        </tbody></table>
        <p class="note">Amounts in $MCP. Held: mint money in the 7-day hold. Ready: past the hold, paid after the check. Paid: on your balance, withdraw it in the chat.</p>` : ''}
      ${rules}
      <section class="panel" id="newCol"><h2 class="px">New collection</h2>${formHtml()}</section><div style="height:60px"></div></div>`;
    app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!window.confirm('Delete this collection and its pictures?')) return;
      try { await send('DELETE', `/launch/${b.dataset.del}`); renderLaunch(); } catch (e) { alert(e.message); }
    });
    app.querySelectorAll('[data-continue]').forEach((b) => b.onclick = () => {
      const c = mine.find((x) => String(x.id) === b.dataset.continue);
      wireForm(c);
      $('#newCol').scrollIntoView({ behavior: 'smooth' });
    });
    wireForm(null);
  }

  function formHtml() {
    const input = (id, label, attrs = '') => `<label style="display:grid;gap:4px"><span class="note">${label}</span>
      <input id="${id}" ${attrs} style="background:var(--bg);color:var(--cream);border:2px solid var(--edge);padding:9px 10px;font:inherit"></label>`;
    return `<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
        ${input('lName', 'Name', 'maxlength="40" placeholder="Pixel Frogs"')}
        ${input('lSlug', 'Collection id (in links and in the chat)', 'maxlength="30" placeholder="pixel-frogs" pattern="[a-z0-9-]{3,30}"')}
        ${input('lPrice', 'Mint price, $MCP', 'type="number" min="0.5" step="0.01" value="5"')}
        ${input('lLimit', 'Mints per account', 'type="number" min="1" max="100" value="5"')}
      </div>
      <label style="display:grid;gap:4px"><span class="note">Description</span>
        <textarea id="lDesc" maxlength="300" rows="2" style="background:var(--bg);color:var(--cream);border:2px solid var(--edge);padding:9px 10px;font:inherit"></textarea></label>
      <div><span class="note">Pictures and metadata: a folder or a .zip with 1.png, 2.png, … and either 1.json, 2.json, … or one _metadata.json (the usual export of NFT generators). Up to 10,000 pictures, 1 MB each.</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <label class="btn ghost">Choose a folder<input id="lDir" type="file" webkitdirectory multiple hidden></label>
          <label class="btn ghost">Choose a .zip<input id="lZip" type="file" accept=".zip,application/zip" hidden></label></div></div>
      <div id="lPreview" class="note"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button class="btn red" id="lGo" disabled>Upload and submit for review</button><span id="lStatus" class="note" aria-live="polite"></span></div>`;
  }

  function wireForm(draft) {
    let items = null;
    const status = (t) => { $('#lStatus').textContent = t; };
    if (draft) {
      $('#lName').value = draft.name; $('#lSlug').value = draft.slug; $('#lSlug').disabled = true;
      $('#lPrice').value = Number(draft.mint_price); $('#lLimit').value = draft.mint_limit; $('#lDesc').value = draft.description || '';
      status(`Continuing ${draft.slug}: choose the same pictures again, already uploaded ones are replaced.`);
    }
    $('#lName').oninput = () => { if (!draft && !$('#lSlug').dataset.touched) $('#lSlug').value = $('#lName').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); };
    $('#lSlug').oninput = () => { $('#lSlug').dataset.touched = '1'; };
    const take = async (entries) => {
      try {
        status('Reading…');
        items = await readCollection(entries);
        const traits = new Set(items.flatMap((i) => i.attributes.map((a) => a.trait_type)));
        $('#lPreview').innerHTML = `<b style="color:var(--cream)">${items.length.toLocaleString('en-US')} NFTs</b> · ${traits.size} traits (${esc([...traits].slice(0, 8).join(', '))}${traits.size > 8 ? ', …' : ''})
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;padding:10px 0 0" id="lThumbs"></div>`;
        for (const it of items.slice(0, 12)) {
          const url = URL.createObjectURL(await it.entry.blob());
          $('#lThumbs').insertAdjacentHTML('beforeend', `<img class="pix" src="${url}" alt="" style="width:100%;aspect-ratio:1;object-fit:contain;background:var(--panel);border:2px solid var(--edge)">`);
        }
        status('Ready to upload.');
        $('#lGo').disabled = false;
      } catch (e) {
        items = null;
        $('#lGo').disabled = true;
        status(e.message);
      }
    };
    $('#lDir').onchange = (e) => take([...e.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, blob: async () => f })));
    $('#lZip').onchange = async (e) => { try { take(await unzip(e.target.files[0])); } catch (err) { status(err.message); } };
    $('#lGo').onclick = async () => {
      if (!items) return;
      $('#lGo').disabled = true;
      try {
        const terms = { name: $('#lName').value, description: $('#lDesc').value, supply: items.length, mint_price: Number($('#lPrice').value), mint_limit: Number($('#lLimit').value) };
        const c = draft ? await send('PATCH', `/launch/${draft.id}`, terms) : await send('POST', '/launch', { ...terms, slug: $('#lSlug').value });
        draft = c;
        let batch = [], bytes = 0, done = 0;
        const flush = async () => {
          if (!batch.length) return;
          await send('POST', `/launch/${c.id}/items`, { items: batch });
          done += batch.length;
          status(`Uploaded ${done.toLocaleString('en-US')} / ${items.length.toLocaleString('en-US')}…`);
          batch = []; bytes = 0;
        };
        for (const it of items) {
          const blob = await it.entry.blob();
          if (blob.size > 1024 * 1024) throw new Error(`#${it.edition} is over 1 MB.`);
          const { thumb, pixel } = await thumbnail(blob);
          const one = { edition: it.edition, name: it.name, attributes: it.attributes, pixel, image: await b64(blob), thumb: await b64(thumb) };
          const size = one.image.length + one.thumb.length + 2000;
          if (bytes + size > 3_500_000 || batch.length >= 40) await flush();
          batch.push(one);
          bytes += size;
        }
        await flush();
        status('Submitting for review…');
        await send('POST', `/launch/${c.id}/submit`);
        status('Submitted. We will review it soon; this page shows when it is live.');
        setTimeout(renderLaunch, 1200);
      } catch (e) {
        status(e.message);
        $('#lGo').disabled = false;
      }
    };
  }

  // ---------- /admin: the owner's review queue ----------

  async function renderAdmin() {
    const app = $('#app');
    const who = await me();
    if (!who?.admin) {
      app.innerHTML = `<div class="wrap"><div class="empty">${who ? `Only the market's owner can see this page.<br><span class="note">Your X id: <code>${esc(who.x_id)}</code> (the owner's goes in ADMIN_X_IDS)</span>` : `<a class="btn red" href="${signIn('/admin')}">Sign in with X</a>`}</div></div>`;
      return;
    }
    const list = await send('GET', '/admin/collections');
    const act = (c) => {
      const b = (a, label, cls = 'ghost') => `<button class="btn ${cls}" data-act="${a}" data-id="${c.id}" style="padding:4px 8px">${label}</button>`;
      if (c.status === 'review') return b('approve', 'Approve', 'red') + b('reject', 'Reject');
      if (c.status === 'live') return (c.earnings.releasable ? b('release', `Pay out ${money(c.earnings.releasable)}`, 'red') : '') + b('pause', 'Pause') + b('freeze', 'Freeze & refund');
      if (c.status === 'paused') return (c.earnings.releasable ? b('release', `Pay out ${money(c.earnings.releasable)}`, 'red') : '') + b('resume', 'Resume') + b('freeze', 'Freeze & refund');
      return '';
    };
    const field = (id, label, attrs = '') => `<label style="display:grid;gap:4px"><span class="note">${label}</span>
      <input id="${id}" ${attrs} style="background:var(--bg);color:var(--cream);border:2px solid var(--edge);padding:9px 10px;font:inherit"></label>`;
    app.innerHTML = `<div class="wrap"><div class="ex-head"><div><h1 class="px">Lost deposits</h1>
      <p>Reports from <a href="/lost-deposit">/lost-deposit</a>. Each shows whose deposit address it is (as the person typed it: check on Solscan where the transaction really went) and whether that transaction was already credited. Crediting is still done by hand; a report moves no money.</p></div>
      <div class="tabs" role="tablist" id="ldTabs" style="margin-left:auto">${[['new', 'New'], ['all', 'All']].map(([k, v]) => `<button class="tab" role="tab" data-ld="${k}" aria-selected="${k === 'new'}">${v}</button>`).join('')}</div></div>
      <div id="ld" class="note">Loading…</div>
      <div class="ex-head" style="margin-top:28px"><div><h2 class="px" style="margin:0">$CREDIT claims</h2>
      <p>Burns (<b>/burnmcp</b>) give $CREDIT for MCP NFTs. A claim (<b>/claimcredit</b>) takes all of an account's $CREDIT to the Solana wallet it gave, for a fee in $MCP. <b>Copy all</b> copies the pending claims as <code>wallet,amount</code> lines, one per wallet, for the airdrop; after the airdrop, mark them sent.</p></div>
      <button class="btn red" id="crCopy" style="margin-left:auto" disabled>Copy all</button></div>
      <div id="crOut" class="note" aria-live="polite" style="margin:0 0 8px"></div>
      <textarea id="crText" readonly hidden rows="8" style="width:100%;background:var(--bg);color:var(--cream);border:2px solid var(--edge);padding:10px;font:12px ui-monospace,Menlo,monospace;margin:0 0 10px"></textarea>
      <div id="cr" class="note">Loading…</div>
      <div class="ex-head" style="margin-top:28px"><div><h2 class="px" style="margin:0">Free $CREDIT drops</h2>
      <p>A code people type in their AI chat (<b>/mcpcredit FREE1000</b>, or "FREE 1000 $CREDIT") for a fixed amount of $CREDIT, once per account. With tasks the AI asks for them and a screenshot first; then it gives the airdrop card to post on X, and the $CREDIT is added after a screenshot of that post. It goes through the chat's promo-code tool, so nobody has to reconnect the connector. The AI only looks at screenshots: an edited one can pass.</p></div></div>
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));align-items:end">
        ${field('dpCode', 'Code', 'placeholder="FREE1000" maxlength="32" autocomplete="off" spellcheck="false"')}
        ${field('dpAmount', '$CREDIT per account', 'type="number" min="1" step="1" value="1000" inputmode="numeric"')}
        ${field('dpUses', 'Uses (accounts)', 'type="number" min="1" max="100000" step="1" value="5000" inputmode="numeric"')}
        ${field('dpFollow', 'Task: follow (optional)', 'placeholder="https://x.com/mcpmarkets" autocomplete="off" spellcheck="false"')}
        ${field('dpTweet', 'Task: like + RT post (optional)', 'placeholder="https://x.com/mcpmarkets/status/…" autocomplete="off" spellcheck="false"')}
        <button class="btn red" id="dpGo" style="justify-content:center;padding:12px">Make drop</button>
      </div>
      <div id="dpOut" class="note" aria-live="polite" style="margin:10px 0"></div>
      <div id="dp" class="note">Loading…</div>
      <div class="ex-head" style="margin-top:28px"><div><h2 class="px" style="margin:0">Team mint</h2>
      <p>Free MCP NFTs, picked at random, outside the per-account mint limit. In the explorer they show as <b>team mint</b>.</p></div></div>
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:end">
        ${field('tmCount', 'How many', 'type="number" min="1" max="5000" step="1" value="10" inputmode="numeric"')}
        ${field('tmTo', 'To (empty: your account)', `placeholder="${esc(who.public_id || 'mcp_…')}" maxlength="16" autocomplete="off" spellcheck="false"`)}
        <button class="btn red" id="tmGo" style="justify-content:center;padding:12px">Mint free</button>
      </div>
      <div id="tmOut" class="note" aria-live="polite" style="margin-top:10px"></div>
      <div class="ex-head" style="margin-top:28px"><div><h2 class="px" style="margin:0">Promo codes</h2>
      <p>Each account that types the code in its AI chat (<b>/mcpmint with code CODE</b>) gets one free random MCP, until the uses run out. In the explorer they show as <b>free mint</b>.</p></div></div>
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:end">
        ${field('pcCode', 'Code', 'placeholder="FIRST200" maxlength="32" autocomplete="off" spellcheck="false"')}
        ${field('pcUses', 'Uses (accounts)', 'type="number" min="1" max="5000" step="1" value="200" inputmode="numeric"')}
        ${field('pcFollow', 'Task: follow (optional)', 'placeholder="https://x.com/mcpmarkets" autocomplete="off" spellcheck="false"')}
        ${field('pcTweet', 'Task: like + RT post (optional)', 'placeholder="https://x.com/mcpmarkets/status/…" autocomplete="off" spellcheck="false"')}
        <button class="btn red" id="pcGo" style="justify-content:center;padding:12px">Make code</button>
      </div>
      <p class="note" style="margin:8px 0 0">With tasks, the AI first asks for them and a screenshot, looks at the screenshot, then mints; after the mint it suggests replying to or quoting the post with the NFT. The AI only looks at a picture: an edited screenshot can pass.</p>
      <div id="pcOut" class="note" aria-live="polite" style="margin:10px 0"></div>
      <div id="pc" class="note">Loading…</div>
      <div class="ex-head" style="margin-top:28px"><div><h2 class="px" style="margin:0">Review queue</h2>
      <p>Open a collection to look through every picture before approving it. Pay-outs include only mints older than the hold.</p></div></div>
      <table class="txs"><thead><tr><th>Collection</th><th>Creator</th><th>Status</th><th class="hide-sm">NFTs</th><th style="text-align:right">Held</th><th style="text-align:right">Ready</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><a href="/c/${esc(c.slug)}">${esc(c.name)}</a><div class="note">${esc(c.slug)} · ${fmt(c.mint_price)} $MCP · ${c.mint_limit}/account</div></td>
        <td>${who.admin ? `<a class="addr" href="/a/${esc(c.creator_addr)}">@${esc(c.creator_handle)}</a>` : ''}</td>
        <td>${pill(c.status)}${c.review_note ? `<div class="note">${esc(c.review_note)}</div>` : ''}</td>
        <td class="hide-sm">${c.minted}/${c.supply}</td><td class="num">${money(c.earnings.held)}</td><td class="num">${money(c.earnings.releasable)}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">${act(c)}</td></tr>`).join('') || '<tr><td colspan="7" class="note">Nothing yet.</td></tr>'}
      </tbody></table>
      <div class="ex-head" style="margin-top:28px"><div><h2 class="px" style="margin:0">Database backups</h2>
        <p>Made every 2 hours and kept in Netlify, apart from the database. Download one now and then and keep it somewhere else too.</p></div>
        <button class="btn red" id="bkNow" style="margin-left:auto">Back up now</button></div>
      <div id="bk" class="note">Loading…</div><div style="height:60px"></div></div>`;
    loadBackups();
    loadClaims('new');
    loadCredit();
    loadDrops();
    wireDrops();
    $('#ldTabs').onclick = (e) => {
      const b = e.target.closest('[data-ld]');
      if (!b) return;
      $('#ldTabs').querySelectorAll('[data-ld]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      loadClaims(b.dataset.ld);
    };
    wireTeamMint(who);
    wirePromos();
    loadPromos();
    $('#bkNow').onclick = async (e) => {
      e.target.disabled = true;
      try { await send('POST', '/admin/backups'); } catch (err) { alert(err.message); }
      e.target.disabled = false;
      loadBackups();
    };
    app.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.act;
      let note = '';
      if (a === 'reject' || a === 'freeze') {
        note = window.prompt(a === 'freeze' ? 'Why is it frozen? (shown to the creator)' : 'Why is it rejected? (shown to the creator)') || '';
        if (a === 'freeze' && !window.confirm('Freeze it and refund every minter whose money is still held?')) return;
      }
      b.disabled = true;
      try { await send('POST', `/admin/collections/${b.dataset.id}/${a}`, { note }); renderAdmin(); } catch (e) { alert(e.message); b.disabled = false; }
    });
  }

  // the owner's free mint: a first press asks to confirm, the second mints in calls of up to 500
  function wireTeamMint(who) {
    const go = $('#tmGo');
    const out = $('#tmOut');
    const count = () => Math.floor(Number($('#tmCount').value));
    const to = () => $('#tmTo').value.trim();
    let armed = null;
    const reset = () => { armed = null; go.textContent = 'Mint free'; };
    $('#tmCount').oninput = reset;
    $('#tmTo').oninput = reset;
    go.onclick = async () => {
      const n = count();
      if (!(n >= 1 && n <= 5000)) { out.textContent = 'How many: 1 to 5,000.'; return; }
      if (to() && !/^mcp_[1-9A-HJ-NP-Za-km-z]{12}$/.test(to())) { out.textContent = 'To: an MCP address like mcp_PSVnRvFqCe6u, or leave it empty.'; return; }
      const key = `${n}|${to()}`;
      if (armed !== key) {
        armed = key;
        go.textContent = `Confirm: ${n.toLocaleString('en-US')} to ${to() || 'you'}`;
        out.textContent = '';
        return;
      }
      armed = null;
      go.disabled = true;
      let done = 0;
      let last = null;
      try {
        while (done < n) {
          out.textContent = `Minting… ${done.toLocaleString('en-US')} of ${n.toLocaleString('en-US')}`;
          last = await send('POST', '/admin/team-mint', { count: Math.min(500, n - done), to: to() || undefined });
          done += last.minted.length;
          if (!last.minted.length || last.left === 0 || last.stopped) break;
        }
        const why = last.stopped ? ` Stopped: ${esc(last.stopped)}` : done < n && last.left === 0 ? ' The collection is sold out.' : '';
        out.innerHTML = `Minted <b>${done.toLocaleString('en-US')}</b> to <a class="addr" href="/a/${esc(last.to)}">${esc(last.to)}</a>. ` +
          `Left in MCP: ${Number(last.left).toLocaleString('en-US')}.${why}`;
      } catch (e) {
        out.innerHTML = `${done ? `Minted ${done.toLocaleString('en-US')}, then: ` : ''}<span style="color:var(--red)">${esc(e.message)}</span>`;
      }
      go.disabled = false;
      reset();
    };
  }

  // promo codes: each gives one free MCP per account (typed in the chat), up to its number of uses
  async function loadPromos() {
    const el = $('#pc');
    if (!el) return;
    let list;
    try { list = await send('GET', '/admin/promo'); } catch (e) { el.textContent = e.message; return; }
    el.innerHTML = `<table class="txs"><thead><tr><th>Code</th><th style="text-align:right">Used</th><th>Status</th><th class="hide-sm">Last used</th><th></th></tr></thead><tbody>
      ${list.map((p) => `<tr><td><code>${esc(p.code)}</code><div class="note">type: /mcpmint with code ${esc(p.code)}</div>
        ${p.follow_url || p.tweet_url ? `<div class="note">tasks: ${p.follow_url ? `follow <a href="${esc(p.follow_url)}" target="_blank" rel="noopener">${esc(p.follow_url.replace(/^https:\/\//, ''))}</a>` : ''}${p.follow_url && p.tweet_url ? ' · ' : ''}${p.tweet_url ? `like + RT <a href="${esc(p.tweet_url)}" target="_blank" rel="noopener">post</a>` : ''}</div>` : '<div class="note">no tasks</div>'}</td>
        <td class="num"><b>${Number(p.used).toLocaleString('en-US')}</b> / ${Number(p.max_uses).toLocaleString('en-US')}</td>
        <td>${pill(p.status === 'active' ? (p.used >= p.max_uses ? 'used up' : 'live') : 'paused')}</td>
        <td class="hide-sm note">${p.last_used_at ? esc(new Date(p.last_used_at).toLocaleString()) : '—'}</td>
        <td style="text-align:right"><div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn ghost" data-pc="${esc(p.code)}" data-pa="${p.status === 'active' ? 'pause' : 'resume'}" style="padding:4px 8px">${p.status === 'active' ? 'Pause' : 'Resume'}</button>
          <button class="btn ghost" data-pc="${esc(p.code)}" data-pa="uses" data-used="${Number(p.used)}" data-max="${Number(p.max_uses)}" style="padding:4px 8px">Change uses</button>
          <button class="btn ghost" data-pc="${esc(p.code)}" data-pa="tasks" data-follow="${esc(p.follow_url || '')}" data-tweet="${esc(p.tweet_url || '')}" style="padding:4px 8px">Tasks</button></div></td></tr>`).join('')
        || '<tr><td colspan="5" class="note">No codes yet.</td></tr>'}
      </tbody></table>`;
    el.querySelectorAll('[data-pc]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.pa;
      let body;
      if (a === 'uses') {
        const v = window.prompt(`How many accounts can use ${b.dataset.pc}? (${b.dataset.used} already did)`, b.dataset.max);
        if (v == null) return;
        body = { uses: Math.floor(Number(v)) };
      } else if (a === 'tasks') {
        const f = window.prompt(`${b.dataset.pc}: X account to follow (https://x.com/name), empty for none`, b.dataset.follow);
        if (f == null) return;
        const t = window.prompt(`${b.dataset.pc}: post to like + RT (https://x.com/name/status/…), empty for none`, b.dataset.tweet);
        if (t == null) return;
        body = { follow_url: f.trim(), tweet_url: t.trim() };
      } else {
        body = { status: a === 'pause' ? 'paused' : 'active' };
      }
      b.disabled = true;
      try { await send('POST', `/admin/promo/${encodeURIComponent(b.dataset.pc)}`, body); } catch (e) { alert(e.message); }
      loadPromos();
    });
  }

  function wirePromos() {
    const out = $('#pcOut');
    $('#pcGo').onclick = async () => {
      const code = $('#pcCode').value.trim().toUpperCase();
      const uses = Math.floor(Number($('#pcUses').value));
      if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) { out.textContent = 'Code: 3 to 32 letters, digits, - or _.'; return; }
      if (!(uses >= 1 && uses <= 5000)) { out.textContent = 'Uses: 1 to 5,000.'; return; }
      $('#pcGo').disabled = true;
      try {
        const p = await send('POST', '/admin/promo', { code, uses, follow_url: $('#pcFollow').value.trim(), tweet_url: $('#pcTweet').value.trim() });
        out.innerHTML = `Made <code>${esc(p.code)}</code> for ${Number(p.max_uses).toLocaleString('en-US')} accounts. In the chat: <code>/mcpmint with code ${esc(p.code)}</code>`;
        $('#pcCode').value = '';
        loadPromos();
      } catch (e) {
        out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
      }
      $('#pcGo').disabled = false;
    };
  }

  // lost deposit reports, with what the database knows: whose deposit address, was the transaction credited
  let claimsView = 'new';
  async function loadClaims(view = claimsView) {
    claimsView = view;
    const el = $('#ld');
    if (!el) return;
    let list;
    try { list = await send('GET', `/admin/deposit-claims${view === 'new' ? '?status=new' : ''}`); } catch (e) { el.textContent = e.message; return; }
    const sol = (kind, v) => `<a class="mono-link" href="https://solscan.io/${kind}/${encodeURIComponent(v)}" target="_blank" rel="noopener" title="${esc(v)}">${esc(v.slice(0, 6))}…${esc(v.slice(-4))} ↗</a>`;
    const acct = (o) => (o ? `<a class="addr" href="/a/${esc(o.addr)}">${esc(o.addr)}</a>${o.handle ? ` <span class="note">@${esc(o.handle)}</span>` : ''}` : '—');
    const check = (k) => {
      const addr = (k.address === 'not ours' ? '<span class="pill bad">not our deposit address</span>'
        : `<span class="pill ok">${esc(k.address)}</span> ${acct(k.owner)}`) +
        (k.other_addresses ? ` <span class="pill bad" title="Check on Solscan where the transaction really went">also reported with ${k.other_addresses} other address${k.other_addresses === 1 ? '' : 'es'}</span>` : '');
      const tx = k.credited ? `<span class="pill ok">credited${k.manual ? ' by hand' : ''}</span>${k.deposits.map((d) => ` ${fmt(d.amount)} ${esc(d.token)} → ${acct({ addr: d.addr, handle: d.handle })}`).join('')}`
        : k.deposits.length ? `<span class="pill wait">${esc(k.deposits.map((d) => `${d.status}: ${fmt(d.amount)} ${d.token}`).join(', '))}</span>`
          : '<span class="pill wait">not seen by MCP</span>';
      return `<div>${addr}</div><div style="margin-top:4px">${tx}</div>`;
    };
    const STATUS_PILL = { new: 'wait', done: 'ok', rejected: 'bad' };
    el.innerHTML = `<table class="txs"><thead><tr><th>#</th><th>Sent to → from</th><th>Transaction</th><th>What MCP knows</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td>#${c.id}<div class="note">${esc(new Date(c.created_at).toLocaleString())}</div>${c.reporter ? `<div class="note">by ${acct(c.reporter)}</div>` : ''}</td>
        <td>${sol('account', c.deposit_address)}<div class="note">from ${sol('account', c.from_wallet)}</div></td>
        <td>${sol('tx', c.tx)}</td>
        <td>${check(c.check)}</td>
        <td><span class="pill ${STATUS_PILL[c.status] || 'wait'}">${esc(c.status)}</span>${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}</td>
        <td style="text-align:right"><div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          ${c.status !== 'done' ? `<button class="btn red" data-cl="${c.id}" data-cs="done" style="padding:4px 8px">Done</button>` : ''}
          ${c.status !== 'rejected' ? `<button class="btn ghost" data-cl="${c.id}" data-cs="rejected" style="padding:4px 8px">Reject</button>` : ''}
          ${c.status !== 'new' ? `<button class="btn ghost" data-cl="${c.id}" data-cs="new" style="padding:4px 8px">Reopen</button>` : ''}
          <button class="btn ghost" data-cl="${c.id}" data-cs="" style="padding:4px 8px">Note</button></div></td></tr>`).join('')
        || `<tr><td colspan="6" class="note">${view === 'new' ? 'No new reports.' : 'No reports yet.'}</td></tr>`}
      </tbody></table>`;
    el.querySelectorAll('[data-cl]').forEach((b) => b.onclick = async () => {
      const status = b.dataset.cs || undefined;
      let note;
      if (!status || status === 'rejected') {
        note = window.prompt(status ? 'Why is it rejected? (for you; not shown to anyone)' : 'Note (for you; not shown to anyone)', '');
        if (note == null) return;
      }
      b.disabled = true;
      try { await send('POST', `/admin/deposit-claims/${b.dataset.cl}`, { status, note }); } catch (e) { alert(e.message); }
      loadClaims();
    });
  }

  // $CREDIT: what burns and drops gave, and the claims to airdrop. Copy all remembers exactly which claims it copied,
  // and "Mark sent" marks those: a claim that comes in after the copy is never marked by mistake.
  let crData = null;
  let copied = null; // { ids, count } of the last Copy all
  async function loadCredit() {
    const el = $('#cr');
    if (!el) return;
    try { crData = await send('GET', '/admin/credit'); } catch (e) { el.textContent = e.message; return; }
    const t = crData.totals;
    const n = (v) => Number(v || 0).toLocaleString('en-US');
    const wallets = crData.airdrop ? crData.airdrop.split('\n').length : 0;
    $('#crCopy').disabled = !wallets;
    $('#crCopy').textContent = wallets ? `Copy all (${n(wallets)} wallet${wallets === 1 ? '' : 's'})` : 'Copy all';
    const PILL = { pending: 'wait', sent: 'ok', void: 'bad' };
    el.innerHTML = `<div class="tiles" style="margin:0 0 12px">${[['Burned NFTs', n(t.burned_nfts)], ['$CREDIT given', `${n(t.issued + t.drop_credit)}${t.drops ? ` <small>· ${n(t.drops)} free drops</small>` : ''}`], ['Not claimed yet', n(t.unclaimed)],
      ['Pending claims', `${n(t.pending)} <small>· ${n(t.pending_credit)}</small>`], ['Sent', `${n(t.sent)} <small>· ${n(t.sent_credit)}</small>`], ['Claim fees', `${fmt(t.fees)} <small>$MCP</small>`]]
      .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px"><button class="btn ghost" id="crSent" ${copied?.ids.length ? '' : 'disabled'}>${copied?.ids.length ? `Mark the ${n(copied.ids.length)} copied claims as sent` : 'Mark copied as sent'}</button>
        <span class="note">${copied ? 'Only the claims in the last Copy all.' : 'Press Copy all first.'}</span></div>
      <table class="txs"><thead><tr><th>#</th><th>Account</th><th>Wallet</th><th style="text-align:right">$CREDIT</th><th>Status</th><th></th></tr></thead><tbody>
      ${crData.claims.map((c) => `<tr><td>#${c.id}<div class="note">${esc(new Date(c.at).toLocaleString())}</div></td>
        <td><a class="addr" href="/a/${esc(c.addr)}">${esc(c.addr)}</a><div class="note">@${esc(c.handle)}</div></td>
        <td><a class="mono-link" href="https://solscan.io/account/${encodeURIComponent(c.wallet)}" target="_blank" rel="noopener">${esc(c.wallet)}</a></td>
        <td class="num">${n(c.amount)}</td>
        <td><span class="pill ${PILL[c.status] || 'wait'}">${esc(c.status)}</span></td>
        <td style="text-align:right"><div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${c.status === 'void' ? ''
          : c.status === 'sent' ? `<button class="btn ghost" data-crid="${c.id}" data-crto="pending" style="padding:4px 8px">Undo</button>`
          : `<button class="btn ghost" data-crid="${c.id}" data-crto="sent" style="padding:4px 8px">Sent</button><button class="btn ghost" data-crvoid="${c.id}" style="padding:4px 8px">Void</button>`}</div></td></tr>`).join('')
        || '<tr><td colspan="6" class="note">No claims yet.</td></tr>'}
      </tbody></table>${crData.claims.length >= 1000 ? '<p class="note">Showing the newest 1,000 claims; Copy all has every pending one.</p>' : ''}`;
    const mark = async (ids, status) => {
      try { const r = await send('POST', '/admin/credit/mark', { ids, status }); $('#crOut').textContent = `${n(r.updated)} marked ${status}.`; } catch (e) { alert(e.message); }
      loadCredit();
    };
    $('#crSent').onclick = () => {
      if (!copied?.ids.length) return;
      if (!window.confirm(`Mark the ${copied.ids.length} claims of the last Copy all (${copied.count} wallets) as sent? Do it after that airdrop went out.`)) return;
      const ids = copied.ids;
      copied = null;
      mark(ids, 'sent');
    };
    el.querySelectorAll('[data-crid]').forEach((b) => b.onclick = () => {
      const to = b.dataset.crto;
      if (to === 'pending' && !window.confirm(`Put claim #${b.dataset.crid} back to pending? It will be in the next Copy all, so it may be paid twice.`)) return;
      b.disabled = true;
      mark([Number(b.dataset.crid)], to);
    });
    el.querySelectorAll('[data-crvoid]').forEach((b) => b.onclick = async () => {
      if (!window.confirm(`Void claim #${b.dataset.crvoid}? Its $CREDIT goes back to the account (the fee stays paid). Use it for a claim made by mistake.`)) return;
      b.disabled = true;
      try { const r = await send('POST', `/admin/credit/void/${b.dataset.crvoid}`); $('#crOut').textContent = `Claim #${r.id} void: ${n(r.returned)} $CREDIT back on the account.`; } catch (e) { alert(e.message); }
      loadCredit();
    });
  }
  document.addEventListener('click', async (e) => {
    if (e.target.id !== 'crCopy' || !crData?.airdrop) return;
    const lines = crData.airdrop;
    const count = lines.split('\n').length;
    copied = { ids: crData.airdrop_ids.slice(), count };
    $('#crText').value = lines;
    try {
      await navigator.clipboard.writeText(lines);
      $('#crOut').textContent = `Copied ${count.toLocaleString('en-US')} line${count === 1 ? '' : 's'} (wallet,amount), ${copied.ids.length.toLocaleString('en-US')} claims.`;
      $('#crText').hidden = true;
    } catch {
      $('#crOut').textContent = 'Copy it from the box below.';
      $('#crText').hidden = false;
      $('#crText').select();
    }
    const btn = $('#crSent');
    if (btn) { btn.disabled = false; btn.textContent = `Mark the ${copied.ids.length.toLocaleString('en-US')} copied claims as sent`; }
  });

  // free $CREDIT drops: code, $CREDIT each, uses, tasks; pause, resume, change uses or tasks
  async function loadDrops() {
    const el = $('#dp');
    if (!el) return;
    let list;
    try { list = await send('GET', '/admin/drops'); } catch (e) { el.textContent = e.message; return; }
    const n = (v) => Number(v || 0).toLocaleString('en-US');
    el.innerHTML = `<table class="txs"><thead><tr><th>Code</th><th style="text-align:right">$CREDIT each</th><th style="text-align:right">Cards / done / max</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((d) => `<tr><td><code>${esc(d.code)}</code><div class="note">type: /mcpcredit ${esc(d.code)}</div>
        ${d.follow_url || d.tweet_url ? `<div class="note">tasks: ${d.follow_url ? `follow <a href="${esc(d.follow_url)}" target="_blank" rel="noopener">${esc(d.follow_url.replace(/^https:\/\//, ''))}</a>` : ''}${d.follow_url && d.tweet_url ? ' · ' : ''}${d.tweet_url ? `like + RT <a href="${esc(d.tweet_url)}" target="_blank" rel="noopener">post</a>` : ''}</div>` : '<div class="note">no tasks</div>'}</td>
        <td class="num">${n(d.amount)}</td>
        <td class="num"><b>${n(d.used)}</b> / ${n(d.done)} / ${n(d.max_uses)}</td>
        <td>${pill(d.status === 'active' ? (d.used >= d.max_uses ? 'used up' : 'live') : 'paused')}</td>
        <td style="text-align:right"><div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn ghost" data-dp="${esc(d.code)}" data-da="${d.status === 'active' ? 'pause' : 'resume'}" style="padding:4px 8px">${d.status === 'active' ? 'Pause' : 'Resume'}</button>
          <button class="btn ghost" data-dp="${esc(d.code)}" data-da="uses" data-used="${Number(d.used)}" data-max="${Number(d.max_uses)}" style="padding:4px 8px">Change uses</button>
          <button class="btn ghost" data-dp="${esc(d.code)}" data-da="tasks" data-follow="${esc(d.follow_url || '')}" data-tweet="${esc(d.tweet_url || '')}" style="padding:4px 8px">Tasks</button></div></td></tr>`).join('')
        || '<tr><td colspan="5" class="note">No drops yet.</td></tr>'}
      </tbody></table><p class="note" style="margin:6px 0 0">Cards: accounts that did the tasks and got the card (each takes a use). Done: posted it and got the $CREDIT.</p>`;
    el.querySelectorAll('[data-dp]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.da;
      let body;
      if (a === 'uses') {
        const v = window.prompt(`How many accounts can get ${b.dataset.dp}? (${b.dataset.used} already did)`, b.dataset.max);
        if (v == null) return;
        body = { uses: Math.floor(Number(v)) };
      } else if (a === 'tasks') {
        const f = window.prompt(`${b.dataset.dp}: X account to follow (https://x.com/name), empty for none`, b.dataset.follow);
        if (f == null) return;
        const t = window.prompt(`${b.dataset.dp}: post to like + RT (https://x.com/name/status/…), empty for none`, b.dataset.tweet);
        if (t == null) return;
        body = { follow_url: f.trim(), tweet_url: t.trim() };
      } else {
        body = { status: a === 'pause' ? 'paused' : 'active' };
      }
      b.disabled = true;
      try { await send('POST', `/admin/drops/${encodeURIComponent(b.dataset.dp)}`, body); } catch (e) { alert(e.message); }
      loadDrops();
    });
  }
  function wireDrops() {
    const out = $('#dpOut');
    $('#dpGo').onclick = async () => {
      const code = $('#dpCode').value.trim().toUpperCase();
      const amount = Math.floor(Number($('#dpAmount').value));
      const uses = Math.floor(Number($('#dpUses').value));
      if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) { out.textContent = 'Code: 3 to 32 letters, digits, - or _.'; return; }
      $('#dpGo').disabled = true;
      try {
        const d = await send('POST', '/admin/drops', { code, amount, uses, follow_url: $('#dpFollow').value.trim(), tweet_url: $('#dpTweet').value.trim() });
        out.innerHTML = `Made <code>${esc(d.code)}</code>: ${Number(d.amount).toLocaleString('en-US')} $CREDIT each, for ${Number(d.max_uses).toLocaleString('en-US')} accounts. In the chat: <code>/mcpcredit ${esc(d.code)}</code>`;
        $('#dpCode').value = '';
        loadDrops();
      } catch (e) {
        out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
      }
      $('#dpGo').disabled = false;
    };
  }

  async function loadBackups() {
    const el = $('#bk');
    if (!el) return;
    let b;
    try { b = await send('GET', '/admin/backups'); } catch (e) { el.textContent = e.message; return; }
    const last = b.last;
    const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const state = !last ? 'No backup yet.'
      : last.ok ? `Last backup <b>${esc(new Date(last.at).toLocaleString())}</b> · ${kb(last.bytes)} · ${Number(last.counts?.users || 0)} accounts, ${Number(last.counts?.ledger || 0)} ledger rows`
      : `<span style="color:var(--red)">Last backup failed ${esc(new Date(last.at).toLocaleString())}: ${esc(last.error)}</span>`;
    el.innerHTML = `<p style="margin:0 0 10px">${state}</p>
      <table class="txs"><thead><tr><th>Backup</th><th></th></tr></thead><tbody>
      ${b.items.slice(0, 30).map((it) => `<tr><td>${esc(new Date(it.at).toLocaleString())}</td>
        <td style="text-align:right"><a class="btn ghost" style="padding:4px 10px" download href="/api/admin/backups/file?key=${encodeURIComponent(it.key)}">Download</a></td></tr>`).join('')
        || '<tr><td colspan="2" class="note">None stored yet.</td></tr>'}
      </tbody></table>`;
  }

  window.MCP_LAUNCH = { renderLaunch, renderAdmin, readCollection, unzip };
})();
