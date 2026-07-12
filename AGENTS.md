# AGENTS.md

This project's agent/contributor guidance lives in **[CLAUDE.md](./CLAUDE.md)** — it is the single source of truth for architecture, commands, environment variables, and conventions. Read it before making changes.

CLAUDE.md is named for Claude Code but its contents are tool-agnostic; everything there applies equally when working via Codex or any other assistant.

## Quick reference

```bash
node server.js                 # run UI + API on PORT (default 3000)
python3 scraperFinal.py AAPL   # run the scraper standalone, prints JSON payload
pip3 install -r requirements.txt
```

There is no test suite, linter, or build step — "testing" a change means running the scraper on a ticker and/or hitting the running server. See CLAUDE.md for the full picture.

## Workflow note

Commit and push each completed change (descriptive message, direct to `main` is fine) so both collaborators' clones and the Railway deploy stay in sync.
