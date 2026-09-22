"use strict";

/*
 * A stream that never speaks must not look like a stream that is working.
 *
 * The failure this file exists to prevent: /ilgar sits on "Starting the historical
 * analysis" at 1% forever, with no error, no Retry, and the Run button latched
 * disabled — because that label is set CLIENT-side before the EventSource is even
 * created, and nothing downstream is obliged to ever replace it.
 *
 * Two independent holes produced that single symptom, so there are two halves here:
 *
 *   Server — the request handler is `async` and was passed straight to
 *   http.createServer, which does not await it. A throw anywhere in a route
 *   therefore abandoned the client's connection with no status and no body (the
 *   browser's EventSource stays in CONNECTING and never fires `error`, so the page
 *   cannot tell), while separately surfacing as an unhandled rejection that takes
 *   the whole process down for everyone else.
 *
 *   Client — an EventSource that is silent is indistinguishable from one that is
 *   busy. There was no timeout of any kind on /ilgar, so "the server never
 *   answered" rendered exactly like "the model is still thinking".
 *
 * These are verified by injecting a throw at a place production genuinely calls
 * (res.writeHead / res.write both throw for real: ERR_INVALID_CHAR on a header
 * value, ERR_STREAM_DESTROYED on a dead socket) rather than by adding a test-only
 * seam to server.js.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

const ROOT = path.resolve(__dirname, "../..");
const SERVER = path.join(ROOT, "server.js");
const realRequire = createRequire(SERVER);

/*
 * A local runner rather than tests/js/run.js. That harness calls fn() without
 * awaiting it, so an async test that rejects resolves to a promise nobody reads and
 * is reported as "ok" — a checker whose failure mode is a silent pass. Half the
 * cases here are async, so they run on their own runner, the same way
 * stream-retry.test.js does.
 */
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ── Server half ───────────────────────────────────────────────────────────────

/**
 * Loads server.js with its engines stubbed and no listening socket, then drives one
 * request through the real handler. `breakOn` decides where the injected fault lands:
 * "head" throws out of the first writeHead (before any byte reaches the client),
 * "body" throws out of the second write (after the stream is already open).
 */
async function driveRequest(route, breakOn) {
  let handler;
  const scopedRequire = name => name === "http"
    ? { createServer(fn) { handler = fn; return {}; } }
    : realRequire(name);

  const sandbox = {
    require: scopedRequire, module: { exports: {} }, __dirname: ROOT,
    process: { ...process, env: { ...process.env, OPENROUTER_API_KEY: "",
      PYTHON_BIN: process.execPath,
      SQUALL_SCRAPER_PATH: path.join(ROOT, "tests/stubs/scraper_stub.js"),
      SQUALL_BACKTESTER_PATH: path.join(ROOT, "tests/stubs/backtester_stub.js") },
      on() {} },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, TextDecoder, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error("no provider in this test"); }
  };
  vm.runInNewContext(fs.readFileSync(SERVER, "utf8"), sandbox, { filename: SERVER });

  const req = Object.assign(new EventEmitter(), {
    method: "GET", url: route, headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" }
  });

  let output = "", heads = 0, writes = 0, finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, headersSent: false,
    setHeader() {},
    writeHead(status) {
      // Node throws ERR_INVALID_CHAR here for a header value carrying a control
      // character, which sseHeaders can produce from a limiter field.
      if (breakOn === "head" && ++heads === 1) throw new TypeError("Invalid character in header content");
      this.headersSent = true;
      output += `HTTP ${status}\n`;
      return this;
    },
    write(text) {
      if (breakOn === "body" && ++writes === 2) throw new Error("ERR_STREAM_DESTROYED");
      output += text;
      return true;
    },
    end(text = "") { output += text; this.writableEnded = true; finish(); return this; }
  });

  // The contract under test is the one http.createServer actually relies on: the
  // callback must settle without rejecting, whatever the route does.
  await assert.doesNotReject(() => Promise.resolve(handler(req, res)),
    "The request handler must never reject — an unhandled rejection kills the process");

  // The wrapper is deliberately fire-and-forget (http.createServer ignores a returned
  // promise), so the assertion has to wait on the RESPONSE, not on the call. A test
  // that reads `output` straight after handler() measures nothing and passes on a
  // server that answers nobody — the exact failure being fixed.
  let timer;
  try {
    await Promise.race([ended, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The response was never ended — the client would hang here")), 15000);
    })]);
  } finally { clearTimeout(timer); }
  return { output, res };
}

test("a route that throws before any byte still tells the /ilgar client", async () => {
  const { output, res } = await driveRequest("/backtest-stream?ticker=AAA&as_of=2023-03-15", "head");
  assert.match(output, /event: backtest_error\n/,
    "A silent connection is the bug: the browser must receive a terminal event it listens for");
  assert.equal(res.writableEnded, true, "The response must be closed, not left hanging");
});

test("a route that throws mid-stream closes the /ilgar stream instead of stalling", async () => {
  const { res } = await driveRequest("/backtest-stream?ticker=AAA&as_of=2023-03-15", "body");
  assert.equal(res.writableEnded, true,
    "Headers were already sent, so the only remaining duty is to end the response");
});

test("the analyzer and screener get their own route's terminal event name", async () => {
  // The SSE event names are a contract per CLAUDE.md; a fail-safe that emits the
  // wrong one is as silent as emitting nothing, because app.js is not listening.
  const analyzer = await driveRequest("/analyze-stream?ticker=AAA", "head");
  assert.match(analyzer.output, /event: error\n/);
  const screener = await driveRequest("/screen-stream?q=cheap%20industrials", "head");
  assert.match(screener.output, /event: screen_error\n/);
});

// ── Client half ───────────────────────────────────────────────────────────────

/** The smallest DOM /ilgar's runBacktest actually touches, plus controllable timers. */
function loadBacktester() {
  const els = new Map();
  const el = () => ({
    value: "", max: "", disabled: false, textContent: "", innerHTML: "",
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, focus() {},
    querySelector: () => ({ setAttribute() {} }),
    querySelectorAll: () => []
  });
  const timers = [];
  const sandbox = {
    document: {
      getElementById: id => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
    },
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    requestAnimationFrame: fn => { fn(); return 1; },
    console: { log() {}, warn() {}, error() {} },
    devicePixelRatio: 1,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    EventSource: function () {
      this.listeners = {};
      this.closed = false;
      this.addEventListener = (name, fn) => { this.listeners[name] = fn; };
      this.close = () => { this.closed = true; };
      sandbox.__lastSource = this;
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "backtester.js"), "utf8"), sandbox,
    { filename: "backtester.js" });
  sandbox.__els = els;
  // Fires every timer armed so far whose deadline is at or under `ms`.
  sandbox.__advance = ms => timers.filter(t => !t.cleared && !t.fired && t.ms <= ms)
    .forEach(t => { t.fired = true; t.fn(); });
  return sandbox;
}

function startRun(BT) {
  BT.__els.clear();
  const el = BT.document.getElementById("backtestTicker"); el.value = "AAPL";
  BT.document.getElementById("backtestDate").value = "2024-03-15";
  BT.runBacktest();
  return BT;
}

test("a stream that never sends an event is reported, not left spinning at 1%", () => {
  const BT = startRun(loadBacktester());
  const progress = BT.__els.get("backtestProgressText");
  assert.match(progress.textContent, /Starting the historical analysis/,
    "Precondition: this is the label the user is stuck on");

  BT.__advance(60000);

  assert.doesNotMatch(progress.textContent, /Starting the historical analysis/,
    "After the watchdog fires the page must no longer claim it is starting");
  assert.match(BT.__els.get("backtestError").innerHTML, /\S/,
    "The user needs a visible reason, not a frozen progress bar");
  assert.equal(BT.__els.get("backtestRun").disabled, false,
    "A latched button leaves a page reload as the only way to retry");
  assert.equal(BT.__lastSource.closed, true, "The dead stream must be released");
});

test("the watchdog is reset by activity, so a working run is never cut off", () => {
  const BT = startRun(loadBacktester());
  const source = BT.__lastSource;
  source.listeners.backtest_progress({ data: JSON.stringify({ percent: 42, label: "Loading price history" }) });

  BT.__advance(60000);

  assert.match(BT.__els.get("backtestProgressText").textContent, /Loading price history/,
    "An event arrived, so the run is alive and must be left alone");
  assert.equal(BT.__els.get("backtestError").innerHTML, "");
});

test("a half-executed profile UI cannot alter or prevent a fixed-policy replay", () => {
  const BT = loadBacktester();
  // The exact shape of a top-level throw in app.js: the hoisted function declaration
  // survives, so `typeof` still says "function", but the `let` it reads is stranded in
  // its temporal dead zone. Guarding the binding is impossible from here; only the call
  // can be guarded.
  BT.getMySquallProfile = () => { throw new ReferenceError("Cannot access 'mySquallProfile' before initialization"); };
  startRun(BT);

  assert.equal(BT.__lastSource instanceof BT.EventSource, true,
    "The stream must still open — MySquall is personalization, not a prerequisite");
  assert.equal(BT.__els.get("backtestError").innerHTML, "",
    "The fixed replay policy never reads or substitutes a MySquall profile");
  assert.doesNotMatch(BT.__els.get("backtestProgressText").textContent, /Could not start/,
    "This is a degraded run, not a failed one");
});

test("replay v2 never consults MySquall preferences", () => {
  const BT = loadBacktester();
  let calls = 0;
  BT.getMySquallProfile = () => { calls++; return {risk:5,horizon:5}; };
  // What chrome-top.html's recorder would have captured at load.
  BT.__squallLoadError = { message: "x is not a function", source: "app.js", line: 452, column: 3,
    text: "app.js:452 — x is not a function" };
  startRun(BT);
  assert.equal(calls, 0, "Personalization must not change a locked replay policy");
});

test("a throw while opening the stream is reported instead of latching the button", () => {
  const BT = loadBacktester();
  BT.EventSource = function () { throw new TypeError("Failed to construct 'EventSource'"); };
  startRun(BT);
  assert.match(BT.__els.get("backtestError").innerHTML, /\S/,
    "Nothing else in the page can report this — the exception escapes into the submit handler");
  assert.equal(BT.__els.get("backtestRun").disabled, false);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of cases) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} stream fail-safe tests passed`);
  if (failed) process.exitCode = 1;
})();
