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
    app.innerHTML = `<div class="wrap"><div class="ex-head"><div><h1 class="px">Team mint</h1>
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
        <button class="btn red" id="pcGo" style="justify-content:center;padding:12px">Make code</button>
      </div>
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
      ${list.map((p) => `<tr><td><code>${esc(p.code)}</code><div class="note">type: /mcpmint with code ${esc(p.code)}</div></td>
        <td class="num"><b>${Number(p.used).toLocaleString('en-US')}</b> / ${Number(p.max_uses).toLocaleString('en-US')}</td>
        <td>${pill(p.status === 'active' ? (p.used >= p.max_uses ? 'used up' : 'live') : 'paused')}</td>
        <td class="hide-sm note">${p.last_used_at ? esc(new Date(p.last_used_at).toLocaleString()) : '—'}</td>
        <td style="text-align:right"><div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn ghost" data-pc="${esc(p.code)}" data-pa="${p.status === 'active' ? 'pause' : 'resume'}" style="padding:4px 8px">${p.status === 'active' ? 'Pause' : 'Resume'}</button>
          <button class="btn ghost" data-pc="${esc(p.code)}" data-pa="uses" data-used="${Number(p.used)}" data-max="${Number(p.max_uses)}" style="padding:4px 8px">Change uses</button></div></td></tr>`).join('')
        || '<tr><td colspan="5" class="note">No codes yet.</td></tr>'}
      </tbody></table>`;
    el.querySelectorAll('[data-pc]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.pa;
      let body;
      if (a === 'uses') {
        const v = window.prompt(`How many accounts can use ${b.dataset.pc}? (${b.dataset.used} already did)`, b.dataset.max);
        if (v == null) return;
        body = { uses: Math.floor(Number(v)) };
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
        const p = await send('POST', '/admin/promo', { code, uses });
        out.innerHTML = `Made <code>${esc(p.code)}</code> for ${Number(p.max_uses).toLocaleString('en-US')} accounts. In the chat: <code>/mcpmint with code ${esc(p.code)}</code>`;
        $('#pcCode').value = '';
        loadPromos();
      } catch (e) {
        out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
      }
      $('#pcGo').disabled = false;
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
