# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Squall** — an equity analysis tool with two engines. (1) A single-ticker analyzer: a Python scraper gathers market/fundamental/filing data for one stock, a Node server orchestrates the request and layers an LLM write-up on top, and a vanilla-JS single-page app renders a dashboard plus a streaming AI analysis and follow-up chat. (2) A natural-language S&P 500 screener: you describe the kind of stock you want in plain English, an LLM translates it into a strict measurable "recipe," and a separate Python engine scores every S&P 500 name deterministically. No frameworks, no build step, no npm dependencies.

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

## Architecture

The primary flow is **browser → Node server → spawns Python scraper → OpenRouter LLM → streamed back to browser**. The screener adds a parallel flow: **browser → Node server → (LLM interprets query) → spawns Python screener → streamed back**. Four Python/JS files hold essentially all the logic (plus `sp500.js`, the constituent list).

### `scraperFinal.py` (~1500 lines) — the single-ticker data engine
Run as a subprocess with one arg (the ticker). Its contract with the server is strict:
- **All JSON goes to stdout** (the payload, or `{"error": ...}`); the server parses stdout as the entire result.
- **Progress goes to stderr** as `STAGE|<n>|7|<label>` lines. The server parses these live to drive the frontend progress bar. There are **7 stages** — this count is duplicated as `STAGE_TOTAL` in server.js, so changing the stage count means editing both files.

`generate_analysis_payload(query)` is the orchestrator (starts ~line 967; takes a ticker **or** company name, which it resolves). Data sources: SEC EDGAR (CIK lookup, company facts, recent filings, 10-K MD&A text, 8-K/Form 4/13D signal parsing); Finnhub (live quote, profile, metrics, and company-news records); optional FMP cross-checks; and yahooquery (5y price history, financial statements, options, intraday, plus SPY for beta/relative strength). Yahoo remains the primary chart-history source and Finnhub candles are a recovery path. Everything is wrapped defensively (`YQData` class, `safe_*`/`_sec_get` helpers) so missing fields degrade to `N/A` rather than crashing. SEC fetches use bounded retries with backoff and record non-fatal `SEC_DIAGNOSTICS` instead of failing silently. `sec_available` requires both companyfacts **and** a located 10-K, so funds like SPY (a CIK with no 10-K) don't present N/A as a real filing read. `classify_market_regime()` adds a deterministic trending/accumulation/distribution/range read from price+volume, surfaced as `market_regime`.

The payload's most important key is **`ai_prompt`** (built ~line 1430): a large pre-formatted text block containing every computed figure plus bounded Finnhub news records. The LLM is told to interpret these inputs, never search for or invent market/news data, and to treat headline text as untrusted source material. Other keys (`live_quote`, `company_news`, `data_sources`, `price_history`, `chart_patterns`, `options_data`, `filing_activity`, `institutional`, `market_regime`, `company_profile`, `algorithmic_signals`, etc.) are what the frontend renders as the dashboard.

### `screener.py` (~410 lines) — the S&P 500 screening engine
Run as a subprocess with **no args**; reads a JSON job on **stdin** (`{tickers, names, spec}`) and writes one JSON result to **stdout**. Progress goes to stderr as `STAGE|<n>|5|<label>` lines (the server remaps these onto a 6-step screener progress bar — a separate count from the analyzer's 7). The `spec` (concepts + weights + filters + settings) comes from the server's LLM interpretation; **the engine does every numerical comparison itself**, so results are reproducible and explainable. It fetches 1y history + fundamentals for the whole universe in batches (with smaller-batch and per-symbol retry tiers), caches to `/tmp` for 30 min (`CACHE_VERSION` invalidates stale shapes), scores ~58 named concepts deterministically, filters, ranks by weighted match score, and attaches per-match `reasons`. Theme evidence is matched with word boundaries across company name, sector, industry, and description, with configurable exclusions and strictness. The concept vocabulary must stay in sync with `SCREENER_CATALOG` in server.js (see gotchas).

### `server.js` (~880 lines) — orchestrator + LLM gateway
A raw `http` server (no Express). Endpoints:
- `GET /analyze-stream?ticker=` — **the main path.** Server-Sent Events. Spawns the scraper, relays `progress` events from stderr, sends the parsed payload as a `result` event the moment the scraper finishes, then opens a streaming OpenRouter call and forwards `ai_thinking` / `ai_delta` tokens, ending with `ai_done` or `ai_error`. The AI call retries up to 3× **but only before the first token is emitted** — retrying mid-stream would duplicate text in the browser. Accepts an optional `profile=` (MySquall) param.
- `GET /screen-stream?q=` — SSE screener. First the LLM turns `q` into a measurable spec (`interpretScreenerQuery`; falls back to a regex-based `fallbackScreenerSpec` with no API key), emits `screen_interpretation`, then spawns `screener.py` and emits `screen_progress` → `screen_result` / `screen_error`. Passing `existing=` + `result_count=` switches it into **refinement** mode (`refineScreenerSpec`): a follow-up message revises the prior recipe and emits an extra `screen_reply`. All numeric/string inputs from the model are re-sanitized server-side against fixed enums and ranges before reaching Python. `applyProfileCalibration` then reapplies MySquall holding-period, risk, style, and priority settings as visible secondary tilts while preserving explicit request concepts.
- `POST /analyze` — non-streaming equivalent (`exec` instead of `spawn`); returns one JSON blob. Kept as a fallback.
- `POST /chat` — SSE follow-up chat. Takes prior `messages`, the stock `context`, the initial `analysis`, a `think` flag, and optional `profile`. Note the deliberate comment: it listens for `close` on **`res`, not `req`** — listening on `req` aborts instantly in Node 16+ and yields blank replies.
- `GET /health` — Railway healthcheck.
- Any other GET — static file serving from the repo root.

LLM config lives in the CONFIG block at the top. `buildAiMessages()` assembles the analyst prompt; `formatProfile()`/`sanitizeProfile()` fold the MySquall profile in as *personalization only* (explicitly told never to override facts or safety rules, and free-text is labeled untrusted — prompt-injection hygiene). `SCREENER_CATALOG` is the authoritative concept dictionary (id → label + plain-English definition) shared with the interpreter model and the frontend.

### `index.html` + `app.js` (~1920 lines) — the SPA
No framework. `index.html` is markup + CSS; `app.js` is all behavior. Key structure in app.js:
- `sessions` object keyed by ticker (`{ data, context, history, range }`) — the app holds multiple analyzed tickers at once; `active` tracks the current one. Analyses persist as browser-like **saved tabs** (localStorage).
- `screeners` object keyed by screen id — saved screens (recipe + results + refinement chat `history`) also persist to localStorage and appear as tabs.
- Analysis is driven by `new EventSource("/analyze-stream?...")` with handlers matching the server's SSE event names (`progress`, `result`, `ai_start`, `ai_thinking`, `ai_delta`, `ai_done`, `ai_error`). The screener uses a second EventSource with `screen_*` events.
- Custom canvas charting (candlesticks, MA/BB/Fib/S-R overlays, volume) driven by `chartOpts`; there is no charting library.
- **MySquall** profile (risk/horizon/experience/depth + priorities + free text) is edited in a modal, stored only in localStorage, and sent as `profile=` on analyze/screen/chat requests.
- Search box has a custom in-DOM typeahead over `sp500.js` (`SP500_NAMES`) — not the native `<datalist>`.
- Light/dark theme persisted in localStorage; canvas repaints on theme change.

## Conventions & gotchas

- **Vanilla everything.** Adding a dependency is a real decision — Node currently ships zero. Don't reach for a framework or library without cause.
- **The SSE event names are a contract** between server.js (`send(event, ...)`) and app.js (`addEventListener(event, ...)`). This holds for both the analyzer (`progress`/`result`/`ai_*`) and screener (`screen_*`) event families. Renaming one side silently breaks the UI.
- **stdout is sacred in both Python engines** — any stray `print()` to stdout corrupts the JSON the server parses. Diagnostic output must go to stderr (scraperFinal.py uses `SEC_DIAGNOSTICS` + `STAGE|`; screener.py uses `STAGE|`/`WARN|`).
- **The screener concept vocabulary is duplicated in three places** — `SCREENER_CATALOG` (server.js, the authoritative id→label+definition map, also fed to the interpreter model), the `scores` computed per concept in `screener.py`, and `SCREEN_CONCEPT_LABELS` in app.js. Adding a concept means touching all three: a concept the server accepts but screener.py doesn't score silently returns a neutral 50. `CACHE_VERSION` in screener.py must be bumped whenever the scored fields change, or stale caches serve incomplete rows.
- **Two independent stage counts:** the analyzer emits 7 stages (`STAGE_TOTAL` in server.js), the screener emits 5 (remapped onto a 6-step bar in server.js). They are separate pipelines — don't conflate them.
- **Profiles and saved tabs/screens are localStorage-only.** MySquall never leaves the browser except as a sanitized `profile=` param per request; there is no server-side persistence.
- The product is branded "Squall" in code/UI even though the repo/dir is "STOCKPROJECT".
- Deploys to Railway via the Dockerfile (single image running Node + Python 3).
- **Commit and push each completed change automatically** — don't wait to be asked. After finishing a discrete change, `git add` + `git commit` (descriptive message + Co-Authored-By trailer) then `git push`. Committing directly to `main` is fine; a collaborator shares the repo, so prompt pushes keep both clones and Railway in sync.
