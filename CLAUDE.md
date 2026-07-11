# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Squall** — a single-ticker equity analysis tool. A Python scraper gathers market/fundamental/filing data for one stock, a Node server orchestrates the request and layers an LLM write-up on top, and a vanilla-JS single-page app renders a dashboard plus a streaming AI analysis and follow-up chat. No frameworks, no build step, no npm dependencies.

## Commands

```bash
# Run the whole app locally (serves UI + API on PORT, default 3000)
node server.js                 # → http://0.0.0.0:3000

# Run the scraper standalone — prints the full JSON payload to stdout.
# This is the primary way to debug/inspect data without the AI layer.
python3 scraperFinal.py AAPL   # any ticker; defaults to AAPL if omitted

# Install Python deps (no lockfile; Node has zero deps so no npm install needed)
pip3 install -r requirements.txt

# Container build (matches Railway deploy)
docker build -t squall .
```

There is no test suite, linter, or build step. "Testing" a change means running the scraper on a ticker and/or hitting the running server.

## Environment variables

- `OPENROUTER_API_KEY` — **required** for any AI output; server.js falls back to a placeholder that will fail. All LLM calls go through OpenRouter (`openrouter.ai/api/v1/chat/completions`).
- `FMP_API_KEY` — optional; enables Financial Modeling Prep cross-check data in the scraper.
- `SEC_USER_AGENT` — sent to SEC EDGAR; defaults to a hardcoded string with a contact email (EDGAR requires a real UA).
- `PORT` — injected by Railway at runtime; defaults to 3000.
- `PYTHON_BIN` — python executable name; defaults to `python3`.
- `WEB_RESEARCH` — gated by `RESEARCH_ON` in server.js, which is **currently hardcoded to `false`** (live web search stalls the AI stream). The env var is not read until that flag is re-enabled.

## Architecture

The request flow is **browser → Node server → spawns Python scraper → OpenRouter LLM → streamed back to browser**. Three files hold essentially all the logic:

### `scraperFinal.py` (~1160 lines) — the data engine
Run as a subprocess with one arg (the ticker). Its contract with the server is strict:
- **All JSON goes to stdout** (the payload, or `{"error": ...}`); the server parses stdout as the entire result.
- **Progress goes to stderr** as `STAGE|<n>|7|<label>` lines. The server parses these live to drive the frontend progress bar. There are **7 stages** — this count is duplicated as `STAGE_TOTAL` in server.js, so changing the stage count means editing both files.

`generate_analysis_payload(ticker)` is the orchestrator (starts ~line 651). Data sources, in order: SEC EDGAR (CIK lookup, company facts, recent filings, 10-K MD&A text, 8-K/Form 4/13D signal parsing) → optional FMP cross-check → yahooquery (5y price history, financial statements, options, intraday, also fetches SPY for beta/relative strength). Everything is wrapped defensively (`YQData` class, `safe_*` helpers) so missing fields degrade to `N/A` rather than crashing — a ticker with SEC data OR market data still produces a payload.

The payload's most important key is **`ai_prompt`** (built ~line 958): a large pre-formatted text block containing every computed figure. The LLM is told to interpret this, never to recompute or restate it. Other keys (`live_quote`, `price_history`, `chart_patterns`, `options_data`, `filing_activity`, `institutional`, `algorithmic_signals`, etc.) are what the frontend renders as the dashboard.

### `server.js` (~490 lines) — orchestrator + LLM gateway
A raw `http` server (no Express). Endpoints:
- `GET /analyze-stream?ticker=` — **the main path.** Server-Sent Events. Spawns the scraper, relays `progress` events from stderr, sends the parsed payload as a `result` event the moment the scraper finishes, then opens a streaming OpenRouter call and forwards `ai_thinking` / `ai_delta` tokens, ending with `ai_done` or `ai_error`. The AI call retries up to 3× **but only before the first token is emitted** — retrying mid-stream would duplicate text in the browser.
- `POST /analyze` — non-streaming equivalent (`exec` instead of `spawn`); returns one JSON blob. Kept as a fallback.
- `POST /chat` — SSE follow-up chat. Takes prior `messages`, the stock `context`, the initial `analysis`, and a `think` flag. Note the deliberate comment: it listens for `close` on **`res`, not `req`** — listening on `req` aborts instantly in Node 16+ and yields blank replies.
- `GET /health` — Railway healthcheck.
- Any other GET — static file serving from the repo root.

LLM config (model, reasoning effort, token caps, the analyst system prompt) lives in the CONFIG block and `buildAiMessages()` at the top of server.js.

### `index.html` + `app.js` (~1900 lines) — the SPA
No framework. `index.html` is markup + CSS; `app.js` is all behavior. Key structure in app.js:
- `sessions` object keyed by ticker (`{ data, context, history, range }`) — the app holds multiple analyzed tickers at once; `active` tracks the current one.
- Analysis is driven by `new EventSource("/analyze-stream?...")` (~line 126) with handlers matching the server's SSE event names (`progress`, `result`, `ai_start`, `ai_thinking`, `ai_delta`, `ai_done`, `ai_error`).
- Custom canvas charting (candlesticks, MA/BB/Fib/S-R overlays, volume) driven by `chartOpts`; there is no charting library.
- Light/dark theme persisted in localStorage; canvas repaints on theme change.

## Conventions & gotchas

- **Vanilla everything.** Adding a dependency is a real decision — Node currently ships zero. Don't reach for a framework or library without cause.
- **The SSE event names are a contract** between server.js (`send(event, ...)`) and app.js (`addEventListener(event, ...)`). Renaming one side silently breaks the UI.
- **stdout is sacred in the scraper** — any stray `print()` to stdout corrupts the JSON the server parses. Diagnostic output must go to stderr.
- The product is branded "Squall" in code/UI even though the repo/dir is "STOCKPROJECT".
- Deploys to Railway via the Dockerfile (single image running Node + Python 3).
