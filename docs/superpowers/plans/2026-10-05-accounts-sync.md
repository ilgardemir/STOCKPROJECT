# Accounts and Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional Google sign-in that syncs saved analyses, screens, MySquall, theme, watchlist and portfolio across devices.

**Architecture:** `auth-sync.js` owns all account logic behind an injected `db.query` and `fetch`, so it runs offline in tests. `server.js` routes `/auth/*` and `/api/*` to it before static serving. `app.js` keeps localStorage as the working copy and mirrors changes per item through a new ACCOUNT SYNC section.

**Tech Stack:** Node 20 `http` + `crypto` + `fetch`, `pg` (first npm dependency), Postgres on Railway, vanilla JS front end.

Spec: `docs/superpowers/specs/2026-10-05-accounts-sync-design.md` (every value below is copied from it).

## Global Constraints

- Signed-out behaviour is unchanged; no existing route may depend on the database.
- `pg` is the only new dependency.
- Mutating routes require `Origin` = public origin and `X-Squall-Sync: 1`; `/auth/*` and `/api/*` responses carry no `Access-Control-Allow-Origin`.
- Session cookie `squall_sid`: HttpOnly, Secure (unless public URL is http), SameSite=Lax, Path=/, 30 days, renewed under 15 days left. DB stores SHA-256 of the token only.
- Limits: `SQUALL_AUTH_IP_HOURLY` 20, `SQUALL_SYNC_WRITES_PER_MIN` 120, `SQUALL_SYNC_ITEM_MAX_BYTES` 2097152, `SQUALL_SYNC_USER_MAX_BYTES` 26214400.
- `SYNC_STORES` = `["analyses","screens","profile","theme","watchlist","portfolio"]`, identical in app.js and auth-sync.js.
- Front end: `on(id, ev, fn)` only, tokens only, no new horizontal band, no `window.confirm`.
- Never log tokens, codes or secrets.

## File map

| File | Change |
|---|---|
| `auth-sync.js` | New. Config, crypto helpers, validation, schema, route handler factory |
| `server.js` | Route hook before `serveStatic`; pool + schema init at startup; export for tests |
| `package.json` | `"pg"` dependency; new test files in `test:js` via run.js |
| `app.js` | ACCOUNT SYNC section: `mergeSyncState`, change detection, flush, load, header UI; hooks in six writers |
| `partials/chrome-top.html` | Account button + popover |
| `styles.css` | Account button/popover rules using existing tokens |
| `tests/js/auth-sync.test.js` | New, server-side tests with fake DB and fake fetch |
| `tests/js/app.test.js` | Merge tests (mergeSyncState) |
| `tests/js/pagecheck.js` | `/api/me` stub returns `{enabled:false}` |
| `scripts/check_sync_stores.js` | Contract check app.js vs auth-sync.js `SYNC_STORES` |
| `CLAUDE.md`, `docs/engineering-notes.md` | Accounts section, env rows |

## Tasks

### Task 1: auth-sync.js pure helpers
Produces: `SYNC_STORES`, `loadConfig(env) → {enabled, reason, publicUrl, clientId, clientSecret, secret, limits}`,
`signValue(secret, obj) → string`, `verifySigned(secret, str, maxAgeMs) → obj|null`,
`safeReturnPath(s) → string`, `checkIdClaims(claims, {clientId, nonce, now}) → null|reasonCode`,
`validateItem(store, id, data) → null|reasonCode`, `hashToken(t) → hex`, `parseCookies(header) → obj`.
- [ ] Tests in `tests/js/auth-sync.test.js` for each (tamper, expiry, `//evil.com`, `/\x`, `https://x`, bad aud/iss/exp/nonce/email_verified, wrong store/id/kind).
- [ ] Implement; run `node tests/js/run.js`; commit.

### Task 2: route handler with injected DB
Produces: `createAccounts({config, db, fetchImpl, now}) → {handle(req, res, ip) → Promise<boolean>, ensureSchema() → Promise}`; `handle` returns false for paths it does not own.
- [ ] In-memory fake DB in the test file implementing the exact SQL the module issues (matched by a leading tag comment, e.g. `/*users.upsert*/`).
- [ ] Tests: `/api/me` disabled and signed-out; full sign-in with fake Google token endpoint sets `squall_sid` and redirects to `return#signed-in`; state mismatch → `#signin-error`; PUT/GET/DELETE sync round trip; Origin/header missing → 403; item cap 413 `too_large`; quota 413 `quota`; write rate 429; logout deletes session; account delete removes rows; session renewal re-sets cookie.
- [ ] Implement; run; commit.

### Task 3: server wiring + pg
- [ ] `npm install pg`; in server.js create `pg.Pool` only when config enabled, `ensureSchema()` at startup (failure → accounts disabled, logged), route `/auth/` and `/api/` to `accounts.handle` before the GET static fallthrough and before POST routes; strip `Access-Control-Allow-Origin` on those routes.
- [ ] Test: `serveStatic` unaffected; `node --check server.js`; local run without env returns `{enabled:false}` from `/api/me`. Commit.

### Task 4: client merge (pure)
Produces in app.js: `SYNC_STORES`, `mergeSyncState(local, server, meta) → {stores, puts}` where each side is `{store: {id: {data, modifiedAt}}}`.
- [ ] Tests in app.test.js: analyses/screens newer-wins and union; watchlist server-first union capped at 25; profile/portfolio newer modifiedAt, ties to account; theme local only when explicitly picked; puts list only items differing from server.
- [ ] Implement; commit.

### Task 5: client sync engine, hooks, header UI
- [ ] `syncReadStore`/`syncWriteStore` per store; `syncNoteChange(store)` diff + pending; debounced flush; pagehide keepalive under 60 KB; `/api/me` + `/api/sync` load with first-link merge, different-user replace, pending-wins, streaming-session guard; 401/5xx/413 handling; sign-out/delete clear six keys + meta and reload.
- [ ] Hooks in `writeSessionMap`, `persistScreeners`, `saveMySquall`, `resetMySquall`, `commitTheme(persist)`, `persistWatchlist`, `persistPortfolio`.
- [ ] Header button + popover in chrome-top partial; CSS with tokens.
- [ ] pagecheck stub for `/api/me`; run pagecheck; commit.

### Task 6: contract check, docs, verification
- [ ] `scripts/check_sync_stores.js`, add to `test:contracts`; verify it fails when one list is edited.
- [ ] CLAUDE.md + engineering notes. Commit and push.
- [ ] Local run against Railway Postgres public URL with Google localhost redirect (manual), then live test as test user.
