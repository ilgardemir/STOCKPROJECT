# Early Dashboard + News Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the dashboard the moment the scrape finishes; deliver the web-search news digest as a separate `news` SSE event, with an animated loader in the News card meanwhile.

**Architecture:** `/analyze-stream` (cache-miss path) sends `result` with `news_pending: true` when news search is enabled, awaits the digest, sends `news` (the five news-bearing fields), caches the digest-applied payload, then streams the AI. `app.js` renders a loader card while `news_pending`, and on `news` merges the fields and replaces only the News and Prompt cards in place.

**Tech Stack:** Node (raw `http`), vanilla browser JS, CSS tokens. Zero dependencies.

Spec: `docs/superpowers/specs/2026-10-01-early-dashboard-news-loader-design.md`

## Global Constraints

- The News card only ever shows what the analysis model reads. Finnhub records are never shown while a search is pending; they show on fallback.
- No new SSE event names other than `news`; no existing name changes.
- Cache hits, `POST /analyze`, `/ilgar` unchanged. The analysis cache entry always carries the digest-applied payload.
- All styling via existing tokens; no literal colours; 10px type floor; reduced motion honoured (global rule at `styles.css:125`).
- Never write a bare top-level `document.getElementById(x).addEventListener` in app.js.
- Per user memory: run the targeted test files + `node --check`, not full `npm test`. Commit and push each task.

---

### Task 1: Server — send `result` before the news search, then a `news` event

**Files:**
- Modify: `server.js:3453-3467` (the `py.on("close")` tail of `/analyze-stream`)
- Create: `tests/js/news-stream.test.js`
- Modify: `package.json` (`test` and `test:js` scripts: append `&& node tests/js/news-stream.test.js`)

**Interfaces:**
- Produces: SSE `result` payload gains `news_pending: true` (only when `newsSearchEnabled()`). New SSE event `news` with data `{ company_news, news_digest, news_search, data_sources, ai_prompt }` (`news_digest` is `null` on fallback). Sent before any `ai_*` event.

- [ ] **Step 1: Write the failing test** — `tests/js/news-stream.test.js`

```js
"use strict";
// Drives /analyze-stream end to end with the stub scraper, a fake news search and a fake
// model. Proves the dashboard ships before the search resolves, that `news` precedes the
// AI stream, that the model's prompt carries the digest, and that the cache keeps it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const ROOT = path.resolve(__dirname, "../..");
const serverPath = path.join(ROOT, "server.js");
const realRequire = createRequire(serverPath);

const DIGEST = {
  ok: true, model: "news-model", today: "2026-09-23", searchedAt: "2026-09-23T00:00:00Z", ms: 40, citations: 1,
  digest: { overview: "Q3 beat dominates.", upcoming: [], dropped: { ungrounded: 0, stale: 0, invalid: 0, duplicate: 0 },
    items: [{ date: "2026-09-18", source: "Reuters", url: "https://reuters.com/a", headline: "Acme beats Q3",
      event: "earnings", impact: "high", direction: "positive", summary: "Revenue up." }] }
};

function boot({ apiKey }) {
  let handler; const aiBodies = [];
  const newsMod = { ...realRequire("./news-research"),
    researchNews: () => new Promise(r => setTimeout(() => r(DIGEST), 40)) };
  const sandbox = {
    require: name => name === "http" ? { createServer(fn) { handler = fn; return {}; } }
      : name === "./news-research" ? newsMod : realRequire(name),
    module: { exports: {} }, __dirname: ROOT,
    process: { ...process, env: { ...process.env, OPENROUTER_API_KEY: apiKey, SQUALL_NEWS_SEARCH: "",
      PYTHON_BIN: process.execPath, SQUALL_SCRAPER_PATH: path.join(ROOT, "tests/stubs/scraper_stub.js"),
      SQUALL_STATE_PATH: path.join(os.tmpdir(), "squall-news-stream-test.json") } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, TextDecoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (_url, init) => {
      aiBodies.push(String(init && init.body));
      return { ok: true, body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n');
        yield Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      })() };
    }
  };
  vm.runInNewContext(fs.readFileSync(serverPath, "utf8"), sandbox, { filename: serverPath });
  return { handler, aiBodies };
}

async function drive(handler, route) {
  let output = "", finish;
  const ended = new Promise(r => { finish = r; });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: route,
    headers: { host: "localhost" }, socket: { remoteAddress: "127.0.0.1" } });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
    writeHead() {}, setHeader() {}, write(t) { output += t; return true; },
    end(t = "") { output += t; this.writableEnded = true; finish(); } });
  await handler(req, res);
  let timer;
  try { await Promise.race([ended, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("stream did not finish")), 10000); })]); }
  finally { clearTimeout(timer); }
  return output.split("\n\n").filter(Boolean).map(block => {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return { name, data: data ? JSON.parse(data) : null };
  }).filter(e => e.name);
}

(async () => {
  {
    const { handler, aiBodies } = boot({ apiKey: "test-key" });
    const ev = await drive(handler, "/analyze-stream?ticker=AAA");
    const names = ev.map(e => e.name);
    const iResult = names.indexOf("result"), iNews = names.indexOf("news");
    const iAi = names.findIndex(n => n.startsWith("ai_"));
    assert.ok(iResult >= 0 && iNews > iResult && iAi > iNews, `order was ${names.join(",")}`);
    const result = ev[iResult].data, news = ev[iNews].data;
    assert.equal(result.news_pending, true);
    assert.equal(result.news_digest, undefined, "the digest must not ride on result");
    assert.equal(news.news_digest.overview, "Q3 beat dominates.");
    assert.equal(news.company_news[0].headline, "Acme beats Q3");
    assert.match(news.ai_prompt, /Acme beats Q3/);
    assert.equal(news.news_search.status, "ok");
    assert.ok(aiBodies.some(b => /Acme beats Q3/.test(b)), "the analysis prompt must carry the digest");
    console.log("ok - result ships before the news search; news precedes the AI stream");

    const again = await drive(handler, "/analyze-stream?ticker=AAA");
    const hit = again.find(e => e.name === "result").data;
    assert.equal(hit.cached, true);
    assert.equal(hit.news_pending, undefined);
    assert.equal(hit.news_digest.overview, "Q3 beat dominates.");
    assert.ok(!again.some(e => e.name === "news"), "a cache hit sends no news event");
    console.log("ok - the cache keeps the digest-applied payload");
  }
  {
    const { handler } = boot({ apiKey: "" });   // no key = news search off
    const ev = await drive(handler, "/analyze-stream?ticker=BBB");
    const result = ev.find(e => e.name === "result").data;
    assert.equal(result.news_pending, undefined);
    assert.equal(result.news_search.status, "off");
    assert.ok(!ev.some(e => e.name === "news"));
    console.log("ok - with news search off, result is unchanged and no news event is sent");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/js/news-stream.test.js`
Expected: assertion failure `order was progress,...` (no `news` event; `iNews` is -1).

- [ ] **Step 3: Implement** — replace `server.js` lines 3453-3467 (from the `// A scraper that never announced RESOLVED` comment through `await streamAiAnalysis(payload);`) with:

```js
      // A scraper that never announced RESOLVED (an older build, a stub) still gets news.
      if (!newsJob) newsJob = getNewsDigest(payload.ticker, payload.company_name);

      // The dashboard does not need the digest — only the written analysis reads §14 — so
      // with search on it ships now, flagged news_pending, and the digest follows as its own
      // `news` event. app.js shows a loader in the News card meanwhile and never the Finnhub
      // records, because those are not what the model will read unless the search falls back.
      const newsPending = Boolean(newsSearchEnabled());
      if (newsPending) {
        send("progress", { stage: STAGE_TOTAL, total: STAGE_TOTAL, label: "Reading recent news" });
        send("result", { ...payload, model: AI_MODEL, news_pending: true });
      }
      const newsResult = await newsJob;
      payload = { ...applyNewsDigest(payload, newsResult), news_search: newsSearchStatus(newsResult) };
      if (res.writableEnded || res.destroyed) return;

      // Cached only after every failure branch above has been cleared, so an error
      // payload or a truncated run can never be served to the next visitor. Cached WITH
      // the news digest applied, so a hit replays the same §14 the dashboard showed.
      putCachedAnalysis(query, payload);

      if (newsPending) {
        send("news", { company_news: payload.company_news, news_digest: payload.news_digest || null,
                       news_search: payload.news_search, data_sources: payload.data_sources,
                       ai_prompt: payload.ai_prompt });
      } else {
        send("result", { ...payload, model: AI_MODEL });
      }
      await streamAiAnalysis(payload);
```

- [ ] **Step 4: Run tests**

Run: `node --check server.js && node tests/js/news-stream.test.js && node tests/js/stream-retry.test.js && node tests/js/stream-failsafe.test.js`
Expected: three `ok -` lines from news-stream, all existing stream tests `ok`.

- [ ] **Step 5: Add to package.json** — append ` && node tests/js/news-stream.test.js` to the end of both the `test:js` script and the JS portion of `test` (right after `node tests/js/stream-failsafe.test.js`).

- [ ] **Step 6: Commit and push**

```bash
git add server.js tests/js/news-stream.test.js package.json
git commit -m "Analyzer: ship the dashboard before the news search; digest follows as a news event"
git push
```

---

### Task 2: Client — loader card, `news` event, in-place card swap

**Files:**
- Modify: `app.js` — news-card block in `renderAll` (~2837-2876), prompt card (~2830-2835), `persistableSession` (~271), `finalizePartialStream` callers (~1016, ~1048-1056), `result` handler (~1081-1096), add `news` listener after it.
- Modify: `styles.css` — `#genIndicator .wind` rules (~1567-1569), add loader rules after `.news-upcoming a:hover` (~1235).
- Test: `tests/js/app.test.js`

**Interfaces:**
- Consumes: SSE `result.news_pending`, SSE `news` (Task 1).
- Produces (app.js): `newsCard(d) → string`, `promptCard(d) → string`, `replaceCard(id, html)`, `applyNewsEvent(ticker, fields)`, `settleNewsPending(ticker)`, `startNewsClock()`, `stopNewsClock()`.

- [ ] **Step 1: Write failing tests** — append to `tests/js/app.test.js` after the "connection loss between dashboard and AI start" test:

```js
function driveNewsRun(state) {
  state(`EventSource = function () {
    this.handlers = {}; this.addEventListener = (name, fn) => this.handlers[name] = fn;
    this.close = () => {}; window.testSource = this;
  };
  document.getElementById("ticker").value = "TEST";
  runAnalysis();
  testSource.handlers.result({ data: JSON.stringify({ ticker: "TEST", news_pending: true, ai_prompt: "finnhub prompt",
    company_news: [{ headline: "Finnhub story", source: "Finnhub", published_at: "2026-09-01T12:00:00Z" }] }) });`);
}

test("while the news search runs the card shows the loader, never the Finnhub records", () => {
  const state = loadApp();
  driveNewsRun(state);
  const html = state(`newsCard(sessions.TEST.data)`);
  assert.match(html, /Searching the web for recent news/);
  assert.doesNotMatch(html, /Finnhub story/);
  assert.doesNotMatch(state(`JSON.stringify(persistableSession(sessions.TEST))`), /news_pending/,
    "a saved tab must never come back as a loader with no search behind it");
});

test("the news event swaps in the digest and the prompt the model will read", () => {
  const state = loadApp();
  driveNewsRun(state);
  state(`testSource.handlers.news({ data: JSON.stringify({ ai_prompt: "digest prompt",
    company_news: [{ headline: "Digest story", source: "Reuters", published_at: "2026-09-18T12:00:00Z" }],
    news_digest: { overview: "Beat.", upcoming: [] }, news_search: { status: "ok" }, data_sources: { news: "AI web search" } }) });`);
  assert.equal(state("sessions.TEST.data.news_pending"), undefined);
  assert.equal(state("sessions.TEST.context"), "digest prompt");
  assert.match(state(`newsCard(sessions.TEST.data)`), /Digest story/);
  assert.match(state(`document.getElementById("card-news").outerHTML`), /Digest story/);
});

test("a stream lost before the news event falls back to the Finnhub records", () => {
  const state = loadApp();
  driveNewsRun(state);
  state(`testSource.handlers.error({});`);
  assert.equal(state("sessions.TEST.data.news_pending"), undefined);
  assert.match(state(`newsCard(sessions.TEST.data)`), /Finnhub story/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node tests/js/run.js`
Expected: the three new tests fail with `newsCard is not defined`.

- [ ] **Step 3: Extract `promptCard` and `newsCard`** — in `renderAll`, replace the raw-prompt block (`/* Raw prompt */` … the `add("filings", card("prompt", …))` statement) with:

```js
  /* Raw prompt */
  add("filings", promptCard(d));
```

and replace the whole news block (from `/* Sourced company news — last card …` through the closing `}` of `if (news.length) { … }`) with:

```js
  /* Sourced company news — last card, below the measurements. */
  add("filings", newsCard(d));
```

Then add these top-level functions directly above `function renderAll(d) {`:

```js
/* The prompt and news cards are functions rather than inline renderAll blocks because the
   `news` event replaces exactly these two in place (replaceCard): a full renderAll would
   reset scroll, the chart and its zoom for a change that touches neither. */
function promptCard(d) {
  if (!d.ai_prompt) return "";
  return card("prompt", "Exact Data Sent to the AI",
    `<p style="font-size:12px;color:var(--ink-dim);margin-bottom:8px">The verbatim prompt the model received — every figure above is here, so what you see is what the AI reads.</p>
     <button class="copy-btn" onclick="copyPrompt(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy prompt</button>
     <pre class="raw">${esc(d.ai_prompt)}</pre>`, { open: false });
}

/* Either a server-side web search digest (every item grounded in a cited URL) or Finnhub
   records as the fallback; the analyst model explains these but never searches itself.
   While the search is still running (news_pending) the card is a loader and the Finnhub
   records stay hidden: the card shows only what the model will read, and the model reads
   Finnhub only if the search falls back. */
function newsCard(d) {
  if (d.news_pending) return card("news", "Recent Company News", newsLoaderHtml(), { count: "Searching" });
  const news = Array.isArray(d.company_news) ? d.company_news : [];
  if (!news.length) return "";
  const digest = d.news_digest && typeof d.news_digest === "object" ? d.news_digest : null;
  const overview = digest && digest.overview ? `<p class="news-overview">${esc(digest.overview)}</p>` : "";
  const upcoming = digest && Array.isArray(digest.upcoming) && digest.upcoming.length
    ? `<div class="news-upcoming"><span>Upcoming</span>${digest.upcoming.map(u => {
        const href = safeHttpUrl(u.url);
        const text = `${esc(u.date || "")} · ${esc(u.event || "")}`;
        return `<div>${href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text}</div>`;
      }).join("")}</div>`
    : "";
  const note = digest
    ? "Found by an AI web search and kept only where the item links a source the search actually cited. Impact and direction tags are the search's triage, not a verdict; the linked publisher remains the source of truth."
    : "Stories are dated source records returned by Finnhub. Squall can explain them, but the linked publisher remains the source of truth.";
  const newsBody = `${overview}<div class="news-list">${news.slice(0, 10).map(item => {
    const href = safeHttpUrl(item.url);
    let date = "Date unavailable";
    if (item.published_at) {
      const parsed = new Date(item.published_at);
      if (!Number.isNaN(parsed.getTime())) date = parsed.toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
    }
    const headline = esc(item.headline || "Untitled story");
    const title = href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${headline}</a>` : `<span>${headline}</span>`;
    const tags = [];
    if (item.impact === "high" || item.impact === "medium") tags.push(`<span class="news-tag">${item.impact === "high" ? "High" : "Medium"} impact</span>`);
    if (NEWS_EVENT_LABELS[item.category]) tags.push(`<span class="news-tag">${NEWS_EVENT_LABELS[item.category]}</span>`);
    if (item.direction === "positive" || item.direction === "negative")
      tags.push(`<span class="news-tag ${item.direction === "positive" ? "up" : "down"}">${item.direction === "positive" ? "Positive" : "Negative"}</span>`);
    return `<article class="news-item">
      <div class="news-meta"><span>${esc(item.source || "Unknown source")}</span><time>${esc(date)}</time></div>
      <h4>${title}</h4>
      ${item.summary ? `<p>${esc(item.summary)}</p>` : ""}
      ${tags.length ? `<div class="news-tags">${tags.join("")}</div>` : ""}
    </article>`;
  }).join("")}</div>${upcoming}<p class="learn-note">${note}</p>`;
  return card("news", "Recent Company News", newsBody, { count: news.length });
}

/* Three ghost rows in the real .news-item shape, shimmer staggered by --i so it sweeps
   down the list, under the wind glyph and a ticking elapsed counter (startNewsClock). */
function newsLoaderHtml() {
  const ghost = i => `<div class="news-item news-ghost" style="--i:${i}">
    <div class="skeleton sk-line news-ghost-meta"></div><div class="skeleton sk-line news-ghost-h"></div>
    <div class="skeleton sk-line"></div><div class="skeleton sk-line news-ghost-short"></div></div>`;
  return `<div class="news-loading" role="status">
    <div class="news-loading-head">${WIND_SVG}<span>Searching the web for recent news</span><time class="news-elapsed">${newsElapsedText()}</time></div>
    <div class="news-list" aria-hidden="true">${[0, 1, 2].map(ghost).join("")}</div></div>`;
}

let _newsClock = null, _newsSince = 0;
function newsElapsedText() { return _newsSince ? `${Math.max(0, Math.round((Date.now() - _newsSince) / 1000))}s` : "0s"; }
function startNewsClock() {
  stopNewsClock();
  _newsSince = Date.now();
  _newsClock = setInterval(() => {
    const el = document.querySelector(".news-elapsed");
    if (el) el.textContent = newsElapsedText();
  }, 1000);
}
function stopNewsClock() { if (_newsClock) clearInterval(_newsClock); _newsClock = null; _newsSince = 0; }

/* Swap one rendered card for new markup, keeping the reader's open/closed choice. */
function replaceCard(id, html) {
  const old = document.getElementById("card-" + id);
  if (!old) return;
  const wasOpen = old.open;
  old.outerHTML = html;
  const fresh = document.getElementById("card-" + id);
  if (fresh && typeof wasOpen === "boolean") fresh.open = wasOpen;
  return fresh;
}

/* The digest arrived: adopt the five fields the server sent, so the dashboard, the saved
   tab and chat context all match the prompt the model is about to read. */
function applyNewsEvent(ticker, fields) {
  const sess = sessions[ticker];
  if (!sess) return;
  for (const k of ["company_news", "news_digest", "news_search", "data_sources", "ai_prompt"]) {
    if (fields[k] === null || fields[k] === undefined) delete sess.data[k]; else sess.data[k] = fields[k];
  }
  delete sess.data.news_pending;
  sess.context = sess.data.ai_prompt || "";
  stopNewsClock();
  touchSession(sess); persistSessions();
  if (active === ticker) {
    replaceCard("news", newsCard(sess.data))?.classList.add("news-fresh");
    replaceCard("prompt", promptCard(sess.data));
  }
}

/* The stream ended before `news`. What the session holds is the Finnhub §14 — the same
   prompt it saved — so the card falls back to those records rather than loading forever. */
function settleNewsPending(ticker) {
  const sess = sessions[ticker];
  stopNewsClock();
  if (!sess || !sess.data.news_pending) return;
  delete sess.data.news_pending;
  if (active === ticker) replaceCard("news", newsCard(sess.data));
}
```

Note: `replaceCard` returning undefined when the card is missing, and `newsCard` returning `""` when there is nothing to show, are both fine — `outerHTML = ""` removes the card.

- [ ] **Step 4: Never persist the flag** — in `persistableSession`, after `const data = { ...s.data };` add:

```js
  // A saved tab can never resume a search, so it is stored as the Finnhub state it holds.
  delete data.news_pending;
```

- [ ] **Step 5: Wire the stream** — in `runAnalysis`:

Change lines 1016-1017 to:

```js
  if (_es) { _es.close(); _es = null; }
  if (_newsTicker) { settleNewsPending(_newsTicker); _newsTicker = null; }
  finalizePartialStream();
```

and declare next to `let _newsClock`: `let _newsTicker = null;   // the session whose digest is still in flight`

In the `error` listener's drop branch (`if (!e.data && gotResult) {`), add as its first line:

```js
      settleNewsPending(key); _newsTicker = null;
```

In the `result` listener, replace the last line `showProgressPercent(72, "Dashboard ready · preparing the written analysis");` with:

```js
    if (data.news_pending) {
      _newsTicker = data.ticker; startNewsClock();
      showProgressPercent(72, "Dashboard ready · gathering recent news");
    } else {
      showProgressPercent(72, "Dashboard ready · preparing the written analysis");
    }
```

Note `startNewsClock` runs after `renderAll`, so the first frame says `0s` and the interval takes over.

Directly after the `result` listener add:

```js
  // The web-search digest, after the dashboard. The AI stream only starts once this lands,
  // because the model reads the same §14 the card now shows.
  es.addEventListener("news", e => {
    applyNewsEvent(key, JSON.parse(e.data));
    _newsTicker = null;
    showProgressPercent(74, "Dashboard ready · preparing the written analysis");
  });
```

- [ ] **Step 6: Styles** — in `styles.css`, widen the genIndicator wind rules (lines ~1567-1569) to also cover the loader:

```css
#genIndicator .wind { width: 26px; height: 22px; flex-shrink: 0; }
#genIndicator .wind path, .news-loading .wind path { fill: none; stroke: var(--accent); stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 60; animation: gust 1.8s var(--ease) infinite; }
#genIndicator .wind path:nth-child(2), .news-loading .wind path:nth-child(2) { animation-delay: .12s; }
#genIndicator .wind path:nth-child(3), .news-loading .wind path:nth-child(3) { animation-delay: .24s; }
```

After `.news-upcoming a:hover { … }` add:

```css
.news-loading-head { display: flex; align-items: center; gap: 10px; margin: 0 2px 10px; color: var(--ink-dim); font-family: var(--mono); font-size: var(--t-micro); text-transform: uppercase; letter-spacing: .05em; }
.news-loading-head .wind { width: 22px; height: 19px; flex-shrink: 0; }
.news-loading-head time { margin-left: auto; font-variant-numeric: tabular-nums; }
.news-ghost { display: grid; gap: 7px; }
.news-ghost .skeleton::after { animation-delay: calc(var(--i) * .18s); }
.news-ghost-meta { width: 28%; height: 8px; }
.news-ghost-h { width: 78%; height: 11px; }
.news-ghost:nth-child(2) .news-ghost-h { width: 64%; }
.news-ghost-short { width: 52%; }
.news-fresh .news-list, .news-fresh .news-overview { animation: paneIn .35s var(--ease-out) backwards; }
```

(`--t-micro`, `--ease`, `--ease-out`, `paneIn`, `gust`, `.skeleton`, `.sk-line` all exist. Reduced motion is already handled globally at `styles.css:125`.)

- [ ] **Step 7: Run tests**

Run: `node --check app.js && node tests/js/run.js && node tests/js/pagecheck.js`
Expected: all JS tests pass including the three new ones; pagecheck passes for every page.

- [ ] **Step 8: Browser check** — `PORT=3271 PYTHON_BIN=node SQUALL_SCRAPER_PATH=./tests/stubs/scraper_stub.js node server.js` cannot show the loader (no API key → search off), so verify the loader by injecting state in the analyzer page: run an analysis on the stub, then in the console `sessions[active].data.news_pending = true; startNewsClock(); replaceCard("news", newsCard(sessions[active].data))`. Measure across all six themes that `.news-loading-head` colour is `--ink-dim` on the card backdrop and the ghost rows sit on `--chrome-2`; then call `applyNewsEvent(active, {...})` with Finnhub fields and confirm the swap keeps scroll position.

- [ ] **Step 9: Commit and push**

```bash
git add app.js styles.css tests/js/app.test.js
git commit -m "News card: loader while the web search runs, swapped in place by the news event"
git push
```

---

### Task 3: Docs

**Files:**
- Modify: `CLAUDE.md` — Server routes bullet for `/analyze-stream`; AI prompting bullet on §14.
- Modify: `docs/engineering-notes.md` — the news-digest section (find with `grep -n "news" docs/engineering-notes.md`).

- [ ] **Step 1: CLAUDE.md** — change the `/analyze-stream` bullet's event list to:
  `SSE events: progress, result (sent as soon as the scraper finishes; news_pending:true while the web search runs), news (the digest fields, before any ai_*), then ai_start/ai_thinking/ai_delta → ai_done or ai_error.`
  In the §14 bullet replace "spliced in by the server over the scraper's Finnhub §14 before `result` is sent and before caching" with "spliced in by the server over the scraper's Finnhub §14 after `result` and before caching and the AI call; it reaches the browser as the `news` event, and the News card shows a loader (never the Finnhub records) until then".
- [ ] **Step 2: engineering-notes.md** — add a dated paragraph (2026-10-01) to the news section: the dashboard no longer waits up to `SQUALL_NEWS_TIMEOUT_MS`; the card-shows-what-the-model-reads rule and why Finnhub is hidden while pending.
- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md docs/engineering-notes.md
git commit -m "Docs: result no longer waits for the news digest"
git push
```
