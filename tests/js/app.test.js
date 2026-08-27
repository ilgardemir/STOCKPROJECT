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
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, focus() {}, blur() {},
    click() {}, closest: () => null, scrollIntoView() {}, insertAdjacentHTML() {}, remove() {},
    dispatchEvent: () => true, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }),
    querySelectorAll: () => [], getContext: () => new Proxy({}, { get: () => () => ({}) }),
    parentNode: null, parentElement: null, firstChild: null
  };
  el.querySelector = () => makeEl(id + "-child");
  return el;
}

function loadApp() {
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
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
