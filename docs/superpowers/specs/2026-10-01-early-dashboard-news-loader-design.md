# Early dashboard + news loader — design

Date: 2026-10-01 · Status: approved

## Problem

`/analyze-stream` holds the `result` event until the web-search news digest resolves
(up to `SQUALL_NEWS_TIMEOUT_MS`, 45 s). The dashboard does not need the digest; only
the written analysis does (prompt §14). Users wait on skeleton loaders for data that is
already in hand.

## Decision

Ship `result` the moment the scrape finishes, then a new `news` SSE event when the digest
resolves, then the AI stream. The News card shows a loading animation in the meantime.

**Governing rule: the News card only ever shows what the analysis model reads.** While
the search runs, no Finnhub headlines are shown. If the search falls back (off, failed,
timed out, nothing grounded, no budget), the model reads Finnhub §14, so the card shows
Finnhub.

Rejected: a separate `/news` route (a new costed, `admit()`-gated route plus a second
connection the AI stream must wait on); sending `result` twice (full re-render resets
scroll, chart, zoom).

## Server (`/analyze-stream`, cache-miss path only)

1. After the scraper payload parses cleanly:
   `send("result", { ...payload, model: AI_MODEL, news_pending: true })`.
   `news_pending` is set only when `newsSearchEnabled()`; otherwise the path behaves as
   today (Finnhub applied, no `news` event).
2. `await newsJob`, then `applyNewsDigest` + `newsSearchStatus` as today. If the client
   has gone (`res.writableEnded || res.destroyed`), stop.
3. `send("news", { company_news, news_digest, news_search, data_sources, ai_prompt })`
   — taken from the applied payload. On fallback `company_news`/`ai_prompt` are the
   unchanged Finnhub values and `news_digest` is absent/null.
4. `putCachedAnalysis(query, payload)` with the digest applied (unchanged invariant:
   a cache hit replays the same §14 the dashboard showed), then `streamAiAnalysis`.

Unchanged: cache hits (digest already applied, no `news_pending`), `POST /analyze`,
`/ilgar` (never uses news search). `news` is an added event name; no existing name changes.
`spendAi` for the analysis still happens inside `streamAiAnalysis`, after `news`.

## Client (`app.js`)

- **`result`**: render as today. If `data.news_pending`, the News card renders the
  loader instead of items (Finnhub records stay in `data` but are not shown). Progress:
  72 %, "Dashboard ready · gathering recent news".
- **`news`**: merge the five fields into `sess.data`, clear `news_pending`, set
  `sess.context = data.ai_prompt`, persist. If the ticker is active, re-render only the
  News card and the "Exact Data Sent to the AI" card in place (by card id); no
  `renderAll`. New items fade in (state change, so motion is permitted). Progress:
  "Preparing the written analysis".
- **Fallback**: if the stream drops after `result` but before `news`, or a persisted
  session is restored with `news_pending` set, clear the flag and render Finnhub. That
  matches the saved context (Finnhub §14), so the rule holds.
- `persistableSession` strips the flag, so a saved tab is always stored as the Finnhub
  state it holds and never restores as a loader.

## Loader (News card)

- Card header count slot reads "Searching".
- Body: the wind glyph running the existing `gust` animation (as `#genIndicator`), a mono
  label "Searching the web for recent news", and an elapsed-seconds counter (`12s`).
- Below it, three placeholder rows reusing `.news-item` with `.skeleton` bars (meta,
  headline ~70–85 %, two summary lines), shimmer staggered per row so it sweeps downward.
- Tokens and keyframes only; no new colours. `prefers-reduced-motion`: gust and shimmer
  stop, counter still ticks. The counter interval is cleared when the card is replaced or
  the session changes.

## Testing

- Server test with the stub scraper and a stubbed `getNewsDigest`: event order is
  `result` (`news_pending: true`) → `news` → `ai_*`; the cache entry carries the digest.
  Search-off path emits no `news_pending` and no `news`.
- `app.test.js` drives `runAnalysis` with a fake EventSource: loader shown (no Finnhub
  items) while pending, the flag never persisted, `news` swaps the card and context, a
  drop before `news` falls back to Finnhub. Pagecheck must still pass.
- Live DOM: loader contrast and layout in all six themes, 1280×720.

## Docs

Update CLAUDE.md (news §14 is no longer spliced "before `result` is sent"; add `news` to
the `/analyze-stream` event list) and the matching engineering-notes entry.
