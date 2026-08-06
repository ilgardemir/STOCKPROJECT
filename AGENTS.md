# AGENTS.md

Guidance for coding agents working in this repo. **Codex reads this file** (`AGENTS.md` at the repo root is Codex's convention), so the Codex-specific working protocol below is normative, not advisory.

Architecture, commands, environment variables and conventions live in **[CLAUDE.md](./CLAUDE.md)** — the single source of truth. It is named for Claude Code but its contents are tool-agnostic and apply equally here. Read it before making changes.

---

## Working protocol — Codex

Two collaborators and an auto-deploying Railway environment share this repo, so a stale clone is a real hazard rather than a theoretical one.

### 1. Pull before you touch anything

Start every session — and every task within a session that follows a gap — with:

```bash
git pull
```

If the pull brings in commits, **read what changed before planning your work** (`git log --oneline -15`, `git diff HEAD@{1}..HEAD --stat`). The UI in particular has been through a full design-system migration; assumptions from an older clone will be wrong.

If `git pull` reports a conflict or a diverged branch, stop and tell the user. Do not force, rebase over, or discard the other side's work.

### 2. Describe the change before you make it

**Do not edit files first and summarize afterwards.** Before any change, tell the user:

- **What you're going to change** — which files, and what specifically in them.
- **Why** — the reasoning, and the alternative you rejected if there was a real choice.
- **What it affects** — the blast radius. Which surfaces, which other files, whether it touches a cross-file contract (see CLAUDE.md's "Conventions & gotchas"), and whether it needs a deploy to verify.
- **Anything you're unsure about** — say so plainly rather than picking silently.

Then make the change. For a multi-step task, describe the whole plan up front rather than narrating step by step after the fact.

The point is that the user can redirect you *before* the work exists, not after.

### 3. Commit and push each completed change

Descriptive message, direct to `main` is fine. Prompt pushes keep both clones and the Railway deploy in sync. Don't batch several unrelated changes into one commit.

---

## Quick reference

Squall has two engines: a **single-ticker analyzer** (`scraperFinal.py`) and a **natural-language multi-index screener** (`screener.py`) covering the S&P 500, Nasdaq-100, and Dow 30. Both are Python subprocesses that emit JSON on stdout and progress on stderr; `server.js` orchestrates them and layers OpenRouter LLM calls on top. The frontend is a vanilla SPA — `index.html` (markup + all CSS) and `app.js` (all behavior).

```bash
node server.js                 # run UI + API on PORT (default 3000)
python3 scraperFinal.py AAPL   # analyzer standalone — ticker or company name; prints JSON payload
# screener standalone — reads a job on stdin, prints results to stdout:
echo '{"tickers":["AAPL","MSFT"],"names":{},"spec":{"concepts":[{"id":"momentum","weight":1}]}}' | python3 screener.py
pip3 install -r requirements.txt
```

**There is no test suite, linter, or build step.** "Testing" a change means running an engine standalone, hitting the running server, and — for anything visual — measuring the live DOM rather than trusting the source.

Two things that bite hardest:

- **Cross-file contracts.** SSE event names between `server.js` and `app.js`; the screener concept vocabulary duplicated across `server.js`/`screener.py`/`app.js`; the two separate progress protocols. CLAUDE.md documents each.
- **The design system.** All styling flows through CSS custom properties in `index.html`'s `:root` block — two type registers (mono for instrument, serif for document), color *roles* rather than color names, exactly one accent, a 10px type floor. `app.js` also reads these tokens at runtime via `cssVar()` and inline styles, so renaming one means grepping both files. See CLAUDE.md's "The design system" section before any visual change.

Verification that needs Python or the API keys must happen on **https://squall.up.railway.app** (auto-deploys from `main`). A local `node server.js` serves the UI fine without Python, but every analysis fails with "Script produced no output."
