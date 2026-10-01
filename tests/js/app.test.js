"use strict";

/*
 * Covers the pure helpers in app.js — the timeframe/series layer behind the chart and the
 * analysis-body parser behind the AI pane.
 *
 * app.js is a browser script, not a module, so it runs in a vm against the same kind of
 * stubbed document pagecheck.js builds and its declarations are read off the sandbox
 * global. Only pure functions are exercised here; anything that strokes a canvas or
 * depends on layout is verified in the browser, per CLAUDE.md.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

test("empty screens disclose missing data instead of claiming all companies failed", () => {
  const app = loadApp();
  const html = app("renderScreenResults")({results: [], universe_requested:30, universe_scored:20,
    coverage:{evaluated:0, missing_data:18, not_applicable:2}});
  assert.match(html, /18 excluded for missing data/);
  assert.match(html, /2 require a different financial model/);
  assert.doesNotMatch(html, /No companies met every condition/);
});

/* A permissive element. Unlike pagecheck.js — which resolves ids against each page's REAL
   markup precisely so a missing one throws — this file resolves every id, because it is
   testing pure helpers and app.js writes to real elements at its top level. Page-specific
   wiring is pagecheck.js's job and is deliberately not duplicated here. */
function makeEl(id) {
  const el = {
    id, value: "", textContent: "", innerHTML: "", checked: false, disabled: false,
    tagName: "DIV", offsetWidth: 800, offsetHeight: 600, scrollTop: 0, scrollHeight: 0,
    clientWidth: 800, clientHeight: 600, children: [], dataset: {},
    style: new Proxy({}, { get: () => "", set: () => true }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    insertBefore() {}, replaceChild() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    toggleAttribute() { return false; }, hasAttribute: () => false, focus() {}, blur() {},
    click() {}, closest: () => null, scrollIntoView() {}, insertAdjacentHTML() {}, remove() {},
    dispatchEvent: () => true, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }),
    querySelectorAll: () => [], getContext: () => new Proxy({}, { get: () => () => ({}) }),
    parentNode: null, parentElement: null, firstChild: null
  };
  el.querySelector = () => makeEl(id + "-child");
  return el;
}

/* `focus` drives matchMedia, which is what FOCUS_MQ reads. The rail filters its own
   contents by mode — the AI destinations only exist when one pane at a time is mounted —
   so a harness that can only produce one mode cannot see half the behaviour. */
function loadApp({ focus = false } = {}) {
  const noopEl = {
    dataset: {}, style: { setProperty() {}, getPropertyValue: () => "" },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, addEventListener() {}
  };
  const cache = new Map();
  const storage = {
    _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
    clear() { this._d = {}; }, key: () => null, get length() { return Object.keys(this._d).length; }
  };
  const sandbox = {
    document: {
      body: { ...noopEl, dataset: { page: "analyzer" } },
      documentElement: { ...noopEl },
      getElementById(id) {
        if (!cache.has(id)) cache.set(id, makeEl(id));
        return cache.get(id);
      },
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => makeEl("created"), createTextNode: () => ({}),
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      startViewTransition: null, readyState: "complete", hidden: false,
      visibilityState: "visible", head: { appendChild() {} }
    },
    localStorage: storage, sessionStorage: storage,
    location: { href: "http://localhost/", search: "", pathname: "/", hash: "", assign() {}, replace() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: "node", maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout,
    // Unref'd: app.js's news clock (startNewsClock) is real-timer-backed in this harness, and
    // a test that exercises the loader without ever stopping the clock must not hang run.js,
    // which has no process.exit and simply waits for the event loop to drain.
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    matchMedia: q => ({ matches: /max-height|max-width: 1100px/.test(String(q)) ? focus : false,
      addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "#000", fontSize: "13px", display: "block" }),
    EventSource: function () { return { addEventListener() {}, close() {}, onerror: null }; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    CustomEvent: function () {}, Event: function () {}, URL, URLSearchParams,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900, scrollY: 0,
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    IntersectionObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    alert() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Same load order as index.html — app.js reads the universe tables at top level.
  for (const file of ["sp500.js", "market-universes.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
  }
  /* Top-level `const` and `let` bindings are NOT properties of the global object — only
     `var` and function declarations are — so reaching for sandbox.RANGES yields undefined
     and every assertion against it fails for a reason that has nothing to do with the code
     under test. Evaluate the name inside the context instead, which sees the whole scope. */
  return name => vm.runInContext(name, sandbox);
}

const read = loadApp();
const APP = new Proxy({}, { get: (_t, name) => read(String(name)) });
// A second realm in focus mode. Separate because app.js reads the media query at load.
const readFocus = loadApp({ focus: true });
const FOCUS = new Proxy({}, { get: (_t, name) => readFocus(String(name)) });

test("interrupted analysis preserves text with a saved warning and retry action", () => {
  const state = loadApp();
  state(`sessions.TEST = { data: { ticker: "TEST" }, history: [] };
    active = "TEST";
    _stream = { ticker: "TEST", answer: "Partial answer", thinking: "Evidence", model: "test", done: false };
    finalizePartialStream();`);
  assert.equal(state("sessions.TEST.data.aiSummary"), "Partial answer");
  assert.match(state("sessions.TEST.data.aiError"), /incomplete|interrupted/i);
  assert.match(state("aiWarnHtml(sessions.TEST.data)"), /Retry analysis/);
  assert.match(state('localStorage.getItem(SESSION_STORAGE_KEY)'), /aiError/);
  assert.equal(state("_stream"), null);
});

test("connection loss between dashboard and AI start replaces the waiting indicator", () => {
  const state = loadApp();
  state(`EventSource = function () {
    this.handlers = {}; this.addEventListener = (name, fn) => this.handlers[name] = fn;
    this.close = () => {}; window.testSource = this;
  };
  document.getElementById("ticker").value = "TEST";
  runAnalysis();
  testSource.handlers.result({ data: JSON.stringify({ ticker: "TEST" }) });
  testSource.handlers.error({});`);
  assert.match(state("sessions.TEST.data.aiError"), /incomplete|interrupted/i);
  assert.match(state('document.getElementById("aiSummary").innerHTML'), /Retry analysis/);
  assert.equal(state("_es"), null);
});

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
  assert.match(state(`document.getElementById("card-prompt").outerHTML`), /digest prompt/);
  assert.equal(state("_newsClock"), null);
});

test("a stream lost before the news event falls back to the Finnhub records", () => {
  const state = loadApp();
  driveNewsRun(state);
  state(`testSource.handlers.error({});`);
  assert.equal(state("sessions.TEST.data.news_pending"), undefined);
  assert.match(state(`newsCard(sessions.TEST.data)`), /Finnhub story/);
  assert.equal(state("_newsClock"), null);
});

test("a terminal error carrying data after the news search started still settles it", () => {
  const state = loadApp();
  driveNewsRun(state);
  state(`testSource.handlers.error({ data: JSON.stringify({ error: "boom" }) });`);
  assert.equal(state("sessions.TEST.data.news_pending"), undefined);
  assert.match(state(`newsCard(sessions.TEST.data)`), /Finnhub story/);
  assert.equal(state("_newsClock"), null);
});

test("starting a new analysis while a search is pending settles the old session", () => {
  const state = loadApp();
  driveNewsRun(state);
  state(`document.getElementById("ticker").value = "OTHER"; runAnalysis();`);
  assert.equal(state("sessions.TEST.data.news_pending"), undefined);
});

// Sandbox-allocated arrays carry that realm's prototype, and strict deepEqual compares
// prototypes — round-trip anything structural before comparing it.
const plain = value => JSON.parse(JSON.stringify(value));

const bar = (date, open, high, low, close, volume) => ({ date, open, high, low, close, volume });

/* ── Range table + legacy migration ─────────────────────────────────────────── */

test("every range tier names a timeframe the series resolver understands", () => {
  const known = new Set(["1d", "5m", "30m", "60m"]);
  for (const r of APP.RANGES) {
    assert.ok(known.has(r.tf), `range ${r.id} names unknown timeframe ${r.tf}`);
    assert.ok(r.bars > 0, `range ${r.id} has no bar count`);
    assert.ok(r.note, `range ${r.id} has no interval label`);
  }
});

test("the short tiers actually buy more candles than the daily table did", () => {
  // The whole point of the change: 1W drew 5 candles and 1M drew 21.
  const byId = Object.fromEntries(APP.RANGES.map(r => [r.id, r]));
  assert.ok(byId["1W"].bars > 5, "1W is still a handful of daily bars");
  assert.ok(byId["1M"].bars > 21, "1M is still a month of daily bars");
  assert.equal(byId["1D"].tf, "5m");
});

test("saved sessions holding the old bar count migrate to the matching tier", () => {
  // Without this, RANGES.find(r => r.id === 252) is undefined and drawChart throws on
  // the first render of every restored tab.
  assert.equal(APP.normalizeRange(252), "1Y");
  assert.equal(APP.normalizeRange(5), "1W");
  assert.equal(APP.normalizeRange(1260), "5Y");
  assert.equal(APP.normalizeRange("504"), "2Y");
});

test("an unknown or absent range falls back rather than resolving to undefined", () => {
  for (const input of [undefined, null, "", 0, 999, "7Y", {}]) {
    const id = APP.normalizeRange(input);
    assert.ok(APP.RANGES.some(r => r.id === id), `${JSON.stringify(input)} produced ${id}`);
  }
  assert.equal(APP.normalizeRange("1D"), "1D");        // a valid id survives untouched
  assert.equal(APP.rangeSpec("nonsense").id, "1Y");
});

/* ── Bar aggregation ────────────────────────────────────────────────────────── */

test("aggregating rolls open/high/low/close/volume the way a candle merges", () => {
  const src = [
    bar("d 09:30", 10, 12, 9, 11, 100),
    bar("d 09:35", 11, 15, 8, 14, 200),
    bar("d 09:40", 14, 16, 13, 15, 300),
  ];
  const [merged] = plain(APP.aggregateBars(src, 3));
  assert.equal(merged.open, 10);        // first bar's open
  assert.equal(merged.close, 15);       // last bar's close
  assert.equal(merged.high, 16);        // max across the window
  assert.equal(merged.low, 8);          // min across the window
  assert.equal(merged.volume, 600);     // summed
  assert.equal(merged.date, "d 09:30"); // stamped with the window's start
});

test("aggregation anchors to the newest bar, not the oldest", () => {
  // Anchoring at the front would let a partial leading group shift every bucket as new
  // bars arrive, so the most recent candle — the one being read — would keep changing.
  const src = Array.from({ length: 14 }, (_, i) => bar(`d ${i}`, i, i + 1, i - 1, i, 10));
  const out = plain(APP.aggregateBars(src, 6));
  assert.equal(out.length, 2, "14 bars at 6:1 yields two whole candles");
  assert.equal(out[out.length - 1].close, 13, "the newest source bar must close the newest candle");
});

test("aggregation is a no-op below a factor of two and survives empty input", () => {
  const src = [bar("d 1", 1, 2, 0, 1, 5)];
  assert.deepEqual(plain(APP.aggregateBars(src, 1)), plain(src));
  assert.deepEqual(plain(APP.aggregateBars([], 6)), []);
  assert.deepEqual(plain(APP.aggregateBars(null, 6)), []);
});

/* ── Series resolution ──────────────────────────────────────────────────────── */

function payload() {
  return {
    price_history: Array.from({ length: 300 }, (_, i) => bar(`2024-01-${i}`, i, i + 1, i - 1, i, 10)),
    intraday_history: {
      "5m":  Array.from({ length: 78 }, (_, i) => bar(`2024-05-01 ${i}`, i, i + 1, i - 1, i, 10)),
      "60m": Array.from({ length: 40 }, (_, i) => bar(`2024-05-0${i % 5} ${i}`, i, i + 1, i - 1, i, 10)),
    }
  };
}

test("each timeframe resolves to the array that actually backs it", () => {
  const d = payload();
  assert.equal(APP.seriesFor(d, "1d").length, 300);
  assert.equal(APP.seriesFor(d, "5m").length, 78);
  assert.equal(APP.seriesFor(d, "60m").length, 40);
  assert.equal(APP.seriesFor(d, "30m").length, 13, "78 five-minute bars roll up 6:1");
});

test("the 30-minute series is derived, never read from the payload", () => {
  // The scraper deliberately does not ship it; if this ever reads a shipped key instead
  // of deriving, a stale or absent one would silently blank the 1W chart.
  const d = payload();
  assert.ok(!("30m" in d.intraday_history));
  assert.ok(APP.seriesFor(d, "30m").length > 0);
});

test("a missing timeframe yields an empty array rather than null", () => {
  const bare = { price_history: [] };
  for (const tf of ["1d", "5m", "30m", "60m"]) {
    assert.deepEqual(plain(APP.seriesFor(bare, tf)), [], `${tf} did not degrade to []`);
    assert.deepEqual(plain(APP.seriesFor(null, tf)), [], `${tf} threw on a null payload`);
  }
});

test("price_history_1y still backs the daily tier for older saved sessions", () => {
  const legacy = { price_history_1y: [bar("2024-01-01", 1, 2, 0, 1, 5)] };
  assert.equal(APP.seriesFor(legacy, "1d").length, 1);
});

/* ── Viewport: zoom + pan ───────────────────────────────────────────────────── */

test("an untouched viewport is exactly the tier's default window, ending at the newest bar", () => {
  const win = APP.visibleWindow(300, 252, { count: null, offset: 0 });
  assert.equal(win.count, 252);
  assert.equal(win.end, 300, "the window must sit on the right edge of the series");
  assert.equal(win.start, 48);
});

test("a window wider than the series it is asked for collapses onto the series", () => {
  // 1Y (252 bars) against a name with 60 sessions of history: the old slice silently
  // produced a short window; the clamp has to produce a valid one.
  const win = APP.visibleWindow(60, 252, { count: null, offset: 0 });
  assert.equal(win.count, 60);
  assert.equal(win.start, 0);
  assert.equal(win.end, 60);
});

test("the viewport clamps rather than running off either end of the series", () => {
  const tooFar = APP.visibleWindow(300, 252, { count: 50, offset: 9999 });
  assert.equal(tooFar.start, 0, "panning past the oldest bar must stop at it");
  assert.equal(tooFar.count, 50);
  const negative = APP.visibleWindow(300, 252, { count: 50, offset: -40 });
  assert.equal(negative.end, 300, "panning past the newest bar must stop at it");
  const tooTight = APP.visibleWindow(300, 252, { count: 1, offset: 0 });
  assert.equal(tooTight.count, APP.MIN_ZOOM_BARS, "a chart of one candle is not a chart");
  const tooWide = APP.visibleWindow(300, 252, { count: 5000, offset: 0 });
  assert.equal(tooWide.count, 300, "zooming out stops at the whole series");
});

test("a viewport survives the degenerate inputs a restored tab can hand it", () => {
  for (const zoom of [null, undefined, {}, { count: NaN, offset: NaN }, { count: Infinity, offset: "x" }]) {
    const win = APP.visibleWindow(300, 252, zoom);
    assert.ok(win.count >= 1 && win.count <= 300, `count out of range for ${JSON.stringify(zoom)}`);
    assert.ok(win.start >= 0 && win.end <= 300, `bounds out of range for ${JSON.stringify(zoom)}`);
    assert.equal(win.end - win.start, win.count);
  }
  const empty = APP.visibleWindow(0, 252, null);
  assert.deepEqual([empty.start, empty.end, empty.count], [0, 0, 0], "an empty series must not go negative");
});

test("zooming holds the bar under the pointer still", () => {
  // Without the anchor every zoom walks the view toward the newest bar, so you can never
  // open up the level you are actually looking at.
  const win = APP.visibleWindow(300, 100, { count: 100, offset: 0 });   // bars 200..300
  const mid = APP.zoomWindow(win, 0.5, 0.5, 300);                       // zoom 2× on the middle
  assert.equal(mid.count, 50);
  const after = APP.visibleWindow(300, 100, mid);
  assert.equal(after.start + after.count / 2, 250, "the middle bar moved");
});

test("zooming out at the right edge stays pinned to the newest bar", () => {
  const win = APP.visibleWindow(300, 60, { count: 60, offset: 0 });
  const out = APP.zoomWindow(win, 2, 1, 300);
  assert.equal(out.count, 120);
  assert.equal(out.offset, 0, "the newest bar must stay on screen when zooming out at the edge");
});

test("panning moves whole bars and never changes how many are on screen", () => {
  const win = APP.visibleWindow(300, 100, { count: 100, offset: 0 });
  const back = APP.panWindow(win, 25, 300);       // drag the candles right → walk back in time
  assert.equal(back.count, 100);
  assert.equal(back.offset, 25);
  const forward = APP.panWindow(back, -60, 300);  // and past the right edge
  assert.equal(forward.offset, 0);
  const wall = APP.panWindow(win, 9999, 300);
  assert.equal(wall.offset, 200, "panning stops when the oldest bar reaches the left edge");
});

test("both panes read one viewport, whatever their history lengths are", () => {
  // The compare split is only legible if a pinch means the same thing on both sides, which
  // is why the state counts bars from the RIGHT edge instead of naming absolute indices.
  const zoom = { count: 40, offset: 10 };
  const long = APP.visibleWindow(1260, 252, zoom), short = APP.visibleWindow(300, 252, zoom);
  assert.equal(long.count, short.count);
  assert.equal(long.end - 1260, short.end - 300, "both windows must end the same distance from the newest bar");
});

test("a tier is only offered when its series has enough bars to be a chart", () => {
  const d = payload();
  const byId = Object.fromEntries(APP.RANGES.map(r => [r.id, r]));
  assert.ok(APP.rangeAvailable(d, byId["1D"]));
  assert.ok(APP.rangeAvailable(d, byId["1W"]));
  assert.ok(APP.rangeAvailable(d, byId["1Y"]));

  // A fund, a thin name or a Yahoo miss leaves intraday empty — those buttons must vanish
  // rather than render an empty canvas.
  const noIntraday = { price_history: d.price_history, intraday_history: {} };
  assert.ok(!APP.rangeAvailable(noIntraday, byId["1D"]));
  assert.ok(!APP.rangeAvailable(noIntraday, byId["1W"]));
  assert.ok(!APP.rangeAvailable(noIntraday, byId["1M"]));
  assert.ok(APP.rangeAvailable(noIntraday, byId["1Y"]), "daily tiers must survive");
});

/* ── Axis labels ────────────────────────────────────────────────────────────── */

test("daily ticks keep the short date and intraday ticks show a clock", () => {
  assert.equal(APP.axisLabel(bar("2024-05-01"), "1d", false), "24-05-01");
  assert.equal(APP.axisLabel(bar("2024-05-01 14:30"), "5m", false), "14:30");
  // Edge ticks carry the day, or a multi-session window reads as one ambiguous day.
  assert.equal(APP.axisLabel(bar("2024-05-01 14:30"), "5m", true), "05-01 14:30");
});

test("an axis label never throws on a malformed or missing bar", () => {
  assert.equal(typeof APP.axisLabel(null, "5m", false), "string");
  assert.equal(typeof APP.axisLabel({}, "1d", true), "string");
  assert.equal(typeof APP.axisLabel(bar("2024-05-01"), "5m", false), "string");
});

/* ── Workspace destinations and the rail ────────────────────────────────────── */

const fullBucket = () => ({
  chart: "<div id='chartControls'></div>",
  overview: "<details id='card-snapshot'></details>",
  technicals: "<details id='card-tech'></details>",
  fundamentals: "<details id='card-valuation'></details>",
  filings: "<details id='card-news'></details>",
});
const emptyBucket = () => ({ chart: "", overview: "", technicals: "", fundamentals: "", filings: "" });
// renderViewRail writes the rail into #viewRail and returns only the panels, so the two
// halves are read from two places.
const railHtml = (r = read) => r('document.getElementById("viewRail").innerHTML');

test("a filled bucket renders one rail entry and one panel per data destination", () => {
  const out = APP.renderViewRail(fullBucket());
  const rail = railHtml();
  for (const v of APP.DATA_VIEWS) {
    assert.ok(rail.includes(`data-view="${v.id}"`), `no rail entry for ${v.id}`);
    assert.ok(out.includes(`data-section="${v.id}"`), `no panel for ${v.id}`);
  }
  assert.equal((out.match(/class="data-section show/g) || []).length, 1,
    "exactly one panel may be visible at a time");
});

test("every card still reaches the DOM — regrouping must not drop content", () => {
  // The whole premise of the change is that this is a regrouping, not a reduction.
  const bucket = fullBucket();
  const out = APP.renderViewRail(bucket);
  for (const markup of Object.values(bucket)) {
    assert.ok(out.includes(markup), `destination content went missing: ${markup}`);
  }
});

test("a destination with no cards gets no rail entry", () => {
  // A ticker with no filings or news would otherwise offer a destination onto nothing.
  APP.renderViewRail({ ...fullBucket(), filings: "", technicals: "   " });
  const rail = railHtml();
  assert.ok(!rail.includes('data-view="filings"'));
  assert.ok(!rail.includes('data-view="technicals"'), "whitespace is not content");
  assert.ok(rail.includes('data-view="overview"'));
});

test("an entirely empty bucket renders nothing rather than a bare rail", () => {
  assert.equal(APP.renderViewRail(emptyBucket()), "");
});

test("the chart is its own destination, not a card inside Overview", () => {
  // As a card it was a fixed 565px inside a 312px window: the controls and the candles
  // could never be on screen together whatever the pane's height.
  assert.equal(APP.VIEWS[0].id, "chart");
  const out = APP.renderViewRail(fullBucket());
  assert.ok(/class="data-section [^"]*chart-section/.test(out),
    "the chart panel must be marked so it can take the region's height");
});

test("split mode hides the AI destinations; focus mode lists them", () => {
  // In split mode the AI pane is already beside you — selecting it is not a navigation.
  APP.renderViewRail(fullBucket());
  const split = railHtml();
  assert.ok(!split.includes('data-view="analysis"'), "split mode must not offer AI Analysis");
  assert.ok(!split.includes('data-view="chat"'));

  FOCUS.renderViewRail(fullBucket());
  const focus = railHtml(readFocus);
  assert.ok(focus.includes('data-view="analysis"'), "focus mode must offer AI Analysis");
  assert.ok(focus.includes('data-view="chat"'));
  assert.ok(focus.includes("data-group-start"), "the two panes' destinations need a divider");
});

test("focus mode renders panels only for the data destinations", () => {
  // The AI destinations are whole panes; a panel for them would be an empty div.
  const out = FOCUS.renderViewRail(fullBucket());
  assert.ok(!out.includes('data-section="analysis"'));
  assert.ok(!out.includes('data-section="chat"'));
});

test("the loading rail exists, so the streaming write-up is reachable during a first run", () => {
  /* Caught in production, not here. In focus mode both panes occupy the same grid cell and
     only [data-hidden] separates them, so before this the skeleton phase rendered the two
     stacked on top of each other — for the thirty to sixty seconds of a first analysis,
     with no rail entry to escape by. #mobileTabs used to cover this by being static
     markup; a rail that renderAll builds does not exist yet at that point. */
  FOCUS.renderLoadingRail();
  const rail = railHtml(readFocus);
  assert.ok(rail.includes('data-view="overview"'), "the skeleton needs a destination");
  assert.ok(rail.includes('data-view="analysis"'), "the streaming pane must be reachable");
  assert.ok(/aria-selected="true"/.test(rail), "exactly one entry is current");
});

test("the skeleton panel is named, so clicking the rail does not blank it", () => {
  // showView toggles `.show` off every panel whose data-section does not match. An
  // unnamed skeleton wrapper is therefore hidden the instant the reader uses the rail
  // mid-load, and the pane goes blank until the payload arrives.
  const sk = APP.dataSkeleton();
  assert.ok(/class="data-section show"[^>]*data-section="overview"/.test(sk),
    "the skeleton must sit in a named, shown panel");
});

test("the loading rail does not overwrite a remembered data destination", () => {
  // It highlights a placeholder; renderAll restores the reader's real destination.
  readFocus('activeView = "technicals"');
  FOCUS.renderLoadingRail();
  assert.equal(FOCUS.activeView, "technicals");
  // Chat is the exception — there is nothing to ask about until the payload lands.
  readFocus('activeView = "chat"');
  FOCUS.renderLoadingRail();
  assert.equal(FOCUS.activeView, "analysis");
});

test("the streaming dot rides an AI destination that only focus mode renders", () => {
  // It was on #mobileTabs' AI tab. Losing it would remove the only signal that the
  // write-up is still generating while you are reading numbers.
  FOCUS.renderViewRail(fullBucket());
  assert.ok(railHtml(readFocus).includes("tab-dot"));
});

/* ── Analysis body: verdict block + collapsible sections ────────────────────── */

const ANALYSIS = [
  "## Verdict",
  "**Buy** — the multiple prices flawless execution, but FCF yield carries it.",
  "Invalidates below $198.40.",
  "",
  "## Valuation & Quality",
  "Trading at 34x forward earnings against ~12% growth.",
  "",
  "## Fundamentals & Financial Health",
  "Margins are widening.",
  "",
  "## Sentiment & Positioning",
  "Consensus is ahead of the tape.",
  "",
  "## Price Action & Institutional Footprint",
  "Higher highs and higher lows since March.",
  "",
  "## Catalysts & Risks",
  "Two catalysts, two risks.",
  "",
  "## Trade Idea",
  "A call spread.",
].join("\n");

test("the verdict is lifted out of the prose into its own block", () => {
  const out = APP.renderAnalysisBody(ANALYSIS);
  assert.ok(out.includes('class="verdict-block"'));
  assert.ok(/<span class="verdict-rating" data-tone="up">Buy<\/span>/.test(out));
  // The rating must not also remain as bold text in the sentence it was pulled from.
  assert.ok(!out.includes("<strong>Buy</strong>"));
  // ...but the reasoning that followed it must survive intact.
  assert.ok(out.includes("FCF yield carries it"));
  assert.ok(out.includes("198.40"));
});

test("every heading survives and the two reasoning sections open by default", () => {
  const out = APP.renderAnalysisBody(ANALYSIS);
  for (const h of ["Valuation &amp; Quality", "Fundamentals &amp; Financial Health",
                   "Sentiment &amp; Positioning", "Price Action &amp; Institutional Footprint",
                   "Catalysts &amp; Risks", "Trade Idea"]) {
    assert.ok(out.includes(h), `heading went missing: ${h}`);
  }
  // Six sections after the verdict; exactly the two that carry the reasoning start open.
  assert.equal((out.match(/<details class="ai-section"/g) || []).length, 6);
  assert.equal((out.match(/<details class="ai-section" open>/g) || []).length, 2);
});

test("no section's prose is lost to the sectioning", () => {
  const out = APP.renderAnalysisBody(ANALYSIS);
  for (const body of ["34x forward earnings", "Margins are widening", "ahead of the tape",
                      "Higher highs", "Two catalysts", "A call spread"]) {
    assert.ok(out.includes(body), `body went missing: ${body}`);
  }
});

test("an off-format answer falls back to plain prose rather than vanishing", () => {
  // The single most important behaviour here: the model goes off-format, or a stream is
  // cut short, and an analysis lost behind a parser is far worse than one rendered flat.
  const flat = "No headers at all, just a paragraph of analysis about the company.";
  assert.equal(APP.renderAnalysisBody(flat), APP.renderMarkdown(flat));
  const oneHeader = "## Verdict\n**Hold** — nothing compelling either way.";
  assert.equal(APP.renderAnalysisBody(oneHeader), APP.renderMarkdown(oneHeader));
  assert.equal(APP.renderAnalysisBody(""), "");
  assert.equal(APP.renderAnalysisBody(null), "");
  assert.equal(APP.renderAnalysisBody(undefined), "");
});

test("a verdict whose rating is phrased unexpectedly still renders its prose", () => {
  // Dropping the verdict because the wording surprised us is the one outcome to avoid.
  const odd = "## Verdict\nWe would accumulate here.\n\n## Valuation\nCheap.\n\n## Risks\nMany.";
  const out = APP.renderAnalysisBody(odd);
  assert.ok(out.includes('class="verdict-block"'));
  assert.ok(out.includes("We would accumulate here"));
  assert.ok(!out.includes("verdict-rating"), "no rating chip without a matched rating");
});

test("every rating maps to a direction, and hold is neutral", () => {
  const tone = label => {
    const out = APP.renderAnalysisBody(`## Verdict\n**${label}** — reason.\n\n## A\nx\n\n## B\ny`);
    return (out.match(/data-tone="([a-z]+)"/) || [])[1];
  };
  assert.equal(tone("Strong Buy"), "up");
  assert.equal(tone("Buy"), "up");
  assert.equal(tone("Sell"), "down");
  assert.equal(tone("Strong Sell"), "down");
  // Green and red are direction. Hold is neither, and must not borrow --warn.
  assert.equal(tone("Hold"), "flat");
});

test("text before the first header is kept, not swallowed", () => {
  const out = APP.renderAnalysisBody("An opening line.\n\n## Verdict\n**Buy** — go.\n\n## A\nx\n\n## B\ny");
  assert.ok(out.includes("An opening line"));
});

test("a ### subheading does not start a new collapsible section", () => {
  const out = APP.renderAnalysisBody("## Verdict\n**Buy** — go.\n\n## A\n### Sub\nx\n\n## B\ny");
  assert.equal((out.match(/<details class="ai-section"/g) || []).length, 2);
  assert.ok(out.includes("Sub"));
});

test("a remembered destination this ticker cannot fill falls back to the first", () => {
  const out = APP.renderViewRail({ ...emptyBucket(), overview: "<i>x</i>" });
  assert.ok(/data-view="overview"[^>]*aria-selected="true"/.test(railHtml()),
    "the surviving destination must be the selected one");
  assert.ok(/class="data-section show/.test(out));
});

test("updated financial units and zero-estimate earnings render without invented percentages", () => {
  const state = loadApp();
  state(`renderAll({ticker:"TEST",raw_data:{
    financial_health:{debt_to_equity:1.25,debt_to_equity_unit:"multiple"},
    earnings_surprises:[{date:"2025-12-31",estimate:0,reported:1,surprise_pct:null}],
    risk_return:{period_start:"2024-01-01",period_end:"2025-01-01",observations:253,
      price_basis:"dividend-adjusted close",sharpe_basis:"Lagged bill yield"}
  }});`);
  const html = state('document.getElementById("dataBody").innerHTML');
  assert.ok(html.includes("Debt / Equity (×)"));
  assert.ok(html.includes("dividend-adjusted close"));
  assert.ok(html.includes("2024-01-01 to 2025-01-01"));
  const earnings = html.split('id="card-earnings"')[1].split('</details>')[0];
  assert.ok(earnings.includes("N/A"));
  assert.ok(earnings.includes("Beat"));
  assert.ok(!earnings.includes("0.0%"));
});

/* ── Y-axis ticks ───────────────────────────────────────────────────────────── */

test("a tight intraday window gets an axis that distinguishes its gridlines", () => {
  /* The defect this replaces: the axis cut [lo,hi] into four equal parts and printed each
     with toFixed(val < 10 ? 2 : 0), so a $187 stock zoomed into one session printed "$187"
     on all five lines. Decimals have to come from the step, not the price. */
  const { ticks, dp } = APP.niceTicks(187.21, 187.94, 5);
  assert.ok(ticks.length >= 3, `expected several gridlines, got ${ticks.length}`);
  assert.ok(dp >= 1, "a 73-cent window needs decimals in its labels");
  const labels = ticks.map(v => v.toFixed(dp));
  assert.equal(new Set(labels).size, labels.length, `duplicate axis labels: ${labels.join(", ")}`);
});

test("axis steps snap to the 1 / 2 / 2.5 / 5 family", () => {
  for (const [lo, hi] of [[0, 100], [187.21, 187.94], [12.5, 61.3], [1, 3], [0.42, 0.98], [900, 4300]]) {
    const { step } = APP.niceTicks(lo, hi, 5);
    const mag = Math.pow(10, Math.floor(Math.log10(step)));
    const norm = Number((step / mag).toFixed(6));
    assert.ok([1, 2, 2.5, 5].includes(norm), `step ${step} on [${lo},${hi}] normalises to ${norm}`);
  }
});

test("decimals represent the step exactly, including the 2.5 family", () => {
  // 2.5 x 10^n is the case a -log10 approximation gets wrong in both directions. Each case
  // asserts the step too, so the example cannot silently stop exercising the rung it names.
  for (const [lo, hi, step, dp] of [
    [0, 1.25,  0.25,  2],
    [0, 12.5,  2.5,   1],
    [0, 250,   50,    0],
    [0, 0.05,  0.01,  2],
    [0, 0.025, 0.005, 3],
  ]) {
    const t = APP.niceTicks(lo, hi, 5);
    assert.equal(Number(t.step.toPrecision(6)), step, `[${lo},${hi}] step`);
    assert.equal(t.dp, dp, `[${lo},${hi}] decimals`);
  }
});

test("the axis stays near its target gridline count on both sides of a decade", () => {
  /* Rounding the step up halves the count. A $916-941 pane came back with $920 and $940
     alone because its ideal step of 10.9 was rounded to 20. */
  for (const [lo, hi] of [[906.8, 950.4], [195, 294], [0, 100], [187.21, 187.94], [12.5, 61.3], [1, 3], [0.42, 0.98], [900, 4300]]) {
    const n = APP.niceTicks(lo, hi, 5).ticks.length;
    assert.ok(n >= 3 && n <= 8, `[${lo},${hi}] produced ${n} gridlines`);
  }
});

test("every tick lands inside the range it was asked for", () => {
  for (const [lo, hi] of [[187.21, 187.94], [0, 100], [12.5, 61.3], [0.42, 0.98]]) {
    for (const v of APP.niceTicks(lo, hi, 5).ticks) {
      assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `tick ${v} escapes [${lo}, ${hi}]`);
    }
  }
});

test("a degenerate range yields no gridlines rather than an infinite loop", () => {
  // drawChart can be handed a flat window — a halted ticker, or one bar repeated.
  assert.deepEqual(plain(APP.niceTicks(50, 50, 5).ticks), []);
  assert.deepEqual(plain(APP.niceTicks(50, 10, 5).ticks), []);
  assert.deepEqual(plain(APP.niceTicks(NaN, 10, 5).ticks), []);
});

/* ── Percent scale + the shared compare domain ──────────────────────────────── */

// A rising series and a much pricier, flatter one — the shape the compare split exists for.
const ramp = (start, step, n) => Array.from({ length: n }, (_, i) => {
  const c = start + step * i;
  return bar(`2024-01-${String((i % 28) + 1).padStart(2, "0")}`, c, c + 1, c - 1, c, 1000);
});

function paneFor(state, ticker, bars, range = "1Y") {
  state(`sessions[${JSON.stringify(ticker)}] = { data: { ticker: ${JSON.stringify(ticker)},
    price_history: ${JSON.stringify(bars)} }, history: [], range: ${JSON.stringify(range)} };`);
  return state(`resolvePane(sessions[${JSON.stringify(ticker)}], ${JSON.stringify(ticker)}, rangeSpec("${range}"))`);
}

test("a resolved pane reports its extent in percent from its first visible bar", () => {
  const state = loadApp();
  const pane = paneFor(state, "UP", ramp(100, 1, 60));
  assert.equal(pane.ok, true);
  assert.equal(pane.base, 100);
  // lo/hi carry the existing 1% padding, so the percent span brackets the raw 0..59% move.
  assert.ok(pane.pct.lo < 0 && pane.pct.hi > 59, `pct span ${JSON.stringify(pane.pct)}`);
});

test("two panes at different price levels reconcile onto one percent domain", () => {
  /* The defect this fixes: NVDA at $890 beside AMD at $95 drew two shapes on unrelated
     absolute scales. In percent both are measured from their own first bar, so the domain
     is the union of their MOVES, not of their prices. */
  const state = loadApp();
  const cheap = paneFor(state, "CHEAP", ramp(10, 0.5, 60));    // 10 -> 39.5, +295%
  const dear = paneFor(state, "DEAR", ramp(900, 1, 60));       // 900 -> 959, +6.6%
  const shared = state(`sharedPercentDomain([
    resolvePane(sessions.CHEAP, "CHEAP", rangeSpec("1Y")),
    resolvePane(sessions.DEAR, "DEAR", rangeSpec("1Y"))])`);
  assert.ok(shared, "two usable panes must produce a domain");
  assert.ok(shared.hi >= cheap.pct.hi - 1e-9, "the domain must cover the bigger mover");
  assert.ok(shared.lo <= Math.min(cheap.pct.lo, dear.pct.lo) + 1e-9, "and both floors");
  // The domain is in percent, so the $900 stock's price level does not enter it at all.
  assert.ok(shared.hi < 400, `domain leaked absolute prices: ${JSON.stringify(shared)}`);
});

test("a pane with an unusable base drops out of the domain instead of poisoning it", () => {
  const state = loadApp();
  paneFor(state, "GOOD", ramp(100, 1, 60));
  // A zero first close would make every percent infinite.
  const zeroed = ramp(100, 1, 60).map((b, i) => i === 0 ? { ...b, open: 0, high: 0, low: 0, close: 0 } : b);
  paneFor(state, "ZERO", zeroed);
  const shared = state(`sharedPercentDomain([
    resolvePane(sessions.GOOD, "GOOD", rangeSpec("1Y")),
    resolvePane(sessions.ZERO, "ZERO", rangeSpec("1Y"))])`);
  assert.ok(shared, "the usable pane still yields a domain");
  assert.ok(isFinite(shared.lo) && isFinite(shared.hi), `non-finite domain ${JSON.stringify(shared)}`);
});

test("no usable pane yields no domain rather than an inverted one", () => {
  const state = loadApp();
  assert.equal(state("sharedPercentDomain([])"), null);
  assert.equal(state("sharedPercentDomain([null, { ok: false }])"), null);
});

test("resolvePane reports not-ok for a series too short to chart", () => {
  const state = loadApp();
  const pane = paneFor(state, "THIN", ramp(50, 1, 3));
  assert.equal(pane.ok, false);
  assert.deepEqual(plain(pane.data), []);
});

test("the percent seed fires once and never overrides a later choice", () => {
  const state = loadApp();
  assert.equal(state("chartOpts.pct"), false);
  assert.equal(state("seedPercentScaleForCompare()"), true);
  assert.equal(state("chartOpts.pct"), true);
  // Turned back off by hand, the seed must not switch it on again.
  state("chartOpts.pct = false;");
  assert.equal(state("seedPercentScaleForCompare()"), false);
  assert.equal(state("chartOpts.pct"), false);
});

test("volume labels stay short enough for a 46px band", () => {
  assert.equal(APP.fVolShort(1234), "1K");
  assert.equal(APP.fVolShort(45600000), "45.6M");
  assert.equal(APP.fVolShort(2300000000), "2.3B");
  assert.equal(APP.fVolShort(842), "842");
  assert.equal(APP.fVolShort(null), "");
});

/* ── Watchlist ────────────────────────────────────────────────────────────── */
test("the watchlist normalizes, rejects junk and duplicates, and caps its length", () => {
  const app = loadApp();
  assert.equal(app("addToWatchlist")(" $aapl ").ok, true);
  assert.equal(app("isWatched")("AAPL"), true);
  assert.match(app("addToWatchlist")("AAPL").message, /already/);
  assert.match(app("addToWatchlist")("not a ticker").message, /isn't a ticker/);
  for (let i = 0; app("watchlist.length") < app("WATCH_MAX"); i++)
    app("addToWatchlist")(`W${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
  assert.match(app("addToWatchlist")("ZZZZ").message, /up to/);
  // Persisted, and reloaded through the same validation.
  const stored = JSON.parse(app("localStorage.getItem(WATCH_STORAGE_KEY)"));
  assert.equal(stored.length, app("WATCH_MAX"));
  app("localStorage.setItem(WATCH_STORAGE_KEY, JSON.stringify([{t:'MSFT'},{t:'MSFT'},{t:'<b>'},{x:1}]))");
  app("loadWatchlist()");
  assert.deepEqual(JSON.parse(app("JSON.stringify(watchlist.map(r => r.t))")), ["MSFT"]);
});

test("a watched results window is judged from today, not from the snapshot's day counts", () => {
  const flag = APP.watchEventFlag;
  const now = new Date(2026, 8, 23);
  // Stored "91 days away" at snapshot time, but the window now opens in 9 days.
  const er = { earnings_window: ["2026-10-02", "2026-10-20"], days_until_earnings_window_opens: 91, imminent: false };
  assert.equal(flag(er, now).label, "Results ~9d");
  assert.equal(flag({ earnings_window: ["2026-09-20", "2026-09-30"] }, now).label, "Results due now");
  assert.equal(flag({ earnings_window: ["2026-08-01", "2026-08-20"] }, now), null);   // window passed
  assert.equal(flag({ earnings_window: ["2026-12-01", "2026-12-20"] }, now), null);   // too far off
  assert.equal(flag(null, now), null);
});

test("a watch row shows the move since the saved snapshot and never invents a price", () => {
  const app = loadApp();
  app("addToWatchlist")("NVDA");
  app(`sessions.NVDA = { data: { ticker: "NVDA", live_quote: { last_price: 100, quote_time: "2026-09-01 16:00" } } }`);
  app(`watchQuotes.NVDA = { status: "fresh", price: 110, change_pct: -1.25 }`);
  const html = app("watchRowHtml")({ t: "NVDA" });
  assert.match(html, /\$110\.00/);
  assert.match(html, /\+10\.0% since/);
  assert.match(html, /▼ 1\.25%/);
  app(`watchQuotes.NVDA = { status: "deferred" }`);
  const pending = app("watchRowHtml")({ t: "NVDA" });
  assert.doesNotMatch(pending, /since/);
  assert.match(pending, /watch-px">—/);
  assert.match(app("watchRowHtml")({ t: "AMD" }), /Not analyzed yet/);
});

/* ── Portfolio ────────────────────────────────────────────────────────────── */
test("portfolio lots merge at a weighted cost, and a lot without a cost clears it", () => {
  const app = loadApp();
  assert.equal(app("upsertHolding")(" $aapl ", "10", "100").ok, true);
  const merged = app("upsertHolding")("AAPL", "30", "$200");
  assert.equal(merged.ok, true);
  assert.equal(app("portfolio[0].shares"), 40);
  assert.equal(app("portfolio[0].cost"), 175);            // (10×100 + 30×200) / 40
  assert.match(app("upsertHolding")("AAPL", "5", "").message, /cleared/);
  assert.equal(app("portfolio[0].cost"), null);
  assert.equal(app("upsertHolding")("AAPL", "2", "50", true).ok, true);   // edit replaces
  assert.equal(app("portfolio[0].shares"), 2);
  assert.equal(app("portfolio[0].cost"), 50);
  assert.match(app("upsertHolding")("not a ticker", "1", "").message, /isn't a ticker/);
  assert.match(app("upsertHolding")("MSFT", "0", "").message, /above zero/);
  assert.match(app("upsertHolding")("MSFT", "1", "abc").message, /valid price/);
  assert.equal(app("portfolio.length"), 1);
});

test("portfolio paste import reads comma, space and tab lines and reports the rest", () => {
  const app = loadApp();
  const r = app("importPortfolioText")("Symbol,Shares,Cost\nAAPL, 25, 142.10\nMSFT 10 310\nVOO\t1,250\t400.5\n\n# note\nNVDA, lots");
  assert.equal(r.added, 3);
  assert.deepEqual([...r.failed], [1, 7]);
  assert.equal(app("portfolio.find(h => h.t === 'VOO').shares"), 1250);   // tab line keeps the thousands comma
  assert.equal(app("portfolio.find(h => h.t === 'AAPL').cost"), 142.1);
  // Reload goes through the same validation.
  app("localStorage.setItem(PF_STORAGE_KEY, JSON.stringify([{t:'AMD',shares:3,cost:null},{t:'AMD',shares:1},{t:'<b>',shares:1},{t:'X',shares:-2}]))");
  app("loadPortfolio()");
  assert.equal(app("JSON.stringify(portfolio)"), JSON.stringify([{ t: "AMD", shares: 3, cost: null }]));
});

test("portfolio totals count only priced holdings and P&L only holdings with a cost", () => {
  const app = loadApp();
  app("upsertHolding")("AAA", "10", "50");
  app("upsertHolding")("BBB", "4", "");
  app("upsertHolding")("CCC", "1", "10");
  app(`pfQuotes.AAA = { status: "fresh", price: 60, change: 1, change_pct: 1.69 };
       pfQuotes.BBB = { status: "fresh", price: 100, change: -2, change_pct: -1.96 };
       pfQuotes.CCC = { status: "deferred" };`);
  const v = app("portfolioView()");
  assert.equal(v.value, 1000);                       // 600 + 400; CCC has no price
  assert.equal(v.priced, 2);
  assert.equal(v.day, 2);                            // +10 − 8
  assert.equal(v.pnl, 100);                          // AAA only: BBB has no cost, CCC no price
  assert.equal(v.ret, 0.2);
  assert.equal(v.rows[0].t, "AAA");                  // largest first, unpriced last
  assert.equal(v.rows[2].t, "CCC");
  assert.equal(v.rows[0].weight, 0.6);
  app("renderPortfolio()");
  const sum = app(`document.getElementById("pfSummary").innerHTML`);
  assert.match(sum, /2 of 3 priced/);
  assert.match(sum, /1 of 3 with cost/);
  assert.match(app(`document.getElementById("pfTable").innerHTML`), /Add an average cost/);
});
