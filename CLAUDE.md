# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Squall** — an equity analysis tool with two engines. (1) A single-ticker analyzer: a Python scraper gathers market/fundamental/filing data for one stock, a Node server orchestrates the request and layers an LLM write-up on top, and a vanilla-JS single-page app renders a dashboard plus a streaming AI analysis and follow-up chat. (2) A natural-language multi-index screener: you describe the kind of company or chart setup you want in plain English, an LLM translates it into a strict measurable "recipe," and a separate Python engine scores a selected S&P 500, Nasdaq-100, Dow 30, or combined universe deterministically. No frameworks, no build step, no npm dependencies.

## Commands

```bash
# Run the whole app locally (serves UI + API on PORT, default 3000)
node server.js                 # → http://0.0.0.0:3000

# Run the scraper standalone — prints the full JSON payload to stdout.
# This is the primary way to debug/inspect data without the AI layer.
python3 scraperFinal.py AAPL   # any ticker; defaults to AAPL if omitted

# Run the screener engine standalone — reads a JSON job on stdin, prints results to stdout.
# echo '{"tickers":["AAPL","MSFT"],"names":{},"spec":{"concepts":[{"id":"momentum","weight":1}]}}' | python3 screener.py
# Env knobs: SCREENER_LIMIT=N (cap universe for a fast test), SCREENER_CACHE_TTL, SCREENER_CACHE_PATH.

# Install Python deps (no lockfile; Node has zero deps so no npm install needed)
pip3 install -r requirements.txt

# Container build (matches Railway deploy)
docker build -t squall .
```

There is no test suite, linter, or build step. "Testing" a change means running the scraper on a ticker and/or hitting the running server.

## Environment variables

- `OPENROUTER_API_KEY` — **required** for any AI output; server.js falls back to a placeholder that will fail. All LLM calls go through OpenRouter (`openrouter.ai/api/v1/chat/completions`).
- `FINNHUB_API_KEY` — recommended; supplies live quotes, company profiles, basic metrics, and dated company-news records. Without it, the analyzer continues with Yahoo/SEC data but does not show company news.
- `FMP_API_KEY` — optional; enables Financial Modeling Prep cross-check data in the scraper.
- `SEC_USER_AGENT` — sent to SEC EDGAR; defaults to a hardcoded string with a contact email (EDGAR requires a real UA).
- `PORT` — injected by Railway at runtime; defaults to 3000.
- `PYTHON_BIN` — python executable name; defaults to `python3`.
- `SQUALL_STATS_KEY` — enables `GET /stats?key=…`. **Unset means the route 404s**, so leaving it unset is a safe default, not a broken one.
- Abuse limits — every knob in the `LIM` block at the top of server.js reads an env var, so limits retune from the Railway dashboard without a code deploy. The ones worth knowing: `SQUALL_GLOBAL_AI_DAILY` (weighted AI credits/day, default 1500), `SQUALL_GLOBAL_SCRAPE_DAILY` (300), `SQUALL_GLOBAL_SCREEN_DAILY` (120), `SQUALL_IP_DAILY` (60), `SQUALL_IP_ANALYZE_DAILY` (25), `SQUALL_MAX_PY` (2), `SQUALL_STATE_PATH`, `SQUALL_TRUST_PROXY`, `SQUALL_CLIENT_IP_HEADER`.
- `SQUALL_SCRAPER_PATH` / `SQUALL_SCREENER_PATH` — override the engine scripts. **Testing only** — they exist so the engines can be stubbed to exercise server behavior on a box without Python. Production leaves both unset.

## Architecture

The primary flow is **browser → Node server → spawns Python scraper → OpenRouter LLM → streamed back to browser**. The screener adds a parallel flow: **browser → Node server → (LLM interprets query) → spawns Python screener → streamed back**. Four Python/JS files hold essentially all the logic, with `sp500.js` and `market-universes.js` providing index constituents.

### `scraperFinal.py` (~1500 lines) — the single-ticker data engine
Run as a subprocess with one arg (the ticker). Its contract with the server is strict:
- **All JSON goes to stdout** (the payload, or `{"error": ...}`); the server parses stdout as the entire result.
- **Progress goes to stderr** as `STAGE|<n>|7|<label>` lines. The server parses these live to drive the frontend progress bar. There are **7 stages** — this count is duplicated as `STAGE_TOTAL` in server.js, so changing the stage count means editing both files.

`generate_analysis_payload(query)` is the orchestrator (starts ~line 967; takes a ticker **or** company name, which it resolves). Data sources: SEC EDGAR (CIK lookup, company facts, recent filings, 10-K MD&A text, 8-K/Form 4/13D signal parsing); Finnhub (live quote, profile, metrics, and company-news records); optional FMP cross-checks; and yahooquery (5y price history, financial statements, options, intraday, plus SPY for beta/relative strength). Yahoo remains the primary chart-history source and Finnhub candles are a recovery path. Everything is wrapped defensively (`YQData` class, `safe_*`/`_sec_get` helpers) so missing fields degrade to `N/A` rather than crashing. SEC fetches use bounded retries with backoff and record non-fatal `SEC_DIAGNOSTICS` instead of failing silently. `sec_available` requires both companyfacts **and** a located 10-K, so funds like SPY (a CIK with no 10-K) don't present N/A as a real filing read. `classify_market_regime()` adds a deterministic trending/accumulation/distribution/range read from price+volume, surfaced as `market_regime`.

The payload's most important key is **`ai_prompt`** (built ~line 1430): a large pre-formatted text block containing every computed figure plus bounded Finnhub news records. The LLM is told to interpret these inputs, never search for or invent market/news data, and to treat headline text as untrusted source material. Other keys (`live_quote`, `company_news`, `data_sources`, `price_history`, `chart_patterns`, `options_data`, `filing_activity`, `institutional`, `market_regime`, `company_profile`, `algorithmic_signals`, etc.) are what the frontend renders as the dashboard.

### `screener.py` — the multi-index screening engine
Run as a subprocess with **no args**; reads a JSON job on **stdin** (`{tickers, names, memberships, universe_id, universe_label, spec}`) and writes one JSON result to **stdout**. Determinate progress goes to stderr as `PROGRESS|<percent>|<label>` lines; `STAGE|` remains for diagnostic compatibility. The `spec` (concepts + weights + filters + settings) comes from the server's LLM interpretation; **the engine does every numerical comparison itself**, so results are reproducible and explainable. It fetches 1y history + fundamentals for the selected universe in batches (with smaller-batch and per-symbol retry tiers), caches to `/tmp` for 30 min (`CACHE_VERSION` invalidates stale shapes), scores the shared concept vocabulary deterministically, filters, ranks by weighted match score, and attaches per-match `reasons`. Pattern scores such as VCP, cup with handle, flat base, double bottom, and bull flag are candidate detectors with visible measurements rather than definitive classifications. Theme evidence is matched with word boundaries across company name, sector, industry, and description, with configurable exclusions and strictness. The concept vocabulary must stay in sync with `SCREENER_CATALOG` in server.js (see gotchas).

### `server.js` (~880 lines) — orchestrator + LLM gateway
A raw `http` server (no Express). Endpoints:
- `GET /analyze-stream?ticker=` — **the main path.** Server-Sent Events. Spawns the scraper, relays `progress` events from stderr, sends the parsed payload as a `result` event the moment the scraper finishes, then opens a streaming OpenRouter call and forwards `ai_thinking` / `ai_delta` tokens, ending with `ai_done` or `ai_error`. The AI call retries up to 3× **but only before the first token is emitted** — retrying mid-stream would duplicate text in the browser. Accepts an optional `profile=` (MySquall) param.
- `GET /screen-stream?q=&universe=` — SSE screener. `universe` accepts `combined`, `sp500`, `nasdaq100`, or `dow30`. First the LLM turns `q` into a measurable spec (`interpretScreenerQuery`; falls back to a regex-based `fallbackScreenerSpec` with no API key), emits `screen_interpretation`, then spawns `screener.py` and emits determinate `screen_progress` percentages → `screen_result` / `screen_error`. Passing `existing=` + `result_count=` switches it into **refinement** mode (`refineScreenerSpec`): a follow-up message revises the prior recipe and emits an extra `screen_reply`. All numeric/string inputs from the model are re-sanitized server-side against fixed enums and ranges before reaching Python. `applyProfileCalibration` then reapplies MySquall holding-period, risk, style, and priority settings as visible secondary tilts while preserving explicit request concepts.
- `POST /analyze` — non-streaming equivalent (`exec` instead of `spawn`); returns one JSON blob. Kept as a fallback.
- `POST /chat` — SSE follow-up chat. Takes prior `messages`, the stock `context`, the initial `analysis`, a `think` flag, and optional `profile`. Note the deliberate comment: it listens for `close` on **`res`, not `req`** — listening on `req` aborts instantly in Node 16+ and yields blank replies.
- `GET /health` — Railway healthcheck. Deliberately dumb and deliberately unchanged: it is public, so it must never leak remaining budget.
- `GET /stats?key=` — owner-only spend snapshot (see Abuse limits). Fails closed: 404s unless `SQUALL_STATS_KEY` is set and matches.
- Any other GET — static file serving from the repo root.

#### Abuse limits

The site is public and anonymous, and every cost path spends real OpenRouter/Finnhub credit plus a Python subprocess. The `// ─── ABUSE LIMITS ───` section (between `serveStatic` and `http.createServer`) exists to make worst-case daily spend a number you choose. It is deliberately invisible to a normal visitor — no captcha, no login.

- **Four gates, called explicitly.** `admit(req, kind)` runs at the top of `/screen-stream`, `/analyze-stream`, `POST /analyze`, and `POST /chat` — **not** at the top of the request handler. Static files fall through the catch-all `GET`, so a blanket gate would throttle page loads (one page view is 5+ requests). `/health` and `serveStatic` are exempt *by construction* because they never reach a gate; there is no allowlist to keep in sync.
- **Two budgets, spent at different times.** `admit()` charges per-client burst/hourly/daily counters plus the global scrape/screen ceilings *before any work*, because a client that opens an SSE stream and aborts has already cost a subprocess. `spendAi()` charges the global AI budget *immediately before the first OpenRouter call* — on `/analyze-stream` that is deliberately **after** `send("result")`, which is the whole trick behind data-only degradation. Charge once per logical request, never per attempt: the analyzer's retry loop is 3 HTTP calls for one analysis. **There is no refund path, on purpose** — spending after the point of no return means there is nothing to refund, and adding one only introduces double-counting.
- **Degradation, not failure.** Out of AI budget, the analyzer still scrapes and still renders every number and emits `ai_error` with `limited:true`; the screener falls back to its deterministic rule-based recipe builder and still returns scored results; chat refuses honestly with a 503 (it has no data-only equivalent). The scrape ceiling is separate and tighter than the AI one, because it protects Finnhub quota and — harder to undo — the deployment IP's standing with Yahoo/SEC.
- **Client identity is IP-only**, because `EventSource` cannot send custom headers. Forwarding headers are consulted **only when the TCP peer is itself private**, i.e. when something actually terminated the connection in front of us; directly exposed, every `x-forwarded-for` is attacker-controlled noise and is ignored. Behind a proxy we take the **rightmost** public entry (what the edge appended from the real peer), never the leftmost (what the client typed). IPv6 keys bucket to **/64** — per-address counting would hand one attacker 2^64 free buckets.
- **State is in-memory with a temp-dir mirror** (`os.tmpdir()`, not a hardcoded `/tmp` — the latter breaks local verification on Windows). It survives a crash-restart inside a deploy; surviving a redeploy is explicitly not a goal. Only daily counts are restored, never burst tokens or hourly counts — restoring those would punish users for our crash. Written temp+rename so a kill mid-write can't leave truncated JSON.
- **Subprocess concurrency is a bounded queue**, not a reject: two run, four wait, past that it's a 503. Queued SSE clients get a position tick every 5s, which is **not cosmetic** — app.js keeps the analyze button disabled until a terminal event arrives, so a silent wait reads as a hang.

LLM config lives in the CONFIG block at the top. `buildAiMessages()` assembles the analyst prompt; `formatProfile()`/`sanitizeProfile()` fold the MySquall profile in as *personalization only* (explicitly told never to override facts or safety rules, and free-text is labeled untrusted — prompt-injection hygiene). `SCREENER_CATALOG` is the authoritative concept dictionary (id → label + plain-English definition) shared with the interpreter model and the frontend.

### `index.html` + `app.js` (~2300 lines) — the SPA
No framework. `index.html` is markup + CSS; `app.js` is all behavior. Key structure in app.js:
- `sessions` object keyed by ticker (`{ data, context, history, range }`) — the app holds multiple analyzed tickers at once; `active` tracks the current one. Analyses persist as browser-like **saved tabs** (localStorage).
- `screeners` object keyed by screen id — saved screens (recipe + results + refinement chat `history`) also persist to localStorage and appear as tabs.
- Analysis is driven by `new EventSource("/analyze-stream?...")` with handlers matching the server's SSE event names (`progress`, `result`, `ai_start`, `ai_thinking`, `ai_delta`, `ai_done`, `ai_error`). The screener uses a second EventSource with `screen_*` events.
- Custom canvas charting (candlesticks, MA/BB/Fib/S-R overlays, volume) driven by `chartOpts`; there is no charting library.
- **MySquall** profile (risk/horizon/experience/depth + priorities + free text) is edited in a modal, stored only in localStorage, and sent as `profile=` on analyze/screen/chat requests.
- Search box has a custom in-DOM typeahead over the combined names from `sp500.js` and `market-universes.js` — not the native `<datalist>`.
- **Six themes**, picked from a menu behind the palette button and persisted in localStorage. The `THEMES` table in app.js (`{id, label, note, mode, bg, accent}`) drives the menu: `dark` (Midnight), `light` (Daylight), `noir`, `paper`, `lagoon`, `matrix` (Terminal). `applyTheme()` sets `data-theme` **and** `data-mode` on `<html>`; canvas code keys off `data-mode` (light/dark), never `data-theme`, and repaints via the `squall:theme` CustomEvent.

### The design system

The UI follows a written design direction — **"precision instrument"**: terminal lineage, dense, information-first, minimal chrome, decoration is suspect. The spec is `docs/superpowers/specs/2026-08-04-ui-precision-instrument-design.md` and it is worth reading before any visual change, because most of the rules below exist to serve it and are easy to undo by accident.

**All styling goes through tokens in the `:root` block of `index.html`.** Do not introduce literal colors, font families, or font sizes in a rule.

- **Two type registers, no display face.** `--mono` (IBM Plex Mono) is the instrument: data, labels, chrome, wordmark, card headers. `--doc` (Newsreader, a serif) is the document: AI prose, MD&A excerpts, learn-notes, recipe definitions, chat. The dividing line is *measurement vs. explanation*, not pane position. Size scale: `--t-micro` 10px → `--t-data` 12 → `--t-body` 13 → `--t-lead` 15 → `--t-doc` 16 → `--t-doc-h` 20 → `--t-title` 22. **10px is a hard floor — nothing renders smaller.**
- **Color roles, not color names.** Every theme block declares the same 13: `--chrome-0/1/2` (surfaces), `--rule` (hairlines), `--ink`/`--ink-dim`/`--ink-bright` (text), `--up`/`--down`/`--warn` plus their `-soft` tints (direction only), and `--accent`. Legacy names (`--bg`, `--surface`, `--text`, `--green`, `--violet`, …) are **deleted** — do not reintroduce them.
- **Exactly one accent.** `--violet` was removed precisely because it had become an unofficial second accent. When something needs to stand apart, use weight, a rule, or a neutral — not a new hue. Green and red are reserved for direction and mean nothing else.
- `--chrome-hi` is a *state* derived from `--chrome-2` toward `--ink`, not a fourth surface. It exists because collapsing the neutral ramp to three steps left hover states resolving to the same value as the surface beneath them. Use it for hover/active fills.
- **Metrics are tabular rows, not tiles** — `.mgrid` is `display: block` and `.metric` is a flex row with the value right-aligned on a shared axis, so values compare down a column. `metric(label, value, cls)` renders it. Below ~380px of pane, `syncMetricDensity()` adds `.stack-metrics` to stack label-over-value.
- **Cards are hairline-separated sections**, not panels: no background, no shadow, no radius, no icons. `card(id, title, bodyHtml, opts)` takes **four** arguments — there is no icon parameter.
- **Motion encodes state; it never announces arrival.** Progress fills, streaming carets, score-bar growth, count-ups, scroll reveals and theme crossfades stay. Entrance cascades, pop-ins and idle ambience were deliberately removed. The hero is exempt — it is not an instrument surface.

## Conventions & gotchas

- **Vanilla everything.** Adding a dependency is a real decision — Node currently ships zero. Don't reach for a framework or library without cause.
- **The SSE event names are a contract** between server.js (`send(event, ...)`) and app.js (`addEventListener(event, ...)`). This holds for both the analyzer (`progress`/`result`/`ai_*`) and screener (`screen_*`) event families. Renaming one side silently breaks the UI.
- **A limit on an SSE route is reported in-band at HTTP 200, never as a 429.** `EventSource` cannot read a non-200 body — per spec any other status fails the connection with `e.data === undefined`, which app.js renders as "Connection lost. Is the server running?", exactly the wrong message for a rate limit. The discriminator is a **`limited:true` field inside the existing `error`/`screen_error` payloads**, deliberately not a new event name. The POST routes *can* set a status, so they return a real 429/503 with a JSON body — and app.js must read that body rather than throwing on the bare status.
- **Release the concurrency slot exactly once, via the guarded closure `acquirePy` hands back.** `/analyze-stream` has three exit paths that can all fire for one request (`py` close, `py` error, `req` close). A double decrement drives the counter negative and silently uncaps concurrency for the life of the process — nothing will tell you.
- **`req` vs `res` for detecting a disconnect is not interchangeable.** On a POST, the request stream auto-destroys and emits `close` the instant its body is consumed (Node 16+), so anything waiting on `req.on("close")` there fires immediately: use `res`. On the SSE GETs, `req` is correct. `/chat` already documented this trap; `acquirePy` takes the abort source as an explicit argument for the same reason.
- **stdout is sacred in both Python engines** — any stray `print()` to stdout corrupts the JSON the server parses. Diagnostic output must go to stderr (scraperFinal.py uses `SEC_DIAGNOSTICS` + `STAGE|`; screener.py uses `PROGRESS|`/`STAGE|`/`WARN|`).
- **The screener concept vocabulary is duplicated in three places** — `SCREENER_CATALOG` (server.js, the authoritative id→label+definition map, also fed to the interpreter model), the `scores` computed per concept in `screener.py`, and `SCREEN_CONCEPT_LABELS` in app.js. Adding a concept means touching all three: a concept the server accepts but screener.py doesn't score silently returns a neutral 50. `CACHE_VERSION` in screener.py must be bumped whenever the scored fields change, or stale caches serve incomplete rows.
- **Progress protocols differ:** the analyzer emits 7 scraper stages (`STAGE_TOTAL` in server.js) and the browser maps those into the first portion of its full data/render/AI progress. The screener emits explicit 0–100 `PROGRESS|` values tied to completed data batches, scoring, and explanations.
- **Profiles and saved tabs/screens are localStorage-only.** MySquall never leaves the browser except as a sanitized `profile=` param per request; there is no server-side persistence.
- **`app.js` reads CSS tokens at runtime** — inline `style="…var(--ink-dim)…"` strings and, in the canvas code, `cssVar("--up")` / `cssVar("--chrome-1")`. Renaming or deleting a token means grepping **both** files, not just the stylesheet. A canvas that silently loses its colors is the failure mode; there is no error.
- **Verify styling by measuring the live DOM, not by reading the source.** There is no linter to catch a token that resolves to nothing. Cycle `document.documentElement.dataset.theme` over all six ids and read `getComputedStyle` — a `var()` pointing at a deleted token resolves to empty, the declaration is dropped, and the element silently inherits. Two checks worth repeating after any token change: every `var()` referenced in the stylesheet resolves in every theme, and no rendered element computes a font-size below 10px.
- **Check contrast against the surface an element actually sits on.** Cards are transparent, so card text resolves against `--chrome-0` (the page), while screener results sit on `--chrome-1`. Daylight silently fell under WCAG AA once when text moved from one to the other. When you change a surface or an ink value, re-measure both pairings across all six themes.
- **A "state" that resolves to the same color as its backdrop is invisible, and nothing will tell you.** This bit six separate hover/loading states at once when two neutral tokens were merged. After any surface change, confirm hover/active/focus fills still differ from what they sit on — Daylight is the worst case, where `--chrome-0` and `--chrome-2` are within ~1.2:1 and a background tint alone cannot carry an affordance.
- The product is branded "Squall" in code/UI even though the repo/dir is "STOCKPROJECT".
- Deploys to Railway via the Dockerfile (single image running Node + Python 3), auto-deploying from `main`. **Live at https://squall.up.railway.app** — this is the only environment guaranteed to have Python, the API keys, and the deps installed, so it's the place to verify anything that depends on the scraper or screener actually running. A local `node server.js` still serves the UI fine without Python, but every analysis will fail with "Script produced no output."
- **Commit and push each completed change automatically** — don't wait to be asked. After finishing a discrete change, `git add` + `git commit` (descriptive message + Co-Authored-By trailer) then `git push`. Committing directly to `main` is fine; a collaborator shares the repo, so prompt pushes keep both clones and Railway in sync.
