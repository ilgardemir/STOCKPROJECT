# CLAUDE.md

**Squall**: an equity analysis tool (repo name STOCKPROJECT, product name "Squall"). Vanilla
everything: no frameworks, no build step, and **one npm dependency** (`pg`, for accounts). Adding
a dependency is a real decision.

> **Rationale, measurements and history live in [`docs/engineering-notes.md`](docs/engineering-notes.md).**
> This file keeps the rules. Before changing anything listed here, read the matching section
> there to see why it exists, because most of these rules were learned from a production failure.

## Working rules

- **Commit and push each completed change automatically.** `git add` + commit (descriptive
  message + Co-Authored-By trailer) + `git push`. Committing directly to `main` is fine; a
  collaborator shares the repo, and Railway auto-deploys from `main`.
- **Live at https://squall.up.railway.app.** It is the only environment with Python deps and
  API keys, so verify scraper/screener behaviour there. Locally, `node server.js` serves the UI,
  but analyses fail with "Script produced no output" unless you use the stub (see Testing).
- Locally on Windows, `python3` is a Store stub, so use `python`.
- **A front-end change is not verified until both pages run** (`npm test` includes pagecheck).
- **After any prompt edit on a reasoning route**, check the `reasoning=` figure in the
  `describeAiStream` log line (baseline ~1,200 chars on Luna). Prompt edits are never free.
- Verify styling by measuring the live DOM across all six themes, not by reading source.

## Commands

```bash
node server.js                          # UI + API on PORT (default 3000)
python3 scraperFinal.py AAPL            # full analyzer payload to stdout (main debug tool)
echo '{"tickers":["AAPL","MSFT"],"names":{},"spec":{"concepts":[{"id":"momentum","weight":1}]}}' | python3 screener.py
echo '{"query":"AAPL","as_of":"2023-03-15"}' | python3 backtester.py
pip3 install -r requirements.txt
docker build -t squall .                # matches the Railway deploy
npm test                                # offline: JS, pagecheck, Python unittest, contract checks
npm run test:js | test:py | test:contracts
```

Screener env knobs for fast tests: `SCREENER_LIMIT=N`, `SCREENER_CACHE_TTL`, `SCREENER_CACHE_PATH`.

## Testing

- `tests/js/run.js` awaits each test. `stream-failsafe.test.js` still has its own older runner.
- `tests/js/pagecheck.js` runs each page's scripts (including inline `<script>` blocks) against
  that page's real id set for `index.html`, `screener.html`, `portfolio.html`, `ilgar.html` and `404.html`. It seeds
  a saved analysis whose **newest** tab has intraday bars, a **derived** range tier and a
  **legacy numeric** `range`, so the returning-visitor path and the range migration both run.
  Don't weaken that seed.
- **Validate a checker before trusting it.** Run it against broken code and confirm it fails.
- No-Python server run: `PORT=3271 PYTHON_BIN=node SQUALL_SCRAPER_PATH=./tests/stubs/scraper_stub.js node server.js`
  (`STUB_NO_INTRADAY=1` for a fund-like payload). `SQUALL_SCREENER_PATH` / `SQUALL_BACKTESTER_PATH`
  work the same way. They are for testing only.
- The automation browser tab runs in the background, so `requestAnimationFrame` never fires.
  Call `drawChart()` directly before measuring the canvas. Measure token colours through a probe
  element, because `getComputedStyle` lags a theme switch.

## Architecture

**Flows:** browser → `server.js` → spawns Python engine → OpenRouter LLM → SSE back to browser.
The screener adds an LLM step that turns the query into a recipe before `screener.py` runs.

| File | Role |
|---|---|
| `server.js` | Raw `http` server (no Express): routes, LLM gateway, limits, caches, static serving |
| `scraperFinal.py` | Single-ticker data engine (SEC EDGAR, Finnhub, optional FMP, yahooquery). Builds `ai_prompt` plus dashboard keys |
| `screener.py` | Multi-index screener. Job JSON on stdin, deterministic scoring, `PROGRESS\|pct\|label` on stderr |
| `backtester.py` | Hidden point-in-time engine for `/ilgar`. `snapshot` and `outcomes` are kept separate; `ai_prompt` is built from `snapshot` only |
| `replay-engine.js` | `/ilgar` research replay v2 policy (see below) |
| `auth-sync.js` | Optional Google sign-in, sessions and per-item sync (`/auth/*`, `/api/*`). Takes `db.query` and `fetch` by injection |
| `news-research.js` | Two parallel web searches (`NEWS_QUERIES`), merged into a digest that replaces the Finnhub records in `ai_prompt` §14 (live analyzer only) |
| `event_calendar.py` | `event_risk` (next results window). No dependencies; backtester re-exports it |
| `financial_rules.py` | Business-model applicability, bid/ask validation |
| `app.js` / `styles.css` | Shared by every page: one script, one stylesheet |
| `index.html` (`/`), `screener.html`, `portfolio.html`, `ilgar.html`, `404.html` | Pages. `partials/chrome-top.html`, `partials/chrome-tabs.html` hold shared chrome via `<!--#include name-->` |
| `sp500.js`, `market-universes.js` | Index constituents (S&P 500, Nasdaq-100, Dow 30, combined) |

### Engine contracts (Python ↔ Node)

- **stdout is sacred.** Only the JSON payload (or `{"error": ...}`) goes there. Diagnostics go to
  stderr (`STAGE|n|7|label`, `PROGRESS|`, `WARN|`). Serialize the whole payload to a string
  before writing, and always use `allow_nan=False`.
- **The scraper has 7 stages**, also hard-coded as `STAGE_TOTAL` in server.js. Change both together.
- After stage 1 the scraper prints `RESOLVED|TICKER|Company` on stderr; the server starts the news
  search from it so the search overlaps the scrape. Without it the search starts after the scrape.
- **Guard NaN before `int()`.** `int(x or 0)` does not guard, because NaN is truthy. Use `safe_int`
  (scraper) or `finite()` (screener).
- Everything degrades to `N/A` rather than crashing (`YQData`, `safe_*`, `_sec_get`).
  `sec_available` requires companyfacts **and** a located 10-K.
- Intraday: `intraday_history` has `5m` and `60m` (either may be absent). The `30m` series is
  **derived in app.js** and never shipped or stored. Intraday `date` must be `"YYYY-MM-DD HH:MM"`,
  because Fib anchors look bars up by date.
- **Financial classification keys on the Yahoo *industry*, never the sector.** Payment
  networks are listed in `PAYMENT_NETWORKS`. With no industry, the sector decides, conservatively.
- `event_risk.imminent` (≤21 days, `EARNINGS_IMMINENT_DAYS`) is the only flag anything should
  key off. `falls_inside_horizon` is always true at 3m/6m. Live adds `live_event_risk`, where an
  8-K Item 2.02 advances the window.
- Signal-layer rules: a tie with no evidence is not a verdict (`net_bias` breaks ties with
  `up_vol_ratio`). The regime `confidence` score saturates, so **no prompt may carry it**. Send
  prompts through `regime_for_prompt` (`separation` + `basis`). An empty support/resistance list
  needs `levels_note`.
- Anything decidable from the numbers belongs in the engine as a decided flag (e.g.
  `direction_guardrails`), not in the prompt as a test.

### Screener vocabulary is duplicated in three places

`SCREENER_CATALOG` (server.js, authoritative), the per-concept `scores` in `screener.py`, and
`SCREEN_CONCEPT_LABELS` (app.js). Add a concept to all three, or it silently scores a neutral 50.
Bump `CACHE_VERSION` in screener.py whenever the scored fields change. `npm run test:contracts`
checks for drift.

### Server routes

- `GET /analyze-stream?ticker=&profile=`: the main path. SSE events: `progress`, `result`
  (sent as soon as the scraper finishes; `news_pending: true` while the web search runs), `news`
  (the digest fields, only when `news_pending` was set), then `ai_start`/`ai_thinking`/`ai_delta` →
  `ai_done` or `ai_error`. AI retries up to 3×, **only before the first token**.
- `GET /screen-stream?q=&universe=&profile=` (`existing=` + `result_count=` for refinement):
  `screen_*` events. All model output is re-sanitized against fixed enums and ranges.
- `GET /backtest-stream?ticker=&as_of=`: `/ilgar`. Emits `backtest_outcomes` (with `audit`)
  only after the AI stream ends.
- `POST /analyze` (non-streaming fallback), `POST /chat` (SSE; listens for close on **`res`**, not `req`).
- `GET /quotes?symbols=`: watchlist quotes. Finnhub only, **not** `admit()`-gated. It has its own
  cache, a site-wide upstream window and a per-IP cap.
- `GET /health`: dumb on purpose; must never leak budget. `GET /stats?key=`: 404s unless
  `SQUALL_STATS_KEY` matches.
- **Accounts** (`auth-sync.js`, spec `docs/superpowers/specs/2026-10-05-accounts-sync-design.md`):
  `/auth/google`, `/auth/google/callback`, `POST /auth/logout`, `GET /api/me`, `GET /api/sync`,
  `PUT|DELETE /api/sync/:store/:id`, `DELETE /api/account`. Routed before everything else, never
  `admit()`-gated, never `spendAi()`. Optional by construction: off unless `DATABASE_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SQUALL_SESSION_SECRET` are all set and the schema
  check passed; then `/api/me` says `{enabled:false}` and no other route notices. The pg pool is
  only created in `startAccounts()` (never on `require`). Every mutating route needs
  `Origin` = `SQUALL_PUBLIC_URL`'s origin **and** `X-Squall-Sync: 1`; these routes strip the
  wildcard CORS header. Cookie holds a random token, the DB only its SHA-256. The redirect URI
  comes from `SQUALL_PUBLIC_URL`, **never** from `Host`. `SYNC_STORES` is duplicated in app.js
  (`node scripts/check_sync_stores.js` checks drift). Never log tokens, codes or secrets.
- Everything else goes through `serveStatic`: an **explicit allowlist**, extensionless → `.html`, include
  expansion, ETag/Cache-Control. Strip the query string before testing for `/`. `sendNotFound`
  serves `404.html` only for `Accept: text/html` and page-shaped misses, and always with a real 404.

### SSE rules

- **Event names are a contract** between `send()` in server.js and listeners in app.js. Don't
  rename them.
- **Limits on SSE routes go in-band at HTTP 200**, as `limited:true` inside `error`/`screen_error`.
  `EventSource` can't read non-200 bodies. POST routes return a real 429/503 with JSON.
- **Read `finish_reason`.** Truncation → `ai_error` with `truncated: true`, never `ai_done`, and it
  is **never retried**. All four AI call sites share `newAiStreamState`/`readAiStreamLine`/
  `aiStreamTruncated`/`reasoningConfig()`. Request `usage: { include: true }`.
- **Silent-stream fail-safes:** the handler is wrapped (`failRequest` emits the route's terminal
  event via `SSE_FAIL_EVENTS`), `sseWriter` makes writes to a dropped socket a no-op, and `/ilgar`
  has a watchdog (`BT_FIRST_EVENT_MS` 20s, `BT_SILENCE_MS` 90s). Register listeners in ilgar through
  its `on()` wrapper, not bare `addEventListener`.
- Release the Python slot **exactly once** via the guarded closure from `acquirePy`.
- Disconnect detection: on POST use `res`; on SSE GETs `req` is correct.

### Abuse limits (`// ─── ABUSE LIMITS ───` in server.js)

- `admit(req, kind)` is called **explicitly** at the top of each costed route, never as a blanket
  gate, because static files must stay free. It charges per-IP and global scrape/screen ceilings
  *before* work starts.
- `spendAi()` charges the global AI budget right before the first OpenRouter call (after
  `send("result")` on analyze), **once per logical request**, with **no refunds**.
- Degrade, don't fail: with no AI budget the analyzer still returns data, the screener uses the
  rule-based recipe, and chat returns 503.
- Client identity is IP-only. Forwarding headers are trusted only from a private peer, using the
  rightmost public entry. IPv6 is bucketed to /64.
- State is in memory, mirrored to `os.tmpdir()` (temp+rename). Only daily counts are restored.
- Python concurrency is a bounded queue (`MAX_PY` 3 / `MAX_QUEUE` 10, then 503), with a queue
  tick every 5s.
- **Replica trap:** limits and caches are per-process. **Never scale beyond one replica without
  shared state (e.g. Redis).**

### Protecting provider standing (Yahoo, SEC, Finnhub can block the IP permanently)

- Never retry harder into a failure. Every retry path needs a failure-signature gate, a stop on
  `_throttled`, and a budget (`SCREENER_RETRY_BUDGET`).
- `MAX_PY` sets the request rate. If you raise it, lower `SQUALL_SEC_RATE_PER_PROC` in the same change.
- All sec.gov calls go through `_sec_throttle`. Per-filing fetch loops are capped by `SEC_MAX_FILING_FETCHES`.
- Caches are load-shedding. The screener cache tracks tickers confirmed by non-empty upstream responses, not only rows produced; an empty provider response must never count as fresh coverage.
- Every subprocess has a wall-clock timeout. Watch `providers.*.rate_limited` in `/stats`.

### `/ilgar`: research replay v2

`/ilgar` runs **research replay v2**. Read `docs/replay-methodology.md` and `replay-engine.js`
first. It permits flat decisions, uses one structured commitment from the research response, and
locks horizon and execution assumptions before generation. MySquall does not change v2. Legacy
forced-choice, conviction sizing, runner/tolerance exits and AI review (`SQUALL_BT_*` knobs,
`scripts/compare_exit_policies.js`) are **earlier experiments kept only for offline
reproducibility. Do not reconnect them to the live route.** The backtester prompt is a
projection (`PROMPT_BLOCKS`, `facts_for_prompt`). Historical news, options and estimates are
marked unavailable, never substituted with current data. `/ilgar` is unlinked and `noindex`,
which hides it but does not protect it.

### AI prompting (analyzer and chat)

- `buildAiMessages()` assembles the prompt. MySquall is personalization only, and its free text is
  labeled untrusted, **except** `tradeIdeaDirective()`, which binds the trade idea's holding period
  and instrument. The scraper's Trade Idea section is instrument-neutral and must stay that way.
  Change both halves together.
- The analysis instruction block must stay under 2,600 characters (a test enforces this).
- `ai_prompt` §6b (`build_price_bar_block`) carries actual bars. Headlines are untrusted source material.
- **§14 news is a web-search digest** (`news-research.js`), spliced in by the server over the
  scraper's Finnhub §14 after `result`, before caching and before the AI call. It reaches the
  browser as the `news` event, and until then the News card shows a loader, **never** the Finnhub
  records (the card shows only what the model reads; Finnhub shows on fallback). An item survives only if its
  URL is one the search **cited** (annotations). Dates must fall inside the lookback window, and
  labels are forced onto fixed enums. Finnhub records remain the fallback whenever the search is
  off, fails, times out, grounds nothing or the budget is gone. The digest is cached per ticker
  for 30 minutes and in-flight searches are shared. **Never use it on `/ilgar`**: a search
  runs today and would leak post-cutoff news.

## Front end (`app.js`)

- **Multi-page contract:** `<body data-page>` sets `PAGE`/`IS_SCREENER_PAGE`. **Never write a bare
  top-level `document.getElementById(x).addEventListener`.** Use `on(id, ev, fn)`, because one
  null kills every listener below it on the other pages.
- **Load-time ordering:** `applyTheme()` runs at load and repaints the chart, so anything
  `drawChart` touches must be declared above it (`RANGES`, `chartPaneState`, `chartZoom`,
  `fibInteraction`) or be a hoisted `function`. Otherwise you get a temporal-dead-zone throw for
  any visitor with a saved tab.
- Deep links: `/?t=TICKER`, `/screener?id=<screenId>`. Use `gotoAnalyzer()`/`gotoScreener()`.
- **Layout budget:** the target is 1280×720, so height is the scarce axis. **No new fixed horizontal
  bands.** Focus mode is `(max-width:1100px), (max-height:820px)`. `syncPaneVisibility` must clear
  `[data-hidden]` when leaving focus mode. `#viewRail` drives both layouts via `VIEWS`, wired by
  delegation inside `renderAll`. Repaint the chart when its destination is entered.
- **Persistence:** `persistableSession()` writes a trimmed projection (round OHLC, drop derived and
  duplicate data). Never mutate the in-memory session. On quota, evict least-recently-used
  sessions (never `active`) and call `showStorageNotice()`. Debounce UI churn with
  `scheduleSessionSave`, persist state transitions immediately, and flush on
  `pagehide`/`visibilitychange`. Screens never evict. Profiles and tabs stay in localStorage only.
- **Account sync** (`ACCOUNT SYNC` section): localStorage stays the working copy. Every write of a
  synced store (analyses, screens, MySquall, an explicit theme pick, watchlist, portfolio) calls
  `syncNoteChange(store)` after it succeeds; a new synced store needs that hook, a `SYNC_KEYS`
  entry and a server-side `SYNC_STORES` entry. Analyses and screens are **only deleted through
  `syncDeleteItem`**, never inferred from a missing id, because eviction must not delete from the
  account. Compare items with `syncCanon` (JSONB reorders keys). Signed out, the hooks are inert.
  The `SYNC` runtime object sits at the top of app.js for the TDZ reason above.
- **Chart:**
  - Ranges are timeframe descriptors. `seriesFor(d, tf)` is the only resolver, and `aggregateBars`
    anchors to the newest bar. `sess.range` is an id string, and `normalizeRange` migrates legacy
    numbers.
  - `resolvePane` decides what gets drawn; `paintChartPane` only paints.
  - Percent mode shares one domain across both compare panes, then converts back to price space.
  - Overlay levels never set the y-axis.
  - `visibleWindow`/`zoomWindow` count bars from the right edge.
  - A bare wheel scrolls the page. Ctrl or pinch zooms. The canvas uses `touch-action: pan-y`.
  - The compare control has **no ids**. Use `data-compare-*` attributes and `syncChartChrome()`.
  - `expandChart` must not clone `.overlay-wrap`.
  - `overflow-x` belongs on `#rangeSel`, not `#chartControls`.
- `renderAnalysisBody` sections the finished answer only (not `flushStream`) and falls back to
  flat markdown below 2 headers.
- The chat dock stays collapsed until used. `syncChatDock(focused)` takes focus explicitly. Clamp
  a stored `--chat-h`.
- Two search fields share `attachTypeahead`. `#ticker` is the source of truth. Use `setAnalyzeBusy()`.
- **Themes:** there are six (`THEMES`; default follows the OS, Noir dark / Paper light; key `squall-theme-v2`, written only on an
  explicit pick). `404.html` mirrors the theme map inline, so adding a theme means editing both.
  Canvas code keys off `data-mode`. `cssVar` is memoized and invalidated by `squall:theme`, so
  mutate tokens only inside `commitTheme`. The crossfade is a view transition, so a token swap is
  async and every transition promise needs a `catch`.
- Watchlist: store tickers only (`squall-watchlist-v1`) and refresh only while the popover is open
  and the tab is visible.
- Portfolio (`/portfolio`): holdings `{t, shares, cost|null}` in `squall-portfolio-v1`, priced from
  `/quotes` (never stored), refreshed only while the page is visible. Totals count only priced
  holdings and P&L only holdings with a cost; the summary shows those counts. No AI yet.
- `404.html` shares only `styles.css`, with no `app.js` and no partials.

## Design system ("precision instrument")

Spec: `docs/superpowers/specs/2026-08-04-ui-precision-instrument-design.md`. It favours dense,
information-first layouts and treats decoration as suspect.

- **All styling goes through tokens in `styles.css` `:root`.** No literal colors, font families
  or sizes. app.js also reads tokens (`cssVar(...)` and inline `var(...)`), so grep both when you
  rename one.
- Type: `--mono` (Plex Mono) for data and chrome, `--doc` (Newsreader) for prose. Scale runs from
  `--t-micro` 10px to `--t-title` 22px. **10px is a hard floor.**
- Colour roles: `--chrome-0/1/2`, `--rule`, `--ink`/`--ink-dim`/`--ink-bright` and `--accent` are
  set per theme. `--up`/`--down`/`--warn` (+`-soft`) are set per `[data-mode]` only. **Exactly
  one accent.** Green and red mean direction only. `--chrome-hi` is for hover/active states.
  Don't reintroduce the deleted legacy names (`--bg`, `--text`, `--violet`, …).
- Metrics are tabular rows (`metric(label, value, cls)`). Cards are hairline sections
  (`card(id, title, body, opts)`, four args, no icons).
- Motion shows state and never announces arrival (the hero is exempt).
- Check contrast against the actual backdrop (cards sit on `--chrome-0`, screener results on
  `--chrome-1`) in all six themes. Daylight is the worst case. Confirm hover and active states
  differ from their backdrop.

### UI / design guidelines

When modifying UI, preserve and extend the existing design system rather than inventing a new one.

Avoid stereotypical AI-generated UI patterns:
- excessive cards and nested containers
- excessive rounded corners
- gradient text, glowing borders, decorative gradients, or background blobs
- large shadows on ordinary components
- oversized headings in application interfaces
- icons attached to every label or heading
- excessive pills, badges, and decorative labels
- unnecessary borders around every section
- arbitrary spacing or one-off colors
- filling whitespace with decorative elements
- creating new components when an existing component can be extended

Prefer:
- strong alignment and grid structure
- consistent spacing tokens
- restrained typography hierarchy
- subtle borders and shadows
- purposeful color usage
- information density appropriate to the application
- whitespace instead of decorative containers
- one clear primary action per section
- reusable existing components
- predictable responsive behavior

Before implementing a UI change:
1. Inspect neighboring components and pages.
2. Identify existing spacing, typography, colors, radii, and component patterns.
3. Reuse those patterns wherever possible.
4. Make the smallest design change necessary to accomplish the requested goal.
5. Review the result for visual consistency with the rest of the product.

The finished interface should look intentionally designed, not like a generic AI-generated SaaS
template.

## Environment variables

Every limit and knob reads an env var and falls back to its default on a typo, so values can be
retuned from the Railway dashboard without a deploy.

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required for any AI output |
| `SQUALL_AI_MODEL` | `openai/gpt-6-luna` | Analysis, backtest and chat. Chosen for reliability, not accuracy (see notes) |
| `SQUALL_UTILITY_MODEL` | `deepseek/deepseek-v4.1-flash` | Screener translation only. Keep it cheap |
| `SQUALL_AI_FREQ_PENALTY` | 0 | **Non-zero + a frontier model = every request fails** ("No allowed providers"), because it turns on `require_parameters` |
| `SQUALL_AI_TEMPERATURE` | 0.3 | Luna ignores it |
| `SQUALL_REASON_MAX_TOKENS` | 4000 | The reasoning cap that actually binds. `0` = send `effort` only |
| `SQUALL_REASON_EFFORT` | `low` | Raise to `medium` before touching routing if depth looks thin |
| `SQUALL_ANALYSIS_MAX` / `SQUALL_CHAT_MAX` | 16000 / 8000 | Ceilings, not targets |
| `SQUALL_AI_PROVIDER_SORT` | `throughput` | `price` / `latency` |
| `SQUALL_NEWS_SEARCH` | on | `off` = Finnhub news only (instant revert) |
| `SQUALL_NEWS_MODEL` | `openai/gpt-6-luna` | The search-and-digest call. Charged `COST.news` (3 credits) per real search |
| `SQUALL_NEWS_ENGINE` | `exa` | Exa returns its results as citations, which grounding needs. Native OpenAI search returned none for JSON output. `auto` = OpenRouter picks |
| `SQUALL_NEWS_TIMEOUT_MS` / `_CACHE_TTL_MS` | 45000 / 1800000 | Timeout is the longest the dashboard waits after the scrape |
| `SQUALL_NEWS_MAX_RESULTS` / `_MAX_ITEMS` / `_LOOKBACK_DAYS` | 20 / 8 / 45 | Hits **per search** (two searches run), items kept for the prompt, window. Exa: $0.007/search incl. 10 hits, +$0.001 per extra hit |
| `SQUALL_NEWS_EXCLUDE_DOMAINS` | built-in list | Comma list the search skips (`DEFAULT_EXCLUDE_DOMAINS`); `none` clears it |
| `FINNHUB_API_KEY` | — | Quotes, profile, metrics, fallback news, `/quotes` |
| `FMP_API_KEY` | — | Optional cross-checks |
| `SEC_USER_AGENT` | built-in | EDGAR requires a real UA |
| `PORT`, `PYTHON_BIN` | 3000, `python3` | |
| `SQUALL_STATS_KEY` | unset | Unset means `/stats` 404s |
| `SQUALL_ACCOUNTS` | on | `off` = accounts hidden and routes off (instant revert) |
| `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SQUALL_SESSION_SECRET` | — | All four required for accounts. `DATABASE_URL` is a Railway reference to the Postgres service |
| `SQUALL_PUBLIC_URL` | `https://squall.up.railway.app` deployed, `http://localhost:PORT` locally | Builds the OAuth redirect URI and the allowed `Origin` |
| `SQUALL_AUTH_IP_HOURLY` / `SQUALL_SYNC_WRITES_PER_MIN` | 20 / 120 | Sign-in starts per IP; sync writes per user |
| `SQUALL_SYNC_ITEM_MAX_BYTES` / `_USER_MAX_BYTES` | 2097152 / 26214400 | Per item / per account (413 `too_large` / `quota`) |
| `SQUALL_GLOBAL_AI_DAILY` | 1500 | ≈150 analyses/day. **This is the real spend bound** |
| `SQUALL_GLOBAL_SCRAPE_DAILY` / `_SCREEN_DAILY` | 600 / 200 | |
| `SQUALL_IP_HOURLY` / `_DAILY` / `_ANALYZE_DAILY` | 45 / 120 / 60 | The anti-abuse dial. Lower these first |
| `SQUALL_MAX_PY` / `SQUALL_MAX_QUEUE` | 3 / 10 | `MAX_PY` sets the upstream request rate |
| `SQUALL_SCRAPER_TIMEOUT_MS` / `SQUALL_SCREENER_TIMEOUT_MS` | 180000 / 240000 | |
| `SQUALL_QUOTE_TTL_MS` / `_UPSTREAM_PER_MIN` / `_IP_PER_MIN` / `_MAX_SYMBOLS` | 60000 / 30 / 6 / 25 | `/quotes` |
| `SQUALL_SEC_RATE_PER_PROC` / `SQUALL_SEC_MAX_FILING_FETCHES` | 3.0 / 40 | Provider standing |
| `SQUALL_SEC_TICKERS_CACHE` / `_TTL` | 7 days | |
| `SCREENER_RETRY_BUDGET` / `SCREENER_THROTTLE_BACKOFF` | 60 / 5s | |
| `SQUALL_ANALYSIS_CACHE_TTL_MS` / `_MAX` | 300000 / 60 | |
| `SQUALL_STATE_PATH`, `SQUALL_TRUST_PROXY`, `SQUALL_CLIENT_IP_HEADER` | | Limiter state and proxy handling |
| `SQUALL_BT_*` (`REVIEW`, `MAX_REVIEWS`, `BREACH_TOLERANCE`, `TOLERANCE_MAX_STOP`, `EXIT_MODE`) | | Legacy replay experiments only. Not used by v2 |
| `SQUALL_*_PATH` (scraper/screener/backtester) | unset | Testing stubs only |
