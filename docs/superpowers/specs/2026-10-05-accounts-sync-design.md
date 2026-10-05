# Accounts and sync (Google sign-in)

Date: 2026-10-05 · Status: approved design, not yet implemented

## Goal

Let a visitor sign in with Google so their saved work follows them across devices. Signing
in is optional: signed-out Squall behaves exactly as it does today, and analysis, screening
and chat never depend on the database.

Synced stores (localStorage key → store name):

| Key | Store | Shape | Rows |
|---|---|---|---|
| `squall-saved-analyses-v1` | `analyses` | map id → persisted session (has `updatedAt`) | one per id |
| `squall-saved-screeners-v1` | `screens` | map id → screen (has `updatedAt`) | one per id |
| `squall-profile-v1` | `profile` | MySquall object or absent | single |
| `squall-theme-v2` | `theme` | theme id, only when explicitly picked | single |
| `squall-watchlist-v1` | `watchlist` | `[{t, at}]`, max `WATCH_MAX` (25) | single |
| `squall-portfolio-v1` | `portfolio` | `[{t, shares, cost}]`, max `PF_MAX` (25) | single |

Not synced (per-device): split width, chat height, chat-think toggle, chart compare/percent
keys, section key, analysis-run counter.

Out of scope: other sign-in methods, live cross-tab sync (another open tab picks changes up
on its next load), sharing between users, account-gated AI features.

## Approach

localStorage stays the working copy; a sync layer mirrors it. Rejected: one blob per user
(every small change re-uploads megabytes of bars and AI text, and devices clobber each
other), and server-as-source-of-truth (rewrites persistence in app.js and forks every code
path into signed-in/signed-out).

## 1. Server and data

New dependency: `pg` (first npm dependency; the Dockerfile already runs `npm install`).

New file `auth-sync.js` holds all account logic. It exports a factory taking a small DB
interface (`query(sql, params)`), so tests inject an in-memory fake. `server.js` only adds
route hooks and passes the real `pg.Pool`.

Tables, created at startup with `CREATE TABLE IF NOT EXISTS` (no migration tool):

```sql
users      (id BIGSERIAL PK, google_sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT,
            picture TEXT, created_at TIMESTAMPTZ DEFAULT now())
sessions   (token_hash TEXT PK, user_id BIGINT REFERENCES users ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL)
user_items (user_id BIGINT REFERENCES users ON DELETE CASCADE, store TEXT, item_id TEXT,
            data JSONB NOT NULL, modified_at BIGINT NOT NULL, bytes INT NOT NULL,
            PRIMARY KEY (user_id, store, item_id))
```

`item_id` is `''` for single-row stores. `modified_at` is the client's modification time
(ms), used for merge decisions. Expired sessions are deleted opportunistically on sign-in.

Routes:

| Route | Purpose |
|---|---|
| `GET /auth/google?return=` | Start sign-in |
| `GET /auth/google/callback` | Finish sign-in |
| `POST /auth/logout` | Delete session, clear cookie |
| `GET /api/me` | `{enabled, user}`; `user` null when signed out |
| `GET /api/sync` | All of the user's rows |
| `PUT /api/sync/:store/:id` | Upsert one row (`:id` is `_` for single-row stores) |
| `DELETE /api/sync/:store/:id` | Delete one row |
| `DELETE /api/account` | Delete user (cascades), clear cookie |

Enablement: accounts are on only when `SQUALL_ACCOUNTS` is not `off` **and**
`DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SQUALL_SESSION_SECRET` are
all set **and** table creation succeeded. Otherwise `/api/me` returns `{enabled:false}`,
the other routes return 404 (or 503 if only the DB is down), and the header hides the button.
A DB failure never affects any existing route.

`/auth/*` and `/api/*` are routed before `serveStatic` and are not part of `PUBLIC_FILES`.
They are not `admit()`-gated and never call `spendAi()`.

## 2. Sign-in flow and security

1. `/auth/google?return=<path>`: `return` must start with a single `/` (not `//`, not `/\`)
   and contain no scheme; otherwise `/`.
2. Generate `state`, PKCE `code_verifier` (S256 challenge) and `nonce`. Store
   `{state, verifier, nonce, return}` in cookie `squall_oauth`: HMAC-SHA256-signed with
   `SQUALL_SESSION_SECRET`, `Max-Age=600`, `HttpOnly`, `SameSite=Lax`, `Path=/auth`,
   `Secure` unless the public URL is http. Redirect to Google with
   `scope=openid email profile`, `prompt=select_account`.
3. Callback: verify the cookie signature and that `state` matches; clear the cookie. POST
   the code + verifier to `https://oauth2.googleapis.com/token` with built-in `fetch`
   (10s timeout). Decode the `id_token` payload (received directly from Google over TLS, so
   no signature check per OIDC Core §3.1.3.7) and require: `iss` ∈
   {`https://accounts.google.com`, `accounts.google.com`}, `aud` = client id, `exp` in the
   future, `nonce` matches, `email_verified` true. Upsert `users` by `sub`.
4. Session: 32 random bytes, base64url, in cookie `squall_sid` (`HttpOnly`, `Secure`,
   `SameSite=Lax`, `Path=/`, `Max-Age` 30 days). DB stores SHA-256 of the token. A request
   with under 15 days left renews `expires_at` and re-sets the cookie.
5. Redirect to `return` with `#signed-in` appended, which tells the client to run the
   first-link merge.

Any callback failure redirects to `return` with `#signin-error` and logs a reason code
(never tokens, codes or secrets) to stderr.

Redirect URI is `${SQUALL_PUBLIC_URL}/auth/google/callback`. `SQUALL_PUBLIC_URL` defaults
to `https://squall.up.railway.app` in production and `http://localhost:${PORT}` when
`NODE_ENV` is not `production` and `RAILWAY_ENVIRONMENT` is unset. Never derived from `Host`.

CSRF: every mutating route (`POST /auth/logout`, `PUT`/`DELETE /api/sync/*`,
`DELETE /api/account`) requires `Origin` equal to the public URL's origin and header
`X-Squall-Sync: 1`. No CORS headers are ever sent.

Limits (env-tunable, defaults below):

| Variable | Default | Meaning |
|---|---|---|
| `SQUALL_AUTH_IP_HOURLY` | 20 | `/auth/google` starts per IP per hour |
| `SQUALL_SYNC_WRITES_PER_MIN` | 120 | PUT/DELETE per user per minute |
| `SQUALL_SYNC_ITEM_MAX_BYTES` | 2097152 | One row's JSON size |
| `SQUALL_SYNC_USER_MAX_BYTES` | 26214400 | Sum of a user's `bytes` |

Over a size cap → 413 `{error, code:"too_large"|"quota"}`; over the write rate → 429.
Request bodies are read with the existing `readBody` and the item cap.

Store names are validated against a fixed list (`SYNC_STORES`); item ids against
`^[A-Za-z0-9_-]{1,80}$`. `data` must be JSON of the store's expected kind (object for
`analyses`/`screens`/`profile`, string for `theme`, array for `watchlist`/`portfolio`).

## 3. Client sync (app.js)

A new section `// ─── ACCOUNT SYNC ───` in app.js. Constants `SYNC_STORES` mirror the
server list (contract-tested).

Hooks: after a successful localStorage write, these call `syncNoteChange(store)`:
`writeSessionMap` → `analyses`, `persistScreeners` → `screens`, `saveMySquall` /
`resetMySquall` → `profile`, `commitTheme(def, persist=true)` → `theme`,
`persistWatchlist` → `watchlist`, `persistPortfolio` → `portfolio`. The hook does nothing
when signed out.

Meta key `squall-sync-meta-v1`: `{userId, server: {store: {id: modifiedAt}},
local: {store: {id: modifiedAt}}, pending: [{store, id, op}]}`.

Change detection: `syncNoteChange(store)` reads the store from localStorage, splits it into
items, and compares each item's serialized JSON with a hash cached from the last sync. Changed
items get `local[store][id] = Date.now()` and a pending `put`; vanished items get a pending
`delete`. Pending ops flush after 1.5s of quiet, one request per op, sequentially. On
`pagehide`/`visibilitychange:hidden`, ops whose body is under 60 KB flush with
`fetch(..., {keepalive:true})`; the rest stay in `pending` for the next load.

Page load when `/api/me` reports a user:
1. The page renders from localStorage first (unchanged startup path, no added latency).
2. `GET /api/sync`. If `meta.userId` is unset (first link on this browser), run the merge.
   If it differs from the signed-in user, replace local synced stores with the server's.
   Otherwise apply the server's rows, except items with a pending op (local wins) and the
   session currently streaming an analysis.
3. Re-render only what changed: tabs (`hydrateSavedSessions` + `renderAll`), screens,
   watchlist, portfolio, MySquall labels, theme via `commitTheme(def, false)` (the local
   write is done separately so it doesn't echo back as a change).

Merge (pure function `mergeSyncState(local, server)`, unit-tested):
- `analyses`, `screens`: union by id; on clash, higher `updatedAt` wins.
- `watchlist`: server entries first, then local tickers not already present, capped at
  `WATCH_MAX`.
- `portfolio`, `profile`: whichever side has the higher `modified_at` (local side uses
  `meta.local` or 0 if never tracked, so the account wins ties).
- `theme`: local counts only if explicitly picked (`squall-theme-v2` present); otherwise
  server wins.
- Results that differ from the server are queued as pending puts. Then `meta.userId` is set.

Sign-out: `POST /auth/logout`, then remove the six synced keys and the meta key, then reload.
Account deletion: confirm in the menu (inline confirm step, not `window.confirm`), then
`DELETE /api/account`, then the same local clear and reload.

401 from any sync call: mark signed out in the UI ("Signed out, sign in again to sync"),
**keep** local data and meta (so a later sign-in by the same user resumes without a merge).
Network/5xx: keep pending, retry with backoff (5s, 30s, 2min, then on next load); the
header shows a small "Not synced" state. 413: `showStorageNotice` with the cap message and
drop that pending op.

Header UI (in `partials/chrome-top.html`, no new band): a text button **Sign in** linking
to `/auth/google?return=<current path+query>`. Signed in: the button shows the user's
initial; clicking opens a popover (existing popover styling, as the watchlist) with the
email, **Sign out**, and **Delete account**. Hidden entirely when `enabled:false`. Wired
with `on(id, ev, fn)` only. All styling via existing tokens; checked in all six themes.

## 4. Testing and rollout

Offline tests (`npm test`, no Postgres):
- `tests/js/auth-sync.test.js` with an in-memory DB fake: cookie sign/verify and tamper
  rejection; return-path validation (`//evil.com`, `https://x`, `/\x` rejected);
  id_token claim checks (bad `aud`, expired, wrong `nonce`, unverified email); Origin and
  header requirement on each mutating route; item and quota caps; write-rate 429; account
  deletion removes all rows and sessions; disabled mode returns `{enabled:false}`.
- `tests/js/sync-merge.test.js`: `mergeSyncState` cases from §3, plus different-user
  replacement and pending-wins.
- Contract check: `SYNC_STORES` identical in app.js and auth-sync.js.
- Pagecheck: all pages still load signed out with `/api/me` unreachable; sync code must not
  throw or block the seeded saved-analysis path. Header button ids are added to the partial.
- Each new checker is run once against deliberately broken code to confirm it fails.

Rollout:
1. `SQUALL_ACCOUNTS=off` is the instant revert from the Railway dashboard.
2. Push; sign in on the live site as a Google test user; save an analysis, change theme,
   edit watchlist; confirm on a second browser; sign out and confirm the browser is cleared.
3. Then publish the Google OAuth app.
4. CLAUDE.md: accounts section and env-table rows; rationale in `docs/engineering-notes.md`.

## Env vars added

`SQUALL_ACCOUNTS` (on), `SQUALL_PUBLIC_URL`, `DATABASE_URL` (Railway reference),
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SQUALL_SESSION_SECRET`, plus the four limits
above.
