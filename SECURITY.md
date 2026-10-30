# Security

## What protects your account

**Sign-in (OAuth 2.1 with PKCE)** — [`server/src/auth.js`](server/src/auth.js)
- Your AI app gets a token bound to your X account. Access tokens last 7 days; refresh tokens are single-use and rotate.
- Codes and tokens are stored as sha256 hashes. A database leak doesn't reveal working tokens.
- A sign-in must finish in the browser that started it (a short-lived, HttpOnly, SameSite cookie set at `/authorize`). Nobody can send you a sign-in link that connects *their* AI app to *your* account.
- The sign-in page shows which app and which website will receive access, and warns if it's not Claude or ChatGPT.
- Sign-in pages can't be framed (`X-Frame-Options: DENY`) and leak nothing in the `Referer` header.

**Money** — [`server/src/market.js`](server/src/market.js)
- Every balance change and its ledger row are written in one database transaction; balances can't go negative.
- `buy` takes the price you agreed to (`expected_price`) and fails if the listing changed.
- Concurrent buys of one NFT: exactly one succeeds (row lock), tested.
- `send_nft` (sending NFTs to other MCP addresses, `/sendnft`) works in two steps. The first call moves nothing: it checks ownership and the addresses and keeps the exact list under a one-time code; the send needs that code, from the same account, for the same list, from 10 seconds to 10 minutes after the preview (so the assistant has to show it to the user first), and a newer preview replaces it. All NFTs of a send go or none do; trading rules apply (no frozen collections, nothing before a collection's sell-out if it trades only after it); at most 100 NFTs an hour per account (`SEND_PER_HOUR`). The code does pass through the assistant, so like `buy` this relies on the assistant asking the user; unlike withdrawals there is no button only the user can press. Concurrent sends of one NFT: exactly one succeeds (row lock), tested on Postgres.
- The transfer form (`transfer_form`, an MCP App) sends NFTs only when you press its *Confirm* button (it works 700 ms after it appears). Its tools are `visibility: ["app"]` and the send needs the form's pass (HMAC per user, 2 hours, key derived from a server secret). The pass comes in the tool result's `_meta`; because some apps drop `_meta` before it reaches the form, the form's own refresh tool also hands one out. So in an app that ignores `visibility`, an assistant could get a pass from that tool: there the form's lock is only as strong as `send_nft`'s. Apps that follow the MCP Apps spec keep app-only tools away from the assistant.
- Withdrawals go only to an address you bind once. Changing it requires support, so text injected into a chat, web page or NFT name can't redirect funds. It can't be a token account or one of the market's own addresses; on the real server the first withdrawal opens 24 hours after binding.
- The AI can only open the withdrawal form (`withdraw_form`, an MCP App); you bind the address and withdraw by pressing the buttons in it, each with a second *Confirm* step that a double click can't trigger. The AI can pre-fill only the amount, never an address.
  - The buttons are tools with `visibility: ["app"]`, which apps following the MCP Apps spec must keep out of the AI's tool list. They also need the form's pass: an HMAC-signed token for this user, valid 2 hours, handed to the form in the tool result's `_meta` (meant for the form, not the AI's context). An app that ignores visibility still can't let its AI bind or withdraw unless it also shows the AI that metadata. If the form can't be built, its buttons aren't offered at all.
  - Each confirmed withdrawal carries a one-time request key (unique per user in the database). A retry, a replay or a lost answer gets the same withdrawal back, never a second one. The form keeps the key until the server has said what happened to it, and errors after a withdrawal was made are never reported as a refusal.
  - The form is one self-contained page: the MCP Apps SDK is inlined and pinned by its sha256, and it loads nothing from other domains.

**Withdrawals** — [`server/src/withdrawals.js`](server/src/withdrawals.js)
- Payouts come from a hot wallet holding a small float; it is the only key the server has. Deposits stay in addresses only the offline phrase controls.
- A withdrawal is never paid twice. Every signed transaction is stored before broadcasting and can't be changed or deleted (trigger); a new one is built only when the finalized block height (asked first) is past every earlier one's last valid height plus a margin, and a status lookup from a node at least that current shows none landed (a failed landing counts only once finalized). Errors from the network count as "maybe received", and `sendTransaction` is never retried automatically. Every state change is made under a row lock and only if the status and the number of stored transactions are unchanged. Only signatures the server stored are trusted. Tested with lost responses, refusals, dropped, late and last-block transactions, stale status nodes, parallel instances with random faults (chaos test, also on Postgres), outsider transactions carrying our memo, and rows reset in the database. Two independent reviews' findings are fixed.
- A rejected withdrawal is refunded only when none of its transactions landed or can still land, at most once (unique ledger key), and `refunded` is final: it can't be paid afterwards.
- `sent` and `refunded` are final and a withdrawal's amount, fee, address and user can't be changed (database triggers), so mistakes in the table editor can't cause a double payment.
- Withdrawal rows and address bindings are HMAC-signed (key derived from `DEPOSIT_POOL_KEY`, independent of the hot wallet), and a withdrawal needs the balance to match the ledger: a row or binding created or changed in the database is not paid. Full control of the database could still inflate an account's balance and withdraw it; a hard daily payout cap and the hot wallet float limit that.
- Automatic payouts are limited per withdrawal, per user per day and in total per day; larger ones wait for the owner.

**Launchpad** — [`server/src/launchpad.js`](server/src/launchpad.js), [`server/src/storage.js`](server/src/storage.js)
- A collection goes live only after the market's owner approves it; until then its page and pictures are served only to its creator and the owner (`private, no-store`).
- Uploaded pictures are checked by their first bytes: only PNG, JPEG, GIF and WEBP, at most 1 MB, never SVG or HTML. They are served with their real type, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Names, traits and descriptions are cut to length, stripped of markup and escaped on every page.
- Mint money of a creator's collection never reaches the creator directly: the market's fee goes to the treasury, the rest into the escrow, a separate ledger account counted as owed in the proof of reserves and checked against the open holds. It is held at least 7 days per mint and paid out only when the owner releases it. Holds can't be deleted, their amounts can't change, and each ends once, paid out or refunded (trigger).
- Freezing a collection stops minting and trading and refunds, in one transaction, the full mint price of every mint still held.
- Signing in on the site uses the same X sign-in, finished in the same browser, then an HttpOnly, SameSite=Lax session cookie stored as a sha256 hash. Every change needs the site's own `X-MCP-Site` header and origin, so another website can't make one. The owner's actions need their X account id in `ADMIN_X_IDS`: an id, not a handle, because a handle can be renamed and taken by someone else.

**Explorer** — [`server/src/explorer.js`](server/src/explorer.js)
- Public pages show MCP addresses, never X handles, unless the account's owner turns the handle on. Hidden handles can't be looked up (`/api/users/:handle` only finds public ones). Support references of manual credits are published only as a digest.
- Ledger rows can't be changed or deleted (trigger); once sealed they carry a hash chain anyone can recompute. The latest hash is anchored on Solana hourly; the explorer page reads those memos from Solana itself (not from our API) and checks they are signed by the payout wallet, so history rewritten up to an anchor is caught even with full database access. Anchor rows are protected by a trigger too. Anchors are memo-only transactions from the payout wallet, move no tokens, and stop while payouts are paused.
- Proof of reserves reads balances straight from Solana and counts a token account only once, and only if it has the expected mint and owner. What is owed comes from the ledger and is checked against the account balances. Reserve wallets are the owner's declaration and shown as such. The public API only reads: sealing, anchors, totals and reserves happen in the scheduled run.

**Database** — [`server/src/schema.js`](server/src/schema.js)
- Only the server talks to Postgres. Supabase's auto-generated REST API is turned off for this project, and as a second layer every table has row level security with no policies, so the public API roles can't read anything even if it's switched on.
- Backups ([`server/src/backup.js`](server/src/backup.js)) hold every account, so only the owner (`ADMIN_X_IDS`) can list or download them, downloads are never cached, and file names are checked against a fixed pattern. They hold no keys or seed phrases (the database has none) and no sign-in sessions. A restore refuses a database that already has data and checks balances against the ledger and the hash chain after loading, so a tampered file shows up.

**Deposits** — [`server/src/deposits.js`](server/src/deposits.js)
- Each user deposits to their own Solana address from a pool made offline on the owner's computer (`npm run deposit-pool`). The seed phrase stays on paper; the server holds only public addresses and has no key that can move deposited funds.
- Every pool address is signed with `DEPOSIT_POOL_KEY` (HMAC of network, index and address). The server never shows or credits an address whose signature fails, so database write access alone can't redirect deposits; a failing row is set aside and logged as an alert.
- Nothing is credited because a webhook says so. Every transaction is fetched from the chain and checked: real USDC/USDT mint, the user's own token account, owner equals the user's deposit wallet, successful transaction, amount from the chain's balances.
- Each (transaction, token account) pair is credited once, enforced by a unique key, so webhook replays, retries and parallel scans can't double-credit. Money moving out of one of our own pool addresses (the owner's sweep) is never credited, and a transaction support already credited by hand is not credited again. Tests cover forged payloads, replays, failed transactions, fake mints, wrong owners, forged pool rows, internal transfers, dust and lagging nodes.
- The Helius webhook must present a password (derived from the pool key, compared in constant time).
- The test server only accepts devnet tokens and the real server only mainnet ones, so free test money and real money never share a balance.
- `POST /admin/deposit` (manual credits for support) needs `ADMIN_TOKEN` and is off when it's unset. One reference is credited once.

## Test server caveats

While `DEV_LOGIN=1`, anyone can sign in as any handle. That's on purpose for the public test, and all balances are free test money. Production runs with X sign-in only.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on this repository instead of a public issue.
