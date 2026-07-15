# AGENTS.md

This project's agent/contributor guidance lives in **[CLAUDE.md](./CLAUDE.md)** — it is the single source of truth for architecture, commands, environment variables, and conventions. Read it before making changes.

CLAUDE.md is named for Claude Code but its contents are tool-agnostic; everything there applies equally when working via Codex or any other assistant.

## Quick reference

Squall has two engines: a **single-ticker analyzer** (`scraperFinal.py`) and a **natural-language S&P 500 screener** (`screener.py`). Both are Python subprocesses that emit JSON on stdout and progress on stderr; `server.js` orchestrates them and layers OpenRouter LLM calls on top.

```bash
node server.js                 # run UI + API on PORT (default 3000)
python3 scraperFinal.py AAPL   # analyzer standalone — ticker or company name; prints JSON payload
# screener standalone — reads a job on stdin, prints results to stdout:
echo '{"tickers":["AAPL","MSFT"],"names":{},"spec":{"concepts":[{"id":"momentum","weight":1}]}}' | python3 screener.py
pip3 install -r requirements.txt
```

There is no test suite, linter, or build step — "testing" a change means running an engine standalone and/or hitting the running server. **Watch the cross-file contracts** (SSE event names, the screener concept vocabulary duplicated across server.js/screener.py/app.js, and the two separate stage counts) — CLAUDE.md's "Conventions & gotchas" documents them. See CLAUDE.md for the full picture.

## Workflow note

Commit and push each completed change (descriptive message, direct to `main` is fine) so both collaborators' clones and the Railway deploy stay in sync.
