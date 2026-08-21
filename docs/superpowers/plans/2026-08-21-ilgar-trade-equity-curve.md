# /ilgar Graphed Trade + Richer Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the model commit to a machine-readable trade at the cutoff, simulate it against sealed post-cutoff bars, and graph the result against the stock and SPY — while feeding the model a far richer point-in-time snapshot than raw EDGAR rows.

**Architecture:** `backtester.py` seals post-cutoff bars into the existing withheld `outcomes` object. After the blind prose stream ends, `server.js` makes a second non-streaming call that extracts a strict JSON decision, sanitizes it against fixed enums, and runs a pure JS simulation over those sealed bars. The browser draws two canvases. No model call ever sees a post-cutoff bar.

**Tech Stack:** Node 18+ raw `http` (zero npm dependencies), Python 3 + pandas + yahooquery, vanilla JS + canvas, custom zero-dep test harness.

**Spec:** `docs/superpowers/specs/2026-08-21-ilgar-trade-equity-curve-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero npm dependencies.** Node ships none. Do not add any. Python deps go in `requirements.txt` only if unavoidable — this plan needs none beyond what is installed.
- **stdout is sacred in Python engines.** Any stray `print()` to stdout corrupts the JSON the server parses. Diagnostics go to stderr as `PROGRESS|percent|label` or `WARN|source|detail`.
- **Serialize the whole payload to a string before writing a byte.** Use `sys.stdout.write(json.dumps(obj, separators=(",", ":"), allow_nan=False))`. Never `json.dump(obj, sys.stdout)`.
- **`allow_nan=False` on every `json.dumps`.** The permissive default emits bare `NaN`/`Infinity`, which is not valid JSON and fails in Node with no clue which field caused it.
- **Guard NaN before `int()`.** `int(x or 0)` is not a guard: `bool(float("nan"))` is `True`. Use the local `finite()` helper.
- **All sec.gov calls route through `scraper._sec_get`** (which calls `_sec_throttle`). Never a raw `requests.get` to sec.gov.
- **SSE event names are a contract** between `send(event, …)` in `server.js` and `addEventListener(event, …)` in `backtester.js`. Task 6 adds a check that enforces this.
- **CSS: no literal colors or font-families in a rule** — use the `var(--…)` tokens. (Literal `px` font-sizes match the existing file and are fine.) Nothing renders below 10px.
- **Canvas code keys off `data-mode`, never `data-theme`,** and repaints on the `squall:theme` CustomEvent. A canvas silently losing its colors is the failure mode and nothing errors.
- **Release the Python concurrency slot exactly once** via the guarded closure `acquirePy` returns. Never decrement `pyRunning` directly.
- **Charge the AI budget once per logical request,** never per attempt. Both OpenRouter calls on `/backtest-stream` share the single existing `spendAi(COST.analyze.ai)` charge.
- **Python is NOT available on the primary dev box.** `python3`, `python` and `py` all resolve to the Microsoft Store stub. Consequences: `npm test` will fail at the Python step locally, and `npm run test:js` is the only suite runnable there. Python tests must be run on Railway or a Python-equipped machine before the feature is called done. Server behaviour is verified locally with `PYTHON_BIN=node` plus a `.js` stub via `SQUALL_BACKTESTER_PATH` — Task 4 supplies that stub.
- **Commit after every task.** CLAUDE.md asks for commit + push per completed change; a collaborator shares this repo.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `server.js` | `simulateTrade`, `sanitizeBacktestDecision`, `requestBacktestDecision`, route wiring | 1, 2, 4 |
| `backtester.py` | Sealed bars, dual price basis, engine reuse, relative context, TTM valuation, prompt projection | 3, 7–10, 12–14 |
| `backtester.js` | `drawLineChart`, equity curve, setup chart, decision card | 5, 11, 15 |
| `styles.css` | Chart containers, legend, decision card | 5, 11, 15 |
| `tests/js/server.test.js` | Simulation + sanitizer tests | 1, 2 |
| `tests/python/test_backtester.py` | Sealed bars, price basis, TTM, prompt projection | 3, 7, 10, 13, 14 |
| `scripts/check_sse_contract.py` | New — enforces the SSE event-name contract | 6 |
| `tests/fixtures/backtest_bars.json` | New — shared bar fixture for JS simulation tests | 1 |

---

# Phase 1 — Decision, simulation, equity curve

Delivers the graph. Depends on nothing in Phase 2 or 3.

---

### Task 1: `simulateTrade` — the pure simulation

**Files:**
- Modify: `server.js` (add near `validateBacktestDate`, ~line 775)
- Modify: `tests/js/server.test.js`
- Create: `tests/fixtures/backtest_bars.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `simulateTrade(decision, bars)` → `{ curve, entry, exit, stats } | null`, exported from `server.js`.
  - `decision`: `{ direction: "long"|"short"|"flat", horizon: "1m"|"3m"|"6m", stop_pct: number|null, target_pct: number|null }`
  - `bars`: `{ dates: string[], open: number[], close: number[], spyOpen: number[], spyClose: number[] }`
  - `curve`: `Array<{ d: string, trade: number|null, stock: number|null, spy: number|null }>` — all indexed to 10000
  - `exit`: `{ date: string, price: number, reason: "stop"|"target"|"horizon"|"end" } | null`
  - `stats`: `{ trade_return, stock_return, spy_return, excess_vs_spy, max_dd }` — each `number|null`

- [ ] **Step 1: Create the shared bar fixture**

Create `tests/fixtures/backtest_bars.json`. 12 sessions. The stock opens at 100, climbs to 112, then falls hard enough that an 8% stop (trigger price 92.0) is breached on the close of index 8 (91.0), filling at index 9's open of 90.0. SPY drifts up.

```json
{
  "dates": ["2023-03-16","2023-03-17","2023-03-20","2023-03-21","2023-03-22","2023-03-23","2023-03-24","2023-03-27","2023-03-28","2023-03-29","2023-03-30","2023-03-31"],
  "open":  [100.0, 103.0, 106.0, 109.0, 112.0, 110.0, 106.0, 100.0, 95.0, 90.0, 92.0, 94.0],
  "close": [103.0, 106.0, 109.0, 112.0, 110.0, 106.0, 100.0, 95.0, 91.0, 92.0, 94.0, 96.0],
  "spyOpen":  [200.0, 201.0, 202.0, 203.0, 204.0, 204.0, 205.0, 205.0, 206.0, 206.0, 207.0, 208.0],
  "spyClose": [201.0, 202.0, 203.0, 204.0, 204.0, 205.0, 205.0, 206.0, 206.0, 207.0, 208.0, 210.0]
}
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/js/server.test.js`. Extend the destructured `require` at the top to include `simulateTrade`:

```js
const {
  sanitizeProfile, fallbackScreenerSpec, sanitizeScreenerSpec,
  validateBacktestDate, simulateTrade,
  LIM, COST, clientIp, clientKey, admit, buckets, globals
} = require("../../server");
const BARS = require("../fixtures/backtest_bars.json");
```

Then append these tests:

```js
test("simulated long exits at the next open after a stop is breached on the close", () => {
  const result = simulateTrade(
    { direction: "long", horizon: "6m", stop_pct: 0.08, target_pct: null }, BARS);
  // entry is bar 0's open; stop trigger is 100 * 0.92 = 92.0
  assert.equal(result.entry.price, 100);
  assert.equal(result.entry.date, "2023-03-16");
  // close 91.0 at index 8 breaches; fill at index 9's open of 90.0
  assert.equal(result.exit.reason, "stop");
  assert.equal(result.exit.date, "2023-03-29");
  assert.equal(result.exit.price, 90);
  assert.equal(Math.round(result.stats.trade_return * 1e6) / 1e6, -0.1);
  // the trade line is flat in cash from the exit bar onward
  assert.equal(result.curve[9].trade, result.curve[11].trade);
  // the stock line keeps moving after the trade is out
  assert.notEqual(result.curve[9].stock, result.curve[11].stock);
});

test("simulated long exits at the horizon when no stop or target is hit", () => {
  const result = simulateTrade(
    { direction: "long", horizon: "1m", stop_pct: null, target_pct: null }, BARS);
  // 21 sessions requested but only 12 exist, so the window runs out first
  assert.equal(result.exit.reason, "end");
  assert.equal(result.exit.date, "2023-03-31");
  assert.equal(result.exit.price, 96);
});

test("simulated long takes profit at the next open after the target prints", () => {
  const result = simulateTrade(
    { direction: "long", horizon: "6m", stop_pct: null, target_pct: 0.10 }, BARS);
  // target trigger 110.0; close 112.0 at index 3 clears it, fill at index 4's open 112.0
  assert.equal(result.exit.reason, "target");
  assert.equal(result.exit.date, "2023-03-22");
  assert.equal(result.exit.price, 112);
  assert.equal(Math.round(result.stats.trade_return * 1e6) / 1e6, 0.12);
});

test("a short profits as the stock falls and flips the stop to the upside", () => {
  const result = simulateTrade(
    { direction: "short", horizon: "6m", stop_pct: 0.08, target_pct: null }, BARS);
  // for a short the stop is a RISE through 100 * 1.08 = 108.0
  // close 109.0 at index 2 breaches; fill at index 3's open of 109.0
  assert.equal(result.exit.reason, "stop");
  assert.equal(result.exit.price, 109);
  // short equity multiplier is 2 - price/entry = 2 - 1.09 = 0.91
  assert.equal(Math.round(result.stats.trade_return * 1e6) / 1e6, -0.09);
});

test("a flat call draws no trade line but still returns both benchmarks", () => {
  const result = simulateTrade(
    { direction: "flat", horizon: "3m", stop_pct: null, target_pct: null }, BARS);
  assert.equal(result.exit, null);
  assert.equal(result.stats.trade_return, null);
  assert.equal(result.curve.every(p => p.trade === null), true);
  assert.equal(result.curve.every(p => typeof p.stock === "number"), true);
  assert.equal(result.curve.every(p => typeof p.spy === "number"), true);
  // buy-and-hold still measurable: 96/100 - 1
  assert.equal(Math.round(result.stats.stock_return * 1e6) / 1e6, -0.04);
});

test("simulateTrade refuses a window with no usable bars", () => {
  assert.equal(simulateTrade({ direction: "long", horizon: "3m" },
    { dates: [], open: [], close: [], spyOpen: [], spyClose: [] }), null);
  assert.equal(simulateTrade({ direction: "long", horizon: "3m" }, null), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:js`
Expected: FAIL — `simulateTrade is not a function` on all six new tests. The 8 pre-existing tests still pass.

- [ ] **Step 4: Implement `simulateTrade`**

Add to `server.js` immediately after `validateBacktestDate` (~line 785):

```js
// Sessions per horizon — must stay in sync with HORIZONS in backtester.py.
const BT_HORIZON_SESSIONS = { "1m": 21, "3m": 63, "6m": 126 };
const BT_START_EQUITY = 10000;

function btFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Simulates the model's decision over the sealed post-cutoff window.
 *
 * Pure: no I/O, no clock, no globals — so it drops straight into tests/js.
 *
 * Deliberately conservative. Stops and targets are tested against the daily CLOSE
 * and fill at the NEXT session's open, because testing against the intraday low
 * and filling at the stop price assumes a fill you could not have been guaranteed
 * through a gap — and the OHLC here is back-adjusted, so those extremes are not
 * the prices that actually printed anyway.
 */
function simulateTrade(decision, bars) {
  const dates = (bars && bars.dates) || [];
  const open = (bars && bars.open) || [];
  const close = (bars && bars.close) || [];
  const spyOpen = (bars && bars.spyOpen) || [];
  const spyClose = (bars && bars.spyClose) || [];
  const n = Math.min(dates.length, open.length, close.length);
  if (!n) return null;

  const entry = btFinite(open[0]);
  if (!(entry > 0)) return null;
  const spyEntry = btFinite(spyOpen[0]);

  const direction = decision && decision.direction;
  const long = direction === "long";
  const short = direction === "short";
  const trading = long || short;

  const stopPct = decision ? btFinite(decision.stop_pct) : null;
  const targetPct = decision ? btFinite(decision.target_pct) : null;
  const horizonN = BT_HORIZON_SESSIONS[decision && decision.horizon] || BT_HORIZON_SESSIONS["3m"];

  // Both percentages are positive distances from entry; the direction decides the side.
  const stopPrice = stopPct == null ? null : long ? entry * (1 - stopPct) : entry * (1 + stopPct);
  const targetPrice = targetPct == null ? null : long ? entry * (1 + targetPct) : entry * (1 - targetPct);
  const equity = price => BT_START_EQUITY * (long ? price / entry : 2 - price / entry);

  let exitIdx = null, exitPrice = null, exitReason = null;
  if (trading) {
    for (let i = 0; i < n; i++) {
      const c = btFinite(close[i]);
      if (c == null) continue;
      const hitStop = stopPrice != null && (long ? c <= stopPrice : c >= stopPrice);
      const hitTarget = targetPrice != null && (long ? c >= targetPrice : c <= targetPrice);
      const hitHorizon = i + 1 >= horizonN;
      if (!hitStop && !hitTarget && !hitHorizon) continue;
      // Fill at the next session's open. On the final bar there is no next open,
      // so the close stands in rather than inventing a price.
      const next = i + 1;
      exitIdx = next < n ? next : i;
      exitPrice = next < n ? btFinite(open[next]) : c;
      if (exitPrice == null) exitPrice = c;
      exitReason = hitStop ? "stop" : hitTarget ? "target" : "horizon";
      break;
    }
    if (exitIdx === null) {
      exitIdx = n - 1;
      exitPrice = btFinite(close[n - 1]);
      exitReason = "end";
    }
  }

  const curve = [];
  for (let i = 0; i < n; i++) {
    const c = btFinite(close[i]);
    const sc = btFinite(spyClose[i]);
    let trade = null;
    if (trading && exitPrice != null && i >= exitIdx) trade = equity(exitPrice);
    else if (trading && c != null) trade = equity(c);
    curve.push({
      d: dates[i],
      trade,
      stock: c == null ? null : BT_START_EQUITY * (c / entry),
      spy: sc == null || !(spyEntry > 0) ? null : BT_START_EQUITY * (sc / spyEntry)
    });
  }

  const lastClose = btFinite(close[n - 1]);
  const lastSpy = btFinite(spyClose[n - 1]);
  const stats = {
    trade_return: trading && exitPrice != null ? equity(exitPrice) / BT_START_EQUITY - 1 : null,
    stock_return: lastClose == null ? null : lastClose / entry - 1,
    spy_return: lastSpy == null || !(spyEntry > 0) ? null : lastSpy / spyEntry - 1,
    excess_vs_spy: null,
    max_dd: null
  };
  if (stats.trade_return != null && stats.spy_return != null)
    stats.excess_vs_spy = stats.trade_return - stats.spy_return;
  if (trading) {
    let peak = BT_START_EQUITY, dd = 0;
    for (const point of curve) {
      if (point.trade == null) continue;
      peak = Math.max(peak, point.trade);
      dd = Math.min(dd, point.trade / peak - 1);
    }
    stats.max_dd = dd;
  }

  return {
    curve,
    entry: { date: dates[0], price: entry },
    exit: trading ? { date: dates[exitIdx], price: exitPrice, reason: exitReason } : null,
    stats
  };
}
```

Then add `simulateTrade` to `module.exports` (~line 2228):

```js
  fallbackRefineScreener, readMarketUniverse, validateBacktestDate, simulateTrade,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:js`
Expected: PASS — `14/14 JavaScript tests passed`.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/js/server.test.js tests/fixtures/backtest_bars.json
git commit -m "Add pure trade simulation for the historical analyzer

Close-based stop and target evaluation filling at the next session's open,
with long and short sharing one sign-flipped path. Pure and exported so the
zero-dep harness can exercise stop fills, target fills, horizon exits and
the flat case against a fixed bar fixture.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `sanitizeBacktestDecision` — trust nothing the model returns

**Files:**
- Modify: `server.js` (add immediately before `simulateTrade`)
- Modify: `tests/js/server.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sanitizeBacktestDecision(raw)` → `{ direction, conviction, horizon, stop_pct, target_pct, thesis } | null`, exported from `server.js`. Accepts an object or a JSON string. Returns `null` when there is no usable decision.

- [ ] **Step 1: Write the failing tests**

Add `sanitizeBacktestDecision` to the destructured `require` in `tests/js/server.test.js`, then append:

```js
test("backtest decisions are clamped to the supported enums and ranges", () => {
  const safe = sanitizeBacktestDecision({
    direction: "  LONG ", conviction: 99, horizon: "2y",
    stop_pct: -0.08, target_pct: 0.25,
    thesis: "  base breakout  on\nvolume  "
  });
  assert.equal(safe.direction, "long");
  assert.equal(safe.conviction, 5);
  assert.equal(safe.horizon, "3m");
  // a negative percentage is a sign convention, not an error — a stop is always a loss
  assert.equal(safe.stop_pct, 0.08);
  assert.equal(safe.target_pct, 0.25);
  assert.equal(safe.thesis, "base breakout on volume");
});

test("backtest decisions reject prices masquerading as percentages", () => {
  // 145 is a stop PRICE, not a fraction — out of range, so it is dropped rather than simulated
  const safe = sanitizeBacktestDecision({ direction: "long", stop_pct: 145.2, target_pct: 0.2 });
  assert.equal(safe.stop_pct, null);
  assert.equal(safe.target_pct, 0.2);
});

test("a flat backtest call cannot carry a stop or target", () => {
  const safe = sanitizeBacktestDecision({ direction: "flat", stop_pct: 0.08, target_pct: 0.2 });
  assert.equal(safe.direction, "flat");
  assert.equal(safe.stop_pct, null);
  assert.equal(safe.target_pct, null);
});

test("an unusable backtest decision degrades to no decision", () => {
  assert.equal(sanitizeBacktestDecision({ direction: "moon" }), null);
  assert.equal(sanitizeBacktestDecision("not json at all"), null);
  assert.equal(sanitizeBacktestDecision(null), null);
  assert.equal(sanitizeBacktestDecision([]), null);
  // a JSON string is accepted, since that is what the model returns
  assert.equal(sanitizeBacktestDecision('{"direction":"short"}').direction, "short");
  // conviction is display-only and defaults rather than failing the decision
  assert.equal(sanitizeBacktestDecision('{"direction":"short"}').conviction, 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:js`
Expected: FAIL — `sanitizeBacktestDecision is not a function` on all four new tests.

- [ ] **Step 3: Implement the sanitizer**

Add to `server.js` immediately before `BT_HORIZON_SESSIONS`:

```js
const BT_DIRECTIONS = new Set(["long", "short", "flat"]);
const BT_HORIZONS = new Set(["1m", "3m", "6m"]);

/**
 * Re-checks the model's structured call against fixed enums and ranges, the same way
 * sanitizeScreenerSpec does — nothing the model returns reaches the simulation on trust.
 *
 * Two conventions worth knowing. Stop and target are POSITIVE DISTANCES from entry and
 * the `direction` decides the side, so a model that signs its stop negative is expressing
 * the same intent and gets its magnitude taken rather than being dropped. And a value at
 * or above the range ceiling is almost always an absolute PRICE the model returned where
 * a fraction was asked for — dropping it is right, because simulating a $145 "8% stop"
 * would silently produce a fabricated result.
 */
function sanitizeBacktestDecision(raw) {
  let obj = raw;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const direction = String(obj.direction || "").trim().toLowerCase();
  if (!BT_DIRECTIONS.has(direction)) return null;

  const conviction = Math.round(Number(obj.conviction));
  const horizon = String(obj.horizon || "").trim().toLowerCase();
  const pct = (value, max) => {
    const n = Math.abs(Number(value));
    return Number.isFinite(n) && n >= 0.01 && n <= max ? n : null;
  };
  const flat = direction === "flat";

  return {
    direction,
    // Display-only: conviction never scales the position. A missing or absurd value
    // must not throw away an otherwise usable decision.
    conviction: Number.isFinite(conviction) ? Math.min(5, Math.max(1, conviction)) : 3,
    horizon: BT_HORIZONS.has(horizon) ? horizon : "3m",
    stop_pct: flat ? null : pct(obj.stop_pct, 0.5),
    target_pct: flat ? null : pct(obj.target_pct, 2),
    thesis: String(obj.thesis || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240)
  };
}
```

Add `sanitizeBacktestDecision` to `module.exports` alongside `simulateTrade`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:js`
Expected: PASS — `18/18 JavaScript tests passed`.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/js/server.test.js
git commit -m "Sanitize the historical analyzer's structured trade call

Fixed enums for direction and horizon, clamped conviction, and percentage
ranges that drop an absolute price returned where a fraction was asked for.
A flat call cannot carry a stop or target, and an unusable reply degrades to
no decision rather than a fabricated trade.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Seal the post-cutoff bars into `outcomes`

**Files:**
- Modify: `backtester.py` (add after `forward_outcomes`, ~line 152; extend `outcomes` in `main`, ~line 298)
- Modify: `tests/python/test_backtester.py`

**Interfaces:**
- Consumes: existing `split_at_date(frame, as_of)`, `finite(value)`.
- Produces: `sealed_bars(stock_frame, spy_frame, as_of, max_sessions=126)` → dict with keys `dates`, `open`, `close`, `spyOpen`, `spyClose`. Lands at `outcomes["bars"]`. Shape matches exactly what `simulateTrade` consumes in Task 1.

- [ ] **Step 1: Write the failing test**

Append to `tests/python/test_backtester.py`:

```python
    def test_sealed_bars_contain_only_post_cutoff_sessions(self):
        index = pd.date_range("2024-01-01", periods=40, freq="B")
        close = np.arange(100.0, 140.0)
        stock = pd.DataFrame({"open": close - 0.5, "high": close + 1, "low": close - 1,
                              "close": close, "volume": 1_000_000}, index=index)
        spy = pd.DataFrame({"open": close * 2, "high": close * 2, "low": close * 2,
                            "close": close * 2, "volume": 5_000}, index=index)
        cutoff = index[9].date()

        bars = backtester.sealed_bars(stock, spy, cutoff)

        self.assertEqual(bars["dates"][0], index[10].date().isoformat())
        self.assertTrue(all(d > cutoff.isoformat() for d in bars["dates"]))
        self.assertEqual(len(bars["dates"]), 30)
        self.assertEqual(len(bars["open"]), len(bars["dates"]))
        self.assertEqual(len(bars["spyClose"]), len(bars["dates"]))
        self.assertAlmostEqual(bars["open"][0], close[10] - 0.5)
        self.assertAlmostEqual(bars["spyClose"][0], close[10] * 2)

    def test_sealed_bars_are_capped_and_survive_a_missing_benchmark(self):
        index = pd.date_range("2024-01-01", periods=200, freq="B")
        close = np.arange(100.0, 300.0)
        stock = pd.DataFrame({"open": close, "high": close, "low": close,
                              "close": close, "volume": 1}, index=index)
        cutoff = index[0].date()

        bars = backtester.sealed_bars(stock, pd.DataFrame(), cutoff, max_sessions=126)

        self.assertEqual(len(bars["dates"]), 126)
        # A missing benchmark must not shorten or misalign the stock series.
        self.assertEqual(len(bars["spyClose"]), 126)
        self.assertTrue(all(v is None for v in bars["spyClose"]))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest tests.python.test_backtester -v` (on a Python-equipped machine — see Global Constraints)
Expected: FAIL with `AttributeError: module 'backtester' has no attribute 'sealed_bars'`.

- [ ] **Step 3: Implement `sealed_bars`**

Add to `backtester.py` immediately after `forward_outcomes`:

```python
def _column(frame, name):
    for col in frame.columns:
        if str(col).lower() == name:
            return col
    return None


def sealed_bars(stock_frame, spy_frame, as_of, max_sessions=None):
    """
    The post-cutoff window the Node simulation replays the model's call over.

    Kept in `outcomes` rather than `snapshot` so the server's existing seal covers it:
    these bars are the future and must never reach either model call. SPY is aligned to
    the stock's session dates and padded with None where it has no bar, so the two
    series stay index-aligned for the front end without silently shortening either.
    """
    limit = max_sessions or HORIZONS["6m"]
    _, after = split_at_date(stock_frame, as_of)
    if after.empty:
        return {"dates": [], "open": [], "close": [], "spyOpen": [], "spyClose": []}
    after = after.iloc[:limit]

    open_col, close_col = _column(after, "open"), _column(after, "close")
    if close_col is None:
        return {"dates": [], "open": [], "close": [], "spyOpen": [], "spyClose": []}

    spy_after = pd.DataFrame()
    if isinstance(spy_frame, pd.DataFrame) and not spy_frame.empty:
        _, spy_after = split_at_date(spy_frame, as_of)
    spy_open_col = _column(spy_after, "open") if not spy_after.empty else None
    spy_close_col = _column(spy_after, "close") if not spy_after.empty else None

    def rounded(value):
        number = finite(value)
        return None if number is None else round(number, 4)

    dates, opens, closes, spy_opens, spy_closes = [], [], [], [], []
    for stamp, row in after.iterrows():
        dates.append(stamp.date().isoformat())
        closes.append(rounded(row[close_col]))
        opens.append(rounded(row[open_col]) if open_col is not None else rounded(row[close_col]))
        if spy_close_col is not None and stamp in spy_after.index:
            spy_row = spy_after.loc[stamp]
            spy_closes.append(rounded(spy_row[spy_close_col]))
            spy_opens.append(rounded(spy_row[spy_open_col]) if spy_open_col is not None
                             else rounded(spy_row[spy_close_col]))
        else:
            spy_closes.append(None)
            spy_opens.append(None)

    return {"dates": dates, "open": opens, "close": closes,
            "spyOpen": spy_opens, "spyClose": spy_closes}
```

- [ ] **Step 4: Attach the bars to `outcomes`**

In `main()`, replace the `outcomes = { … }` block (~line 298) with:

```python
    outcomes = {
        **stock_outcome,
        "benchmark": "SPY",
        "benchmark_returns": benchmark_returns,
        "excess_returns": {
            label: (stock_returns.get(label) - benchmark_returns.get(label)
                    if stock_returns.get(label) is not None and benchmark_returns.get(label) is not None else None)
            for label in HORIZONS
        },
        # The window the Node simulation replays the model's call over. Sealed by the
        # server until AI generation ends, exactly like every other key in this object.
        "bars": sealed_bars(frames[ticker], frames.get("SPY", pd.DataFrame()), as_of),
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add backtester.py tests/python/test_backtester.py
git commit -m "Seal the post-cutoff bar window into the historical outcomes

The Node simulation needs the future bars to replay the model's call, so they
ship inside outcomes where the server's existing seal already withholds them
until AI generation ends. SPY is aligned to the stock's session dates and
padded rather than truncated so both series stay index-aligned.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the decision call into the route

**Files:**
- Modify: `server.js` (`buildBacktestAiMessages` area ~line 206; `/backtest-stream` handler ~line 1590–1750)
- Create: `tests/stubs/backtester_stub.js`

**Interfaces:**
- Consumes: `sanitizeBacktestDecision` (Task 2), `simulateTrade` (Task 1), `outcomes.bars` (Task 3).
- Produces: two new SSE events — `backtest_decision` with `{ decision, available }`, and `backtest_outcomes` extended with `{ outcomes, simulation }` where `simulation` is the `simulateTrade` return value or `null`.

- [ ] **Step 1: Add the decision-call helper**

Add to `server.js` immediately after `buildBacktestAiMessages` (~line 222):

```js
/**
 * Extracts the model's committed trade from the analysis it just wrote.
 *
 * Safe to send back to the model: the prose was generated from the frozen snapshot
 * alone, so it contains no post-cutoff data. Reasoning is disabled outright — this is
 * extraction, not analysis, and the thinking budget is pure latency here.
 *
 * Returns a sanitized decision or null. Never throws: a missing decision degrades the
 * page to a stock-vs-SPY chart rather than failing the run.
 */
async function requestBacktestDecision(aiPrompt, prose, signal) {
  const body = JSON.stringify({
    model: AI_MODEL, temperature: 0, max_tokens: 400,
    reasoning: { effort: "none" }, stream: false, provider: AI_PROVIDER,
    messages: [
      { role: "system", content: [
        "You convert a historical equity analysis into one machine-readable trade decision.",
        "Reply with a single JSON object and nothing else — no prose, no code fence.",
        'Schema: {"direction":"long"|"short"|"flat","conviction":1-5,"horizon":"1m"|"3m"|"6m",',
        '"stop_pct":number|null,"target_pct":number|null,"thesis":"one sentence"}.',
        "stop_pct and target_pct are POSITIVE FRACTIONS of the entry price (0.08 means 8%), never prices.",
        "Use \"flat\" when the analysis does not support taking a position."
      ].join(" ") },
      { role: "user", content: `${aiPrompt}\n\n--- THE ANALYSIS YOU WROTE ---\n${prose}` }
    ]
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}`,
          "HTTP-Referer": "http://localhost", "X-Title": "Squall" },
        body
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content || "";
      const decision = sanitizeBacktestDecision(text) || sanitizeBacktestDecision(firstJsonObject(text));
      if (decision) return decision;
      throw new Error("no parseable decision");
    } catch (error) {
      if (error.name === "AbortError") return null;
      if (attempt === 2) {
        console.warn(`BACKTEST decision extraction failed: ${error.message}`);
        return null;
      }
    }
  }
  return null;
}

/** First balanced {…} in a string — models fence or preface JSON despite instructions. */
function firstJsonObject(text) {
  const start = String(text || "").indexOf("{");
  if (start < 0) return null;
  let depth = 0, quote = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (!depth) return text.slice(start, i + 1); }
  }
  return null;
}
```

- [ ] **Step 2: Emit the decision and simulation from the route**

In the `/backtest-stream` handler, replace the `revealOutcomes` closure and the tail after the AI retry loop. Find:

```js
      const revealOutcomes = () => {
        send("backtest_outcomes", { outcomes });
        send("backtest_done", { ok:true });
        res.end();
      };
```

Replace with:

```js
      // Runs only after the AI stream has ended or failed. The decision call and the
      // simulation both happen inside here, so no post-cutoff bar can precede the
      // model's blind analysis on the wire.
      const revealOutcomes = async (prose) => {
        let decision = null;
        if (prose && API_KEY !== "YOUR_OPENROUTER_KEY_HERE") {
          send("backtest_progress", { percent:99, label:"Extracting the trade the model committed to" });
          decision = await requestBacktestDecision(payload.ai_prompt, prose, aiAbort.signal);
        }
        if (!connected) return;
        send("backtest_decision", { decision, available: !!decision });
        const simulation = simulateTrade(decision || { direction:"flat", horizon:"3m" }, outcomes.bars);
        send("backtest_outcomes", { outcomes, simulation });
        send("backtest_done", { ok:true });
        res.end();
      };
```

Then update the three call sites. The AI-budget bail-out becomes:

```js
      const aiBudget = spendAi(COST.analyze.ai);
      if (!aiBudget.ok) {
        send("backtest_ai_error", { error:"AI capacity reached for today. The frozen snapshot and measured outcomes are still available.",
          limited:true, resets_at:aiBudget.resetsAt });
        return revealOutcomes(null);
      }
```

And the tail after the retry loop becomes:

```js
      if (lastError) send("backtest_ai_error", { error:emitted
        ? `The historical write-up was interrupted (${lastError.message}). Outcomes are still shown below.`
        : `Historical AI write-up failed: ${lastError.message}` });
      await revealOutcomes(answer);
```

Note `simulateTrade` is called even when there is no decision — passing a synthetic `flat` still produces the stock and SPY curves, which is what keeps the chart from ever being empty.

- [ ] **Step 3: Create the local verification stub**

Python is unavailable on the dev box, so create `tests/stubs/backtester_stub.js` to exercise the whole route:

```js
// Stands in for backtester.py: same stdin/stdout/stderr contract, no Python needed.
// Run with:  PORT=3271 PYTHON_BIN=node SQUALL_BACKTESTER_PATH=./tests/stubs/backtester_stub.js node server.js
"use strict";
let input = "";
process.stdin.on("data", d => { input += d; });
process.stdin.on("end", () => {
  const job = JSON.parse(input || "{}");
  process.stderr.write("PROGRESS|48|Calculating stub signals\n");
  const snapshot = {
    ticker: "AAA", company_name: "Stub Industries", as_of: job.as_of,
    effective_market_date: job.as_of, price_basis: "Split-adjusted daily OHLCV",
    technical: { metrics: { price: 100, rsi14: 55.5 }, scores: { uptrend: 71 } },
    sec_facts: {}, filings_known_by_cutoff: [],
    availability: { market_history: true, historical_news: false },
    data_sources: { market_history: "stub" }
  };
  const dates = [], open = [], close = [], spyOpen = [], spyClose = [];
  for (let i = 0; i < 40; i++) {
    dates.push(new Date(Date.UTC(2023, 2, 16 + i)).toISOString().slice(0, 10));
    open.push(100 + i * 0.5); close.push(100.5 + i * 0.5);
    spyOpen.push(200 + i * 0.2); spyClose.push(200.2 + i * 0.2);
  }
  process.stdout.write(JSON.stringify({
    mode: "historical_analyzer", snapshot,
    outcomes: {
      effective_as_of: job.as_of, entry_date: dates[0], entry_price: open[0],
      returns: { "1m": 0.08, "3m": null, "6m": null },
      benchmark: "SPY", benchmark_returns: { "1m": 0.02, "3m": null, "6m": null },
      excess_returns: { "1m": 0.06, "3m": null, "6m": null },
      exit_dates: { "1m": dates[20] }, max_drawdown_6m: -0.03,
      bars: { dates, open, close, spyOpen, spyClose }
    },
    ai_prompt: "FROZEN SNAPSHOT PROMPT " + JSON.stringify(snapshot),
    methodology: { signal_cutoff: "stub" },
    generated_at: new Date().toISOString()
  }));
});
```

- [ ] **Step 4: Verify the route end-to-end**

```bash
PORT=3271 PYTHON_BIN=node SQUALL_BACKTESTER_PATH=./tests/stubs/backtester_stub.js node server.js &
sleep 3
curl -sN "http://127.0.0.1:3271/backtest-stream?ticker=AAA&as_of=2023-03-15"
```

Expected, in order: `backtest_progress`, `backtest_snapshot` (containing **no** `outcomes` and **no** `ai_prompt` key), `backtest_ai_start`, `backtest_ai_error` (no API key locally), `backtest_decision` with `available:false`, `backtest_outcomes` carrying both `outcomes` and a `simulation` object whose `curve` has 40 points and whose `trade` values are all `null`, then `backtest_done`.

The critical assertion: **no `backtest_outcomes` or `backtest_decision` event appears before the AI stream terminates.**

- [ ] **Step 5: Run the full JS suite**

Run: `npm run test:js`
Expected: PASS — `18/18 JavaScript tests passed`.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/stubs/backtester_stub.js
git commit -m "Extract and simulate the historical analyzer's trade decision

After the blind prose ends, a second non-streaming call converts the analysis
into a strict JSON decision, which is sanitized and replayed over the sealed
bars. Both calls share the single existing AI charge. A failed or unparseable
decision degrades to a stock-vs-SPY chart rather than failing the run.

Adds a Node stub of the Python engine so the whole route can be exercised on
a box without Python.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Draw the equity curve

**Files:**
- Modify: `backtester.js` (add renderer + two event handlers)
- Modify: `ilgar.html` (add the decision + chart containers)
- Modify: `styles.css`

**Interfaces:**
- Consumes: `backtest_decision` and the extended `backtest_outcomes` from Task 4.
- Produces: `drawLineChart(canvas, series, marks)` — reused by Task 11 for the setup chart.
  - `series`: `Array<{ key, label, color, points: Array<number|null>, dash?: number[], width?: number }>`
  - `marks`: `{ labels: string[], dots?: Array<{ index, series, color, title }>, rules?: Array<{ index, label }>, yFormat?: fn }`

- [ ] **Step 1: Add the containers to `ilgar.html`**

Replace the three empty sections (~lines 57–59) with:

```html
    <section id="backtestSnapshot" aria-live="polite"></section>
    <section id="backtestDecision" aria-live="polite"></section>
    <section id="backtestAi" aria-live="polite"></section>
    <section id="backtestOutcomes" aria-live="polite"></section>
```

- [ ] **Step 2: Add the chart renderer to `backtester.js`**

Append before the trailing `document.getElementById("backtestForm")?.addEventListener(...)` line:

```js
// ─── CHART ────────────────────────────────────────────────────────────────────
// A local renderer rather than app.js's drawChart(), which is welded to
// sessions[active], chartOpts and the analyzer's payload shape — the adapter would
// be larger than this. Colors are read from CSS tokens and repainted on squall:theme,
// because a canvas does not inherit them and silently loses them with no error.
const btCharts = new Map();

function btVar(name, fallback) {
  const value = typeof cssVar === "function" ? cssVar(name) : "";
  return value || fallback;
}

function drawLineChart(canvas, series, marks) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const labels = marks.labels || [];
  const n = labels.length;
  if (n < 2) return;

  const values = [];
  for (const s of series) for (const v of s.points) if (Number.isFinite(v)) values.push(v);
  if (!values.length) return;
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.02 || 1;
  lo -= pad; hi += pad;

  const padL = 58, padR = 14, padT = 14, padB = 26;
  const X = i => padL + (i / (n - 1)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const rule = btVar("--rule", "#262c33");
  const inkDim = btVar("--ink-dim", "#8b959e");
  const fmt = marks.yFormat || (v => Math.round(v).toLocaleString());

  ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (let g = 0; g <= 4; g++) {
    const v = lo + (hi - lo) * (g / 4), y = Y(v);
    ctx.strokeStyle = rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
    ctx.fillStyle = inkDim; ctx.textAlign = "right";
    ctx.fillText(fmt(v), padL - 8, y);
  }

  for (const r of marks.rules || []) {
    if (r.index == null || r.index >= n) continue;
    const x = X(r.index);
    ctx.strokeStyle = rule; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.setLineDash([]);
    if (r.label) {
      ctx.fillStyle = inkDim; ctx.textAlign = "center";
      ctx.fillText(r.label, x, padT + 6);
    }
  }

  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
    ctx.setLineDash(s.dash || []);
    ctx.beginPath();
    let drawing = false;
    s.points.forEach((v, i) => {
      if (!Number.isFinite(v)) { drawing = false; return; }
      if (!drawing) { ctx.moveTo(X(i), Y(v)); drawing = true; }
      else ctx.lineTo(X(i), Y(v));
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const dot of marks.dots || []) {
    const s = series.find(x => x.key === dot.series);
    const v = s && s.points[dot.index];
    if (!Number.isFinite(v)) continue;
    ctx.beginPath(); ctx.arc(X(dot.index), Y(v), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = btVar("--chrome-0", "#0f1215"); ctx.fill();
    ctx.strokeStyle = dot.color; ctx.lineWidth = 1.6; ctx.stroke();
  }

  ctx.fillStyle = inkDim; ctx.textAlign = "left";
  ctx.fillText(labels[0], padL, H - padB + 12);
  ctx.textAlign = "right";
  ctx.fillText(labels[n - 1], W - padR, H - padB + 12);
}

/** Registers a chart so it survives theme swaps and resizes. */
function btRegisterChart(id, build) {
  btCharts.set(id, build);
  build();
}
function btRepaintCharts() { for (const build of btCharts.values()) build(); }
document.addEventListener("squall:theme", btRepaintCharts);
// ResizeObserver rather than a window resize listener: the chart containers are
// flex children, so they can change width without the window doing anything.
const btResize = new ResizeObserver(btRepaintCharts);
function btObserve(canvas) { if (canvas && canvas.parentElement) btResize.observe(canvas.parentElement); }
```

- [ ] **Step 3: Render the decision card and equity curve**

Add these renderers next to `renderBacktestOutcomes` in `backtester.js`:

```js
const BT_DIRECTION_COPY = {
  long: "Long", short: "Short", flat: "No position"
};

function renderBacktestDecision(data) {
  const host = document.getElementById("backtestDecision");
  if (!host) return;
  const d = data.decision;
  if (!d) {
    host.innerHTML = `
      <div class="backtest-section-head"><div><span>The call</span><h2>No decision recorded</h2></div></div>
      <div class="backtest-integrity">The model did not return a usable trade, so only the stock and SPY are charted below.</div>`;
    return;
  }
  const bits = [
    `<div class="backtest-stat"><span>Direction</span><b>${btEsc(BT_DIRECTION_COPY[d.direction] || d.direction)}</b></div>`,
    `<div class="backtest-stat"><span>Conviction</span><b>${btEsc(d.conviction)}/5</b></div>`,
    `<div class="backtest-stat"><span>Horizon</span><b>${btEsc(d.horizon)}</b></div>`,
    `<div class="backtest-stat"><span>Stop</span><b>${d.stop_pct == null ? "—" : btPct(-d.stop_pct)}</b></div>`,
    `<div class="backtest-stat"><span>Target</span><b>${d.target_pct == null ? "—" : btPct(d.target_pct)}</b></div>`
  ].join("");
  host.innerHTML = `
    <div class="backtest-section-head"><div><span>The call</span><h2>What Squall committed to</h2></div><b>Blind</b></div>
    <section class="backtest-panel">
      <div class="backtest-stats">${bits}</div>
      ${d.thesis ? `<p class="backtest-thesis">${btEsc(d.thesis)}</p>` : ""}
    </section>`;
}

function renderBacktestCurve(simulation) {
  const host = document.getElementById("backtestCurve");
  if (!host || !simulation || !simulation.curve || simulation.curve.length < 2) return;
  const curve = simulation.curve;
  const hasTrade = curve.some(p => Number.isFinite(p.trade));
  const series = [
    { key:"spy", label:"SPY", color:btVar("--ink-dim", "#7d8892"), points:curve.map(p => p.spy), width:1.4 },
    { key:"stock", label:"Stock, buy & hold", color:btVar("--ink", "#b9c2ca"), points:curve.map(p => p.stock), width:1.4, dash:[4,3] }
  ];
  if (hasTrade) series.push({ key:"trade", label:"Squall's trade",
    color:btVar("--accent", "#e0a33a"), points:curve.map(p => p.trade), width:2 });

  const dots = [];
  if (hasTrade && simulation.exit) {
    const exitIndex = curve.findIndex(p => p.d === simulation.exit.date);
    if (exitIndex >= 0) dots.push({ index:exitIndex, series:"trade",
      color:btVar("--down", "#c25b5b"), title:simulation.exit.reason });
  }

  const legend = series.map(s =>
    `<span><i style="background:${s.color}"></i>${btEsc(s.label)}</span>`).join("");
  host.innerHTML = `
    <div class="backtest-chart-wrap"><canvas id="backtestCurveCanvas"></canvas></div>
    <div class="backtest-legend">${legend}</div>`;

  btObserve(document.getElementById("backtestCurveCanvas"));
  btRegisterChart("curve", () => drawLineChart(
    document.getElementById("backtestCurveCanvas"), series, {
      labels: curve.map(p => p.d),
      dots,
      yFormat: v => `$${Math.round(v).toLocaleString()}`
    }));
}
```

Extend `renderBacktestOutcomes` to host the chart. Change its `innerHTML` assignment so the chart container sits above the outcome cards, and call the curve renderer at the end:

```js
  document.getElementById("backtestOutcomes").innerHTML = `
    <div class="backtest-section-head"><div><span>Outcome reveal</span><h2>What happened afterward</h2></div><b>Not shown to the AI</b></div>
    <section class="backtest-panel" id="backtestCurve"></section>
    <div class="backtest-outcome-entry">Next-session entry: <b>${outcome.entry_date ? `${btUsd(outcome.entry_price)} on ${btEsc(outcome.entry_date)}` : "Unavailable"}</b> · split-adjusted</div>
    <div class="backtest-outcomes">${cards}</div>
    <div class="backtest-integrity">Maximum six-month drawdown after entry: <b>${btPct(outcome.max_drawdown_6m)}</b>. These realized returns evaluate the historical analysis; they did not affect it.</div>`;
  renderBacktestCurve(payload.simulation);
```

- [ ] **Step 4: Subscribe to the new event**

In `runBacktest`, add alongside the other listeners:

```js
  source.addEventListener("backtest_decision", event => {
    renderBacktestDecision(JSON.parse(event.data));
  });
```

And clear the new section at the top of `runBacktest`, next to the other three resets:

```js
  document.getElementById("backtestDecision").innerHTML = "";
```

- [ ] **Step 5: Add the styles**

Append to `styles.css`, after the existing `.backtest-*` block. Colors must be tokens:

```css
.backtest-chart-wrap { position: relative; width: 100%; height: 320px; margin-bottom: 10px; }
.backtest-chart-wrap canvas { width: 100%; height: 100%; display: block; }
.backtest-legend { display: flex; flex-wrap: wrap; gap: 16px; color: var(--ink-dim); font-size: 10px; font-family: var(--mono); }
.backtest-legend i { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 5px; }
.backtest-thesis { margin-top: 12px; color: var(--ink); font-family: var(--doc); font-size: 13px; line-height: 1.6; }
@media (max-width: 640px) { .backtest-chart-wrap { height: 240px; } }
```

- [ ] **Step 6: Verify against the real page**

Restart the stub server from Task 4, open `http://127.0.0.1:3271/ilgar`, run a backtest, and confirm: the decision card renders (as "No decision recorded" without an API key), the equity chart draws two lines, the y-axis reads in dollars, and switching themes via the palette button repaints the canvas rather than blanking it.

Then confirm `backtester.js` did not break any page. The automated harness arrives in
Task 6, so for now load `/`, `/screener` and `/ilgar` in turn and confirm each has an
empty console. A page that renders but silently wires up no listeners is the failure
mode here — click the theme button on each page as the cheapest proof that top-level
script execution reached the bottom of `app.js`.

- [ ] **Step 7: Commit**

```bash
git add backtester.js ilgar.html styles.css
git commit -m "Graph the historical trade against the stock and SPY

Three indexed equity curves on a local canvas renderer, with the exit marked
and the decision card above it. The stock buy-and-hold line is what separates
a bad pick from bad trade management, and it is the only way a flat call is
scoreable at all. Repaints on squall:theme since a canvas does not inherit
token colors.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Enforce the SSE and multi-page contracts

**Files:**
- Create: `scripts/check_sse_contract.py`
- Create: `tests/js/pagecheck.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: two contract checks. `scripts/check_sse_contract.py` joins `npm run test:contracts`; `tests/js/pagecheck.js` joins `npm run test:js` and is the harness Tasks 5, 11 and 16 refer to.

**Why both live here:** `/ilgar` is a third page sharing `app.js`, and CLAUDE.md is explicit that the fatal shape — a bare `document.getElementById(x).addEventListener(...)` at top level — is indistinguishable from the safe one by grepping, because it depends on whether `x` is in that page's markup. Nothing in the repo enforces either contract today.

- [ ] **Step 1: Write the checker**

Create `scripts/check_sse_contract.py`:

```python
#!/usr/bin/env python3
"""Fail when a backtest SSE event is sent but never listened for (or vice versa).

CLAUDE.md calls the SSE event names a contract between server.js and the front end,
but nothing enforced it. Renaming one side is silent: the browser simply stops
updating, with no error anywhere.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SENT = re.compile(r'send\(\s*"(backtest_[a-z_]+)"')
HEARD = re.compile(r'addEventListener\(\s*"(backtest_[a-z_]+)"')


def main() -> int:
    server = (ROOT / "server.js").read_text(encoding="utf-8")
    client = (ROOT / "backtester.js").read_text(encoding="utf-8")

    sent = set(SENT.findall(server))
    heard = set(HEARD.findall(client))

    if not sent:
        print("check_sse_contract: found no backtest_* sends in server.js", file=sys.stderr)
        return 1

    unheard = sorted(sent - heard)
    unsent = sorted(heard - sent)

    for name in unheard:
        print(f"server.js sends '{name}' but backtester.js never listens for it", file=sys.stderr)
    for name in unsent:
        print(f"backtester.js listens for '{name}' but server.js never sends it", file=sys.stderr)

    if unheard or unsent:
        return 1
    print(f"ok - {len(sent)} backtest SSE events matched on both sides")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Validate the checker catches a real break**

The checker is worthless if it passes on broken code. Temporarily rename one listener in `backtester.js` — change `addEventListener("backtest_decision"` to `addEventListener("backtest_decisions"` — then run:

Run: `python3 scripts/check_sse_contract.py`
Expected: FAIL, exit 1, reporting both `backtest_decision` unheard and `backtest_decisions` unsent.

Revert the rename and run again.
Expected: PASS — `ok - 9 backtest SSE events matched on both sides`.

- [ ] **Step 3: Create the multi-page execution harness**

Create `tests/js/pagecheck.js`. This executes each page's real script set against a
stubbed DOM whose `getElementById` returns an element **only** for ids scraped from that
page's assembled markup — which is the only way to catch the fatal shape.

```js
"use strict";
// Executes each page's scripts against that page's REAL id set. A bare
// getElementById(x).foo on an id the page lacks throws, and every listener below
// it silently never wires up — the exact failure CLAUDE.md warns about, which
// grepping cannot detect because it depends on the page's markup.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");

function assemble(page) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  return html.replace(/<!--#include\s+([\w-]+)\s*-->/g, (_, name) =>
    fs.readFileSync(path.join(ROOT, "partials", name + ".html"), "utf8"));
}

function idsOf(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
  return ids;
}

function makeEl(id) {
  return {
    id, value: "", textContent: "", innerHTML: "", checked: false, disabled: false,
    max: "", min: "", tagName: "DIV", offsetWidth: 800, offsetHeight: 600, scrollTop: 0,
    scrollHeight: 0, clientWidth: 800, clientHeight: 600, children: [], dataset: {},
    style: new Proxy({}, { get: () => "", set: () => true }),
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    insertBefore(){}, replaceChild(){}, contains: () => false, dispatchEvent: () => true,
    setAttribute(){}, getAttribute: () => null, removeAttribute(){}, focus(){}, blur(){},
    click(){}, closest: () => null, scrollIntoView(){}, insertAdjacentHTML(){}, remove(){},
    getBoundingClientRect: () => ({ top:0, left:0, width:800, height:600, bottom:600, right:800 }),
    querySelector: () => makeEl("q"), querySelectorAll: () => [],
    getContext: () => new Proxy({}, { get: () => () => ({}) }),
    parentNode: null, parentElement: null, firstChild: null
  };
}

function run(page, scripts) {
  const html = assemble(page);
  const ids = idsOf(html);
  const bodyPage = (html.match(/<body[^>]*data-page\s*=\s*["']([^"']+)["']/) || [])[1] || "analyzer";
  const cache = new Map();
  const noopEl = { dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    style: { setProperty(){}, getPropertyValue: () => "" }, appendChild(){}, addEventListener(){} };
  const doc = {
    body: { ...noopEl, dataset: { page: bodyPage } },
    documentElement: { ...noopEl },
    getElementById(id) {
      if (!ids.has(id)) return null;
      if (!cache.has(id)) cache.set(id, makeEl(id));
      return cache.get(id);
    },
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => makeEl("created"), createTextNode: () => ({}),
    addEventListener(){}, removeEventListener(){}, dispatchEvent: () => true,
    startViewTransition: null, readyState: "complete", hidden: false,
    visibilityState: "visible", head: { appendChild(){} }
  };
  const storage = {
    _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
    clear() { this._d = {}; }, key: () => null, get length() { return Object.keys(this._d).length; }
  };
  const sandbox = {
    document: doc, localStorage: storage, sessionStorage: storage,
    location: { href: "http://localhost/" + page, search: "", pathname: "/", hash: "",
      assign(){}, replace(){} },
    history: { replaceState(){}, pushState(){} },
    navigator: { userAgent: "node", maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() } },
    console: { log(){}, warn(){}, error(){}, info(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 1, cancelAnimationFrame(){},
    matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
    getComputedStyle: () => ({ getPropertyValue: () => "#000", fontSize: "13px", display: "block" }),
    EventSource: function () { return { addEventListener(){}, close(){}, onerror: null }; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    CustomEvent: function(){}, Event: function(){}, URL, URLSearchParams,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900, scrollY: 0,
    ResizeObserver: function () { return { observe(){}, disconnect(){}, unobserve(){} }; },
    MutationObserver: function () { return { observe(){}, disconnect(){} }; },
    IntersectionObserver: function () { return { observe(){}, disconnect(){}, unobserve(){} }; },
    alert(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const s of scripts) {
    let code = fs.readFileSync(path.join(ROOT, s), "utf8");
    // Self-validation: prove the harness catches the shape it exists to find.
    if (process.env.PAGECHECK_POISON && s === "app.js")
      code += '\ndocument.getElementById("definitelyNotOnAnyPage").addEventListener("click", () => {});\n';
    try {
      vm.runInContext(code, sandbox, { filename: s });
    } catch (e) {
      return { page, script: s, error: e.message, stack: (e.stack || "").split("\n").slice(0, 3).join("\n") };
    }
  }
  return { page, ok: true, ids: ids.size };
}

const JOBS = [
  ["index.html", ["sp500.js", "market-universes.js", "app.js"]],
  ["screener.html", ["sp500.js", "market-universes.js", "app.js"]],
  ["ilgar.html", ["sp500.js", "market-universes.js", "app.js", "backtester.js"]]
];

let failed = 0;
for (const [page, scripts] of JOBS) {
  const r = run(page, scripts);
  if (r.ok) console.log(`ok - ${page} (${r.ids} ids) executed clean`);
  else {
    failed += 1;
    console.error(`not ok - ${r.page} threw in ${r.script}\n  ${r.error}\n${r.stack}`);
  }
}
console.log(`\n${JOBS.length - failed}/${JOBS.length} pages executed clean`);
if (failed) process.exitCode = 1;
```

- [ ] **Step 4: Validate the page harness before trusting it**

A checker that passes on broken code is worse than none, and the first version of this
one reported a clean pass on code that was definitely broken.

Run: `PAGECHECK_POISON=1 node tests/js/pagecheck.js`
Expected: FAIL — all three pages report `Cannot read properties of null (reading 'addEventListener')`.

Run: `node tests/js/pagecheck.js`
Expected: PASS — `3/3 pages executed clean`.

- [ ] **Step 5: Wire both into the suite**

In `package.json`:

```json
    "test": "node tests/js/run.js && node tests/js/pagecheck.js && python3 -m unittest discover -s tests/python -p 'test_*.py' && python3 scripts/check_concept_vocabulary.py && python3 scripts/audit_sec_pressure.py && python3 scripts/check_sse_contract.py",
    "test:js": "node tests/js/run.js && node tests/js/pagecheck.js",
    "test:contracts": "python3 scripts/check_concept_vocabulary.py && python3 scripts/audit_sec_pressure.py && python3 scripts/check_sse_contract.py"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/check_sse_contract.py tests/js/pagecheck.js package.json
git commit -m "Enforce the SSE event-name and multi-page script contracts

CLAUDE.md calls the SSE event names a contract but nothing checked it, and
renaming one side fails silently -- the browser just stops updating. /ilgar is
also a third page sharing app.js, where a bare getElementById(x) on an id that
page lacks kills every listener below it and grepping cannot tell the fatal
shape from the safe one.

Both checkers are self-validating: poison the input and they must fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 2 — Snapshot enrichment, cheap half

Phase 1 must be complete. Task 7 is a prerequisite for Phase 3.

---

### Task 7: Dual price basis — adjusted for returns, raw for valuation

**Files:**
- Modify: `backtester.py` (`fetch_history` ~line 89; `main` ~line 265)
- Modify: `tests/python/test_backtester.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `adjusted_frame(frame)` → DataFrame with OHLC scaled by `adjclose/close`; `fetch_history` now returns frames carrying both bases. `main` gains `raw_close_at_cutoff` used by Phase 3.

- [ ] **Step 1: Write the failing test**

```python
    def test_adjusted_frame_scales_ohlc_by_the_adjustment_ratio(self):
        index = pd.date_range("2023-01-02", periods=3, freq="B")
        frame = pd.DataFrame({
            "open": [100.0, 102.0, 104.0], "high": [101.0, 103.0, 105.0],
            "low": [99.0, 101.0, 103.0], "close": [100.0, 102.0, 104.0],
            "adjclose": [50.0, 51.0, 52.0], "volume": [1000, 1000, 1000],
        }, index=index)

        adjusted = backtester.adjusted_frame(frame)

        # every bar halves, because adjclose is half of close throughout
        self.assertAlmostEqual(adjusted["close"].iloc[0], 50.0)
        self.assertAlmostEqual(adjusted["open"].iloc[1], 51.0)
        self.assertAlmostEqual(adjusted["high"].iloc[2], 52.5)
        # volume is never scaled
        self.assertEqual(adjusted["volume"].iloc[0], 1000)

    def test_adjusted_frame_falls_back_to_raw_without_adjclose(self):
        index = pd.date_range("2023-01-02", periods=2, freq="B")
        frame = pd.DataFrame({"open": [10.0, 11.0], "high": [10.5, 11.5],
                              "low": [9.5, 10.5], "close": [10.0, 11.0],
                              "volume": [5, 5]}, index=index)
        adjusted = backtester.adjusted_frame(frame)
        self.assertAlmostEqual(adjusted["close"].iloc[1], 11.0)
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: FAIL — `module 'backtester' has no attribute 'adjusted_frame'`.

- [ ] **Step 3: Implement**

Add to `backtester.py` after `dated_frame`:

```python
def adjusted_frame(frame):
    """
    Split- and dividend-adjusted OHLC derived from the adjclose/close ratio.

    We request UNADJUSTED history and adjust here, rather than asking yahooquery for
    adj_ohlc=True, because both bases are needed and they are needed for different
    things. Adjusted drives returns and technicals — adjustment factors cancel in any
    ratio, so returns are unaffected by post-cutoff events. RAW drives valuation,
    because XBRL EPS and share counts are as-reported: a P/E built from a
    post-split-adjusted price against an as-reported EPS is simply a wrong number,
    and a split between the cutoff and today corrupts it silently.
    """
    if not isinstance(frame, pd.DataFrame) or frame.empty:
        return pd.DataFrame()
    out = frame.copy()
    close_col, adj_col = _column(out, "close"), _column(out, "adjclose")
    if close_col is None or adj_col is None:
        return out
    ratio = pd.to_numeric(out[adj_col], errors="coerce") / pd.to_numeric(out[close_col], errors="coerce")
    ratio = ratio.replace([float("inf"), float("-inf")], float("nan")).fillna(1.0)
    for name in ("open", "high", "low", "close"):
        col = _column(out, name)
        if col is not None:
            out[col] = pd.to_numeric(out[col], errors="coerce") * ratio
    return out
```

In `fetch_history`, drop `adj_ohlc=True` from both `.history(...)` calls so yahooquery returns raw OHLC plus `adjclose`. Keep everything else identical.

In `main`, after `before, _ = split_at_date(frames[ticker], as_of)`, add:

```python
    raw_before = before
    adjusted = adjusted_frame(frames[ticker])
    before, _ = split_at_date(adjusted, as_of)
    if before.empty:
        raise ValueError(f"No market session was available for {ticker} on or before {as_of.isoformat()}.")
    # As-reported price at the cutoff, for anything compared against XBRL per-share figures.
    raw_close_col = _column(raw_before, "close")
    raw_close_at_cutoff = finite(raw_before[raw_close_col].iloc[-1]) if raw_close_col is not None and not raw_before.empty else None
```

Update the `price_basis` value in `snapshot` to reflect reality:

```python
        "price_basis": "Split- and dividend-adjusted daily OHLCV; valuation uses the as-reported close",
```

And pass the adjusted frames to `sealed_bars`:

```python
        "bars": sealed_bars(adjusted, adjusted_frame(frames.get("SPY", pd.DataFrame())), as_of),
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backtester.py tests/python/test_backtester.py
git commit -m "Split the historical price basis into adjusted and as-reported

adj_ohlc=True back-adjusts using splits and dividends that happened AFTER the
cutoff, so the absolute levels shown to the model were never the prices that
traded. Returns are unaffected because the factors cancel in a ratio, but
valuation is not: an as-reported EPS against an adjusted price is a wrong
number. Request raw history and derive both bases here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Reuse the analyzer's four signal engines

**Files:**
- Modify: `backtester.py` (`technical_snapshot` area ~line 230; `main` ~line 273)

**Interfaces:**
- Consumes: `adjusted_frame` (Task 7).
- Produces: `scraper_frame(before)` → DataFrame with `Open/High/Low/Close/Volume`; `derived_signals(before, price)` → `{chart_patterns, key_levels, price_action, institutional, market_regime}`.

- [ ] **Step 1: Implement the shim and the wrapper**

Add to `backtester.py` after `technical_snapshot`:

```python
# Matches the col_map in scraperFinal.YQData.history — the analyzer's signal engines
# all expect yfinance-convention capitalised columns.
SCRAPER_COLUMNS = {"open": "Open", "high": "High", "low": "Low",
                   "close": "Close", "volume": "Volume"}


def scraper_frame(frame):
    out = frame.copy()
    renames = {}
    for lower, upper in SCRAPER_COLUMNS.items():
        col = _column(out, lower)
        if col is not None:
            renames[col] = upper
    return out.rename(columns=renames)


def derived_signals(before, price):
    """
    The analyzer's four signal engines applied to pre-cutoff bars only.

    All four are pure functions of a price frame, so they reconstruct honestly at any
    cutoff. Each is wrapped independently: one engine choking on an odd frame must
    degrade its own block, not lose the other three or fail the run.
    """
    hist = scraper_frame(before)
    out = {}

    def attempt(name, fn):
        try:
            return fn()
        except Exception as exc:
            print(f"WARN|backtest_signal|{name}|{type(exc).__name__}", file=sys.stderr, flush=True)
            return None

    patterns = attempt("chart_patterns", lambda: scraper.detect_chart_patterns(hist, price or 0))
    if patterns is not None:
        out["chart_patterns"], out["key_levels"] = patterns

    price_action = attempt("price_action", lambda: scraper.analyze_price_action(hist, price or 0))
    if price_action is not None:
        out["price_action"] = price_action

    institutional = attempt("institutional", lambda: scraper.analyze_institutional(hist))
    if institutional is not None:
        out["institutional"] = institutional

    if price_action is not None and institutional is not None:
        regime = attempt("market_regime",
                         lambda: scraper.classify_market_regime(hist, price_action, institutional))
        if regime is not None:
            out["market_regime"] = regime

    return out
```

- [ ] **Step 2: Fold the blocks into the snapshot**

In `main`, after `technical = technical_snapshot(before)`, add:

```python
    signals = derived_signals(before, (technical.get("metrics") or {}).get("price"))
```

Then spread them into the `snapshot` dict, immediately after `"technical": technical,`:

```python
        **signals,
```

And extend `availability`:

```python
            "chart_patterns": "chart_patterns" in signals,
            "price_action": "price_action" in signals,
            "market_regime": "market_regime" in signals,
```

- [ ] **Step 3: Verify the shim against a real run**

On a Python-equipped machine:

```bash
echo '{"query":"AAPL","as_of":"2023-03-15"}' | python3 backtester.py | python3 -c "import json,sys; d=json.load(sys.stdin); s=d['snapshot']; print('patterns:', s.get('chart_patterns')); print('regime:', (s.get('market_regime') or {}).get('regime')); print('trend:', (s.get('price_action') or {}).get('trend'))"
```

Expected: a non-empty pattern list, a regime string, and a trend string. If any print `None`, the corresponding `WARN|backtest_signal|` line on stderr names the failing engine.

- [ ] **Step 4: Commit**

```bash
git add backtester.py
git commit -m "Reuse the analyzer's signal engines on pre-cutoff bars

detect_chart_patterns, analyze_price_action, analyze_institutional and
classify_market_regime are pure functions of a price frame, so they
reconstruct honestly at any cutoff. A column shim matching YQData.history's
col_map is all they needed. Each is wrapped separately so one bad frame
degrades its own block rather than the run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: SPY-relative context at the cutoff

**Files:**
- Modify: `backtester.py`

**Interfaces:**
- Consumes: `adjusted_frame` (Task 7), `derived_signals` (Task 8).
- Produces: `relative_context(before, spy_before)` → `{beta_1y, correlation_1y, rs_1m, rs_3m, rs_6m, rs_1y, spy_return_1y, spy_drawdown_1y, spy_regime}`.

- [ ] **Step 1: Implement**

Add to `backtester.py` after `derived_signals`:

```python
RS_WINDOWS = {"rs_1m": 21, "rs_3m": 63, "rs_6m": 126, "rs_1y": 252}


def relative_context(before, spy_before):
    """
    Where the stock sat against the tape at the cutoff.

    SPY bars were already downloaded to score outcomes and were otherwise discarded.
    Relative strength here is stock_return - spy_return over the same window, so a
    positive number means the stock outran the index over that stretch.
    """
    if spy_before is None or spy_before.empty or before.empty:
        return {}
    stock_col, spy_col = _column(before, "close"), _column(spy_before, "close")
    if stock_col is None or spy_col is None:
        return {}

    stock = pd.to_numeric(before[stock_col], errors="coerce").dropna()
    spy = pd.to_numeric(spy_before[spy_col], errors="coerce").dropna()
    aligned = pd.DataFrame({"stock": stock, "spy": spy}).dropna()
    if len(aligned) < 65:
        return {}

    out = {}
    returns = aligned.pct_change().dropna()
    if len(returns) > 30:
        variance = finite(returns["spy"].var())
        if variance:
            out["beta_1y"] = finite(returns["stock"].cov(returns["spy"]) / variance)
        out["correlation_1y"] = finite(returns["stock"].corr(returns["spy"]))

    def window_return(series, sessions):
        if len(series) < 2:
            return None
        start = series.iloc[-min(sessions + 1, len(series))]
        end = series.iloc[-1]
        return finite(end / start - 1) if start else None

    for key, sessions in RS_WINDOWS.items():
        stock_ret = window_return(aligned["stock"], sessions)
        spy_ret = window_return(aligned["spy"], sessions)
        out[key] = finite(stock_ret - spy_ret) if stock_ret is not None and spy_ret is not None else None

    out["spy_return_1y"] = window_return(aligned["spy"], 252)
    cumulative = (1 + returns["spy"]).cumprod()
    out["spy_drawdown_1y"] = finite((cumulative / cumulative.cummax() - 1).min())

    spy_signals = derived_signals(spy_before, finite(spy.iloc[-1]))
    regime = (spy_signals.get("market_regime") or {}).get("regime")
    if regime:
        out["spy_regime"] = regime
    return out
```

- [ ] **Step 2: Fold into the snapshot**

In `main`, after the `signals` line:

```python
    spy_before, _ = split_at_date(adjusted_frame(frames.get("SPY", pd.DataFrame())), as_of)
    relative = relative_context(before, spy_before)
```

Add `"relative": relative,` to `snapshot` and `"relative": bool(relative),` to `availability`.

- [ ] **Step 3: Verify**

```bash
echo '{"query":"NVDA","as_of":"2023-01-10"}' | python3 backtester.py | python3 -c "import json,sys; print(json.load(sys.stdin)['snapshot'].get('relative'))"
```

Expected: a dict with a `beta_1y` near 1.5–2.0 for NVDA and finite `rs_*` values.

- [ ] **Step 4: Commit**

```bash
git add backtester.py
git commit -m "Add SPY-relative context to the historical snapshot

SPY bars were downloaded to score outcomes and then thrown away. Beta,
correlation, relative strength over four windows, and SPY's own regime and
drawdown at the cutoff cost nothing extra upstream and tell the model whether
it is reading a stock or reading the whole tape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `price_history`, prompt projection, and the sealing test that actually tests something

**Files:**
- Modify: `backtester.py` (`build_ai_prompt` ~line 245; `main`)
- Modify: `tests/python/test_backtester.py`

**Interfaces:**
- Consumes: everything from Tasks 7–9.
- Produces: `snapshot["price_history"]`; `build_ai_prompt` becomes a projection that excludes the bar array.

- [ ] **Step 1: Write the failing tests**

Replace the existing `test_ai_prompt_contains_snapshot_but_no_realized_outcomes` — it asserts `assertNotIn("forward_returns", prompt)`, a string that appears nowhere in the repository, so it would pass on a prompt leaking every outcome:

```python
    def test_ai_prompt_excludes_realized_outcomes_and_raw_bars(self):
        snapshot = {
            "ticker": "AAA", "as_of": "2023-03-15",
            "technical": {"metrics": {"price": 10}},
            "price_history": [{"d": "2023-03-14", "o": 9.5, "h": 10.1, "l": 9.4, "c": 10.0, "v": 100}],
            "market_regime": {"regime": "TRENDING"},
        }
        outcomes = {
            "entry_price": 123.456789, "returns": {"1m": 0.077712345},
            "benchmark_returns": {"1m": 0.011198765}, "max_drawdown_6m": -0.198765,
            "bars": {"dates": ["2023-03-16"], "close": [124.5]},
        }
        prompt = backtester.build_ai_prompt(snapshot)

        # Every realized number must be absent, not merely a key name we happen to avoid.
        for value in ("123.456789", "0.077712345", "0.011198765", "-0.198765", "124.5"):
            self.assertNotIn(value, prompt, f"{value} leaked into the AI prompt")
        # The raw bar array is for the chart, not the prompt.
        self.assertNotIn('"price_history"', prompt)
        self.assertNotIn("9.4", prompt)
        # The derived reads must survive the projection.
        self.assertIn("TRENDING", prompt)
        self.assertIn("AAA", prompt)
        # Sanity: the fixture is realistic enough that a naive dump WOULD have leaked.
        self.assertIn("123.456789", json.dumps({**snapshot, **outcomes}))

    def test_price_history_stops_at_the_cutoff(self):
        index = pd.date_range("2024-01-01", periods=30, freq="B")
        close = np.arange(50.0, 80.0)
        frame = pd.DataFrame({"open": close, "high": close + 1, "low": close - 1,
                              "close": close, "volume": 1000}, index=index)
        cutoff = index[20].date()
        before, _ = backtester.split_at_date(frame, cutoff)

        bars = backtester.price_history_rows(before, limit=252)

        self.assertEqual(bars[-1]["d"], cutoff.isoformat())
        self.assertTrue(all(row["d"] <= cutoff.isoformat() for row in bars))
        self.assertEqual(len(bars), 21)
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: FAIL — `module 'backtester' has no attribute 'price_history_rows'`, and the prompt test fails because `build_ai_prompt` still dumps `price_history` wholesale.

- [ ] **Step 3: Implement**

Add `price_history_rows` to `backtester.py`:

```python
def price_history_rows(before, limit=252):
    """Pre-cutoff daily bars for the chart. Rounded — six decimals of a close is noise."""
    if before is None or before.empty:
        return []
    frame = before.iloc[-limit:]
    cols = {name: _column(frame, name) for name in ("open", "high", "low", "close", "volume")}
    if cols["close"] is None:
        return []
    rows = []
    for stamp, row in frame.iterrows():
        close = finite(row[cols["close"]])
        if close is None:
            continue
        def at(name, default=None):
            col = cols[name]
            value = finite(row[col]) if col is not None else None
            return round(value, 4) if value is not None else default
        rows.append({"d": stamp.date().isoformat(), "o": at("open", round(close, 4)),
                     "h": at("high", round(close, 4)), "l": at("low", round(close, 4)),
                     "c": round(close, 4), "v": at("volume", 0)})
    return rows
```

Replace `build_ai_prompt` with a projection:

```python
# Blocks the model reasons from. price_history is deliberately absent: 252 bars of raw
# OHLCV would bury the analysis in numbers the derived blocks already summarise, and the
# bars exist for the chart. Anything not named here never reaches the model.
PROMPT_BLOCKS = (
    "ticker", "company_name", "as_of", "effective_market_date", "price_basis",
    "technical", "chart_patterns", "key_levels", "price_action", "institutional",
    "market_regime", "relative", "valuation", "fundamentals",
    "sec_facts", "filings_known_by_cutoff", "availability", "data_sources",
)


def build_ai_prompt(snapshot):
    projection = {key: snapshot[key] for key in PROMPT_BLOCKS if key in snapshot}
    return "\n".join([
        f"You are performing a historical stock analysis as if today were {snapshot['as_of']}.",
        "Use only the frozen snapshot below. Do not use or imply knowledge of any later price, filing, news, product event, macro event, or outcome.",
        "The snapshot intentionally contains no forward returns. Historical news, options flow, analyst estimates, and historical index membership are unavailable; say so instead of filling gaps from memory.",
        "Write a concise but substantive report with: setup at the cutoff, technical condition, fundamentals known by then, bull case, bear case, decision/watch conditions, and a confidence/data-limitations note.",
        "Treat chart-pattern scores as candidate detectors rather than facts. This is research, not individualized financial advice.",
        "\n--- FROZEN POINT-IN-TIME SNAPSHOT ---",
        json.dumps(projection, separators=(",", ":"), allow_nan=False),
    ])
```

In `main`, add to `snapshot`:

```python
        "price_history": price_history_rows(before),
```

- [ ] **Step 4: Run to verify they pass**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add backtester.py tests/python/test_backtester.py
git commit -m "Ship pre-cutoff bars and make the AI prompt an explicit projection

build_ai_prompt dumped the whole snapshot, which stops being reasonable once
252 bars live in it. It now names the blocks the model reasons from, so the
bar array reaches the chart without burying the analysis.

Replaces the sealing test, which asserted the absence of a string that appears
nowhere in the repo and would have passed on a prompt leaking every outcome.
It now asserts no realized VALUE appears, and proves the fixture would have
leaked under a naive dump.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The "what it looked like then" chart

**Files:**
- Modify: `backtester.js`, `styles.css`

**Interfaces:**
- Consumes: `drawLineChart` (Task 5), `snapshot.price_history` and `snapshot.key_levels` (Tasks 8, 10).

- [ ] **Step 1: Render it**

Add to `backtester.js`:

```js
function btMovingAvg(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = btNum(values[i]);
    if (v === null) continue;
    sum += v; count += 1;
    if (count > n) { sum -= btNum(values[i - n]) || 0; count = n; }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

function renderBacktestSetupChart(snapshot) {
  const host = document.getElementById("backtestSetup");
  const bars = snapshot.price_history;
  if (!host || !Array.isArray(bars) || bars.length < 30) return;
  const closes = bars.map(b => btNum(b.c));
  const series = [
    { key:"close", label:"Close", color:btVar("--ink-bright", "#d7dee5"), points:closes, width:1.6 },
    { key:"ma50", label:"MA50", color:btVar("--ink-dim", "#8b959e"), points:btMovingAvg(closes, 50), width:1.2 },
    { key:"ma200", label:"MA200", color:btVar("--ink-dim", "#8b959e"), points:btMovingAvg(closes, 200), width:1.2, dash:[4,3] }
  ];
  const legend = series.map(s =>
    `<span><i style="background:${s.color}"></i>${btEsc(s.label)}</span>`).join("");
  host.innerHTML = `
    <h3>What it looked like then</h3>
    <div class="backtest-chart-wrap"><canvas id="backtestSetupCanvas"></canvas></div>
    <div class="backtest-legend">${legend}</div>`;
  btObserve(document.getElementById("backtestSetupCanvas"));
  btRegisterChart("setup", () => drawLineChart(
    document.getElementById("backtestSetupCanvas"), series, {
      labels: bars.map(b => b.d),
      yFormat: v => `$${v.toFixed(v < 20 ? 2 : 0)}`
    }));
}
```

- [ ] **Step 2: Host it in the snapshot section**

In `renderBacktestSnapshot`, add a container as the first panel after the integrity line:

```js
    <section class="backtest-panel" id="backtestSetup"></section>
```

and call the renderer at the end of the function:

```js
  renderBacktestSetupChart(snapshot);
```

- [ ] **Step 3: Verify**

Run a backtest against the stub server and confirm a price line with two moving averages appears the moment the snapshot lands — before the AI finishes. The stub has no `price_history`, so extend the stub's snapshot with 60 synthetic bars to exercise it, or verify against a real run on Railway.

- [ ] **Step 4: Commit**

```bash
git add backtester.js styles.css
git commit -m "Draw the pre-cutoff setup chart on the historical analyzer

The page showed nothing but text while the model wrote. The setup chart lands
with the snapshot and reads straight into the equity curve below it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Two correctness fixes taken in passing

**Files:**
- Modify: `backtester.py` (`company_identity` ~line 220, `fact_series` ~line 154)
- Modify: `tests/python/test_backtester.py`

- [ ] **Step 1: Write the failing tests**

```python
    def test_fact_series_records_the_unit_it_actually_used(self):
        payload = {"facts": {"us-gaap": {"Revenues": {"label": "Revenues", "units": {"CAD": [
            {"val": 500, "end": "2022-12-31", "filed": "2023-02-01", "form": "10-K"},
        ]}}}}}
        fact = backtester.fact_series(payload, ["Revenues"], "USD", date(2023, 3, 15))
        # The requested unit was USD but only CAD exists; the row must not claim USD.
        self.assertEqual(fact["series"][0]["unit"], "CAD")

    def test_company_identity_does_not_stamp_a_post_cutoff_rename(self):
        # entityName is today's name. A snapshot dated before a rename must not carry it.
        name = backtester.company_identity("AAA", {"entityName": "Renamed Holdings"},
                                           filings=[{"form": "10-K", "filed": "2019-02-01",
                                                     "entity_name": "Original Corp"}])
        self.assertEqual(name, "Original Corp")
        # With no dated evidence, fall back to the ticker rather than the current name.
        self.assertEqual(backtester.company_identity("AAA", {"entityName": "Renamed"}, filings=[]), "AAA")
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: FAIL — the unit assertion returns `"USD"`, and `company_identity` takes no `filings` argument.

- [ ] **Step 3: Fix `fact_series`**

In `fact_series`, capture the unit actually used:

```python
        units = (fact or {}).get("units") or {}
        used_unit = unit if unit in units else (next(iter(units)) if units else None)
        rows = units.get(used_unit) or []
```

and change the row construction to record `used_unit`:

```python
                "value": finite(row["val"]), "unit": used_unit, "period_end": row["end"],
```

- [ ] **Step 4: Fix `company_identity`**

```python
def company_identity(ticker, companyfacts, filings=None):
    """
    The company's name AS OF the cutoff.

    companyfacts["entityName"] is today's name, so a company renamed after the cutoff
    (Facebook to Meta) would stamp a post-cutoff fact onto a frozen snapshot. Prefer a
    name carried on a filing known by the cutoff; fall back to the ticker rather than
    to a name we know is anachronistic.
    """
    for filing in filings or []:
        name = filing.get("entity_name")
        if name:
            return name
    for row in scraper._load_sec_tickers():
        if str(row.get("ticker", "")).upper().replace(".", "-") == ticker:
            return row.get("title") or ticker
    return ticker
```

Update the call site in `main` to pass filings, and reorder so `filings` is resolved first:

```python
    filings = point_in_time_filings(cik, as_of) if cik else []
    snapshot = {
        "ticker": ticker, "company_name": company_identity(ticker, companyfacts, filings),
```

Note the SEC ticker directory is also today's data, so this is an improvement rather than a guarantee — record that honestly in `data_sources`:

```python
        "data_sources": {"market_history": "Yahoo Finance via yahooquery",
                         "filings": "SEC EDGAR" if cik else "Unavailable",
                         "company_name": "Best available at the cutoff; SEC name records are not fully historical"},
```

- [ ] **Step 5: Run to verify they pass**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add backtester.py tests/python/test_backtester.py
git commit -m "Stop leaking a post-cutoff company name and a mislabelled unit

company_identity stamped today's SEC entityName onto a historical snapshot, so
a company renamed after the cutoff carried its new name into the AI prompt.
fact_series fell back to an arbitrary unit while still recording the REQUESTED
one, so a non-USD filer rendered with a dollar sign.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 3 — Valuation and fundamentals

Task 7 must be complete: the valuation math is only correct against the as-reported close.

---

### Task 13: TTM aggregation from XBRL

**Files:**
- Modify: `backtester.py` (`FACTS` ~line 25)
- Modify: `tests/python/test_backtester.py`

**Interfaces:**
- Consumes: `fact_series` (Task 12).
- Produces: `ttm_value(fact)` → `{value, basis, period_end} | None` where `basis` ∈ `{"quarters", "derived", "annual"}`.

- [ ] **Step 1: Write the failing tests**

```python
    def _fact(self, rows):
        return {"concept": "Revenues", "label": "Revenues", "series": rows}

    def test_ttm_sums_four_discrete_quarters(self):
        rows = [
            {"value": 40, "period_start": "2022-10-01", "period_end": "2022-12-31", "filed": "2023-02-01", "form": "10-Q"},
            {"value": 30, "period_start": "2022-07-01", "period_end": "2022-09-30", "filed": "2022-11-01", "form": "10-Q"},
            {"value": 20, "period_start": "2022-04-01", "period_end": "2022-06-30", "filed": "2022-08-01", "form": "10-Q"},
            {"value": 10, "period_start": "2022-01-01", "period_end": "2022-03-31", "filed": "2022-05-01", "form": "10-Q"},
        ]
        result = backtester.ttm_value(self._fact(rows))
        self.assertEqual(result["value"], 100)
        self.assertEqual(result["basis"], "quarters")
        self.assertEqual(result["period_end"], "2022-12-31")

    def test_ttm_derives_a_missing_quarter_from_year_to_date_rows(self):
        # Q4 is absent; FY and 9-month YTD are present, so Q4 = FY - 9M.
        rows = [
            {"value": 100, "period_start": "2022-01-01", "period_end": "2022-12-31", "filed": "2023-02-01", "form": "10-K"},
            {"value": 60, "period_start": "2022-01-01", "period_end": "2022-09-30", "filed": "2022-11-01", "form": "10-Q"},
        ]
        result = backtester.ttm_value(self._fact(rows))
        self.assertEqual(result["value"], 100)
        self.assertEqual(result["basis"], "annual")

    def test_ttm_refuses_when_nothing_usable_exists(self):
        self.assertIsNone(backtester.ttm_value(None))
        self.assertIsNone(backtester.ttm_value(self._fact([])))
        self.assertIsNone(backtester.ttm_value(self._fact([
            {"value": 5, "period_start": None, "period_end": "2022-12-31", "filed": "2023-02-01", "form": "10-Q"},
        ])))
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: FAIL — `module 'backtester' has no attribute 'ttm_value'`.

- [ ] **Step 3: Implement**

Add to `backtester.py`:

```python
def _span_days(row):
    start, end = row.get("period_start"), row.get("period_end")
    if not start or not end:
        return None
    try:
        return (datetime.strptime(end, "%Y-%m-%d").date() - datetime.strptime(start, "%Y-%m-%d").date()).days
    except ValueError:
        return None


def ttm_value(fact):
    """
    Trailing twelve months from a fact series, or None.

    XBRL rows are not comparable as they arrive: 10-K rows carry full-year spans,
    10-Q rows carry quarter spans, and plenty of filers report year-to-date rather
    than discrete quarters. Summing them blind double-counts. Prefer four discrete
    quarters; fall back to the latest annual figure; otherwise refuse, because a
    silently-wrong multiple is worse than a missing one.
    """
    rows = (fact or {}).get("series") or []
    if not rows:
        return None

    quarters, annuals = [], []
    for row in rows:
        span = _span_days(row)
        value = finite(row.get("value"))
        if value is None or span is None:
            continue
        if 80 <= span <= 100:
            quarters.append((row["period_end"], value))
        elif 350 <= span <= 380:
            annuals.append((row["period_end"], value))

    quarters.sort(reverse=True)
    if len(quarters) >= 4:
        return {"value": sum(v for _, v in quarters[:4]),
                "basis": "quarters", "period_end": quarters[0][0]}

    annuals.sort(reverse=True)
    if annuals:
        return {"value": annuals[0][1], "basis": "annual", "period_end": annuals[0][0]}
    return None


def point_in_time_value(fact):
    """Latest instantaneous value (balance-sheet items carry no period span)."""
    rows = (fact or {}).get("series") or []
    for row in rows:
        value = finite(row.get("value"))
        if value is not None:
            return {"value": value, "period_end": row.get("period_end")}
    return None
```

Extend `FACTS` with the concepts the ratios need:

```python
    "gross_profit": (["GrossProfit"], "USD"),
    "cost_of_revenue": (["CostOfRevenue", "CostOfGoodsAndServicesSold"], "USD"),
    "current_assets": (["AssetsCurrent"], "USD"),
    "current_liabilities": (["LiabilitiesCurrent"], "USD"),
    "long_term_debt": (["LongTermDebtNoncurrent", "LongTermDebt"], "USD"),
    "short_term_debt": (["DebtCurrent", "ShortTermBorrowings"], "USD"),
    "depreciation": (["DepreciationDepletionAndAmortization", "DepreciationAndAmortization"], "USD"),
    "capex": (["PaymentsToAcquirePropertyPlantAndEquipment"], "USD"),
```

Also raise the `limit` in `fact_series` from 5 to 8, so four quarters plus a YTD row survive the trim:

```python
def fact_series(companyfacts, concepts, unit, as_of, limit=8):
```

- [ ] **Step 4: Run to verify they pass**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add backtester.py tests/python/test_backtester.py
git commit -m "Aggregate trailing-twelve-month figures from point-in-time XBRL

10-K rows carry full-year spans, 10-Q rows carry quarter spans, and many
filers report year-to-date, so summing the series blind double-counts. Prefer
four discrete quarters, fall back to the latest annual figure, and refuse
otherwise -- a silently wrong multiple is worse than a missing one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Derived valuation and fundamentals

**Files:**
- Modify: `backtester.py`
- Modify: `tests/python/test_backtester.py`

**Interfaces:**
- Consumes: `ttm_value`, `point_in_time_value` (Task 13), `raw_close_at_cutoff` (Task 7).
- Produces: `valuation_block(facts, raw_price)` → `{valuation, fundamentals}`.

- [ ] **Step 1: Write the failing test**

```python
    def test_valuation_prices_off_the_as_reported_close(self):
        def flow(value, end, start):
            return {"concept": "X", "series": [
                {"value": value, "period_start": start, "period_end": end,
                 "filed": end, "form": "10-K"}]}
        def instant(value, end):
            return {"concept": "X", "series": [
                {"value": value, "period_end": end, "filed": end, "form": "10-K"}]}

        facts = {
            "revenue": flow(1000.0, "2022-12-31", "2022-01-01"),
            "net_income": flow(100.0, "2022-12-31", "2022-01-01"),
            "diluted_eps": flow(2.0, "2022-12-31", "2022-01-01"),
            "equity": instant(500.0, "2022-12-31"),
            "shares_outstanding": instant(50.0, "2022-12-31"),
        }
        block = backtester.valuation_block(facts, raw_price=40.0)

        self.assertAlmostEqual(block["valuation"]["pe"], 20.0)          # 40 / 2
        self.assertAlmostEqual(block["valuation"]["ps"], 2.0)           # 40*50 / 1000
        self.assertAlmostEqual(block["valuation"]["pb"], 4.0)           # 40*50 / 500
        self.assertAlmostEqual(block["fundamentals"]["net_margin"], 0.1)
        self.assertEqual(block["valuation"]["price_basis"], "as-reported close at the cutoff")

    def test_valuation_is_omitted_without_a_price(self):
        self.assertEqual(backtester.valuation_block({"revenue": None}, raw_price=None), {})
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: FAIL — `module 'backtester' has no attribute 'valuation_block'`.

- [ ] **Step 3: Implement**

```python
def valuation_block(facts, raw_price):
    """
    Multiples and margins as they stood at the cutoff.

    Priced off the AS-REPORTED close, never the adjusted one: XBRL EPS and share
    counts are as-reported, and a post-split-adjusted price against an as-reported
    EPS is a wrong number that looks entirely plausible.
    """
    price = finite(raw_price)
    if not price or price <= 0:
        return {}

    ttm = {name: ttm_value(facts.get(name)) for name in
           ("revenue", "net_income", "operating_income", "operating_cash_flow",
            "diluted_eps", "gross_profit", "depreciation", "capex")}
    instant = {name: point_in_time_value(facts.get(name)) for name in
               ("equity", "assets", "liabilities", "cash", "shares_outstanding",
                "current_assets", "current_liabilities", "long_term_debt", "short_term_debt")}

    def flow(name):
        return (ttm.get(name) or {}).get("value")

    def level(name):
        return (instant.get(name) or {}).get("value")

    shares = level("shares_outstanding")
    market_cap = price * shares if shares else None
    revenue, net_income, eps = flow("revenue"), flow("net_income"), flow("diluted_eps")
    equity, cash = level("equity"), level("cash")
    debt = sum(v for v in (level("long_term_debt"), level("short_term_debt")) if v) or None
    ebitda = None
    if flow("operating_income") is not None and flow("depreciation") is not None:
        ebitda = flow("operating_income") + flow("depreciation")
    enterprise = market_cap + (debt or 0) - (cash or 0) if market_cap else None
    fcf = None
    if flow("operating_cash_flow") is not None and flow("capex") is not None:
        fcf = flow("operating_cash_flow") - flow("capex")

    def ratio(numerator, denominator):
        return finite(numerator / denominator) if numerator is not None and denominator else None

    valuation = {
        "pe": ratio(price, eps),
        "ps": ratio(market_cap, revenue),
        "pb": ratio(market_cap, equity),
        "ev_ebitda": ratio(enterprise, ebitda),
        "fcf_yield": ratio(fcf, market_cap),
        "market_cap": finite(market_cap),
        "enterprise_value": finite(enterprise),
        "price_basis": "as-reported close at the cutoff",
        "ttm_basis": (ttm.get("revenue") or {}).get("basis"),
    }
    fundamentals = {
        "gross_margin": ratio(flow("gross_profit"), revenue),
        "operating_margin": ratio(flow("operating_income"), revenue),
        "net_margin": ratio(net_income, revenue),
        "roe": ratio(net_income, equity),
        "current_ratio": ratio(level("current_assets"), level("current_liabilities")),
        "debt_to_equity": ratio(debt, equity),
        "ttm_period_end": (ttm.get("revenue") or {}).get("period_end"),
    }
    valuation = {k: v for k, v in valuation.items() if v is not None}
    fundamentals = {k: v for k, v in fundamentals.items() if v is not None}
    if not valuation and not fundamentals:
        return {}
    return {"valuation": valuation, "fundamentals": fundamentals}
```

In `main`, after `facts = ...`:

```python
    derived = valuation_block(facts, raw_close_at_cutoff)
```

Spread `**derived,` into `snapshot` and add to `availability`:

```python
            "valuation": "valuation" in derived,
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m unittest tests.python.test_backtester -v`
Expected: PASS — 16 tests.

- [ ] **Step 5: Sanity-check against a real ticker**

```bash
echo '{"query":"AAPL","as_of":"2023-03-15"}' | python3 backtester.py | python3 -c "import json,sys; d=json.load(sys.stdin)['snapshot']; print(d.get('valuation')); print(d.get('fundamentals'))"
```

Expected: a P/E in the 20–30 range and a net margin near 0.25. A P/E an order of magnitude off means the price basis is wrong — check that `raw_close_at_cutoff` is coming from the unadjusted frame.

- [ ] **Step 6: Commit**

```bash
git add backtester.py tests/python/test_backtester.py
git commit -m "Derive point-in-time valuation and fundamentals from XBRL

The model was handed raw filing rows and asked to do arithmetic in its head,
with no valuation view at all. It now gets P/E, P/S, P/B, EV/EBITDA, FCF
yield, margins, ROE, current ratio and debt-to-equity, priced off the
as-reported close so the per-share figures line up.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Surface valuation in the snapshot UI

**Files:**
- Modify: `backtester.js`

- [ ] **Step 1: Render the block**

Add to `renderBacktestSnapshot`, after the existing metric cards:

```js
  const VAL_LABELS = { pe:"P/E", ps:"P/S", pb:"P/B", ev_ebitda:"EV/EBITDA", fcf_yield:"FCF yield" };
  const FUND_LABELS = { gross_margin:"Gross margin", operating_margin:"Operating margin",
    net_margin:"Net margin", roe:"ROE", current_ratio:"Current ratio", debt_to_equity:"Debt/equity" };
  const ratioCards = [
    ...Object.entries(VAL_LABELS).map(([k, label]) => {
      const v = btNum((snapshot.valuation || {})[k]);
      if (v === null) return "";
      return `<div class="backtest-stat"><span>${btEsc(label)}</span><b>${k === "fcf_yield" ? btPct(v) : v.toFixed(1) + "×"}</b></div>`;
    }),
    ...Object.entries(FUND_LABELS).map(([k, label]) => {
      const v = btNum((snapshot.fundamentals || {})[k]);
      if (v === null) return "";
      const pctish = k.endsWith("_margin") || k === "roe";
      return `<div class="backtest-stat"><span>${btEsc(label)}</span><b>${pctish ? btPct(v) : v.toFixed(2)}</b></div>`;
    })
  ].join("");
```

Insert a panel into the returned template, between the technical and SEC-facts panels:

```js
    ${ratioCards ? `<section class="backtest-panel"><h3>Valuation and fundamentals known by the cutoff</h3><div class="backtest-stats">${ratioCards}</div><p class="backtest-caveat">Priced off the as-reported close${snapshot.valuation?.ttm_basis ? ` · TTM basis: ${btEsc(snapshot.valuation.ttm_basis)}` : ""}.</p></section>` : ""}
```

- [ ] **Step 2: Verify**

Confirm against a real run that the panel renders with plausible values and is absent (rather than showing dashes) when `availability.valuation` is false.

- [ ] **Step 3: Commit**

```bash
git add backtester.js
git commit -m "Show point-in-time valuation and fundamentals on the analyzer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Full verification and push

**Files:** none modified.

- [ ] **Step 1: Run the whole suite on a Python-equipped machine**

Run: `npm test`
Expected: all JS tests pass, all Python tests pass, and all three contract checks pass.

- [ ] **Step 2: Re-run the three-page execution check**

`backtester.js` roughly doubled in size and `app.js` is shared across all three pages.

Run: `node tests/js/pagecheck.js` — expected `ok - self-check: …` followed by
`3/3 pages executed clean`.

The self-check is no longer an opt-in env var (`PAGECHECK_POISON` was removed after the
Task 6 review): it runs on every invocation and the clean results are declared
meaningless if it fails. Evidence that a clean pass means anything is therefore part of
every run rather than a ritual someone has to remember. **If the `ok - self-check` line
is missing from the output, the run proves nothing** — that is the line to look for.

- [ ] **Step 3: Verify on Railway**

Local `node server.js` has no Python, so a real end-to-end run only exists on the deployment. Push, wait for the auto-deploy, then run a backtest at `https://squall.up.railway.app/ilgar` on a ticker with a known outcome — `NVDA` at `2023-01-10` is a good case, since the stock roughly tripled over the following six months and any sign error in the simulation will be glaring.

Confirm: the decision card populates, the equity curve draws three lines, the exit dot lands where the stop or horizon says it should, and `backtest_outcomes` still arrives only after the AI stream ends.

- [ ] **Step 4: Check provider standing**

Run: `curl "https://squall.up.railway.app/stats?key=$SQUALL_STATS_KEY"`
Expected: `providers.*.rate_limited` counts unchanged from before the deploy. This feature adds no new upstream request per run — the SPY bars were already being fetched — so any increase means something is retrying that should not be.

- [ ] **Step 5: Push**

```bash
git push
```

---

## Notes for the implementer

- **`ilgar.html` loads the shared `app.js`.** A bare `document.getElementById(x).addEventListener(...)` at top level in `app.js` kills every listener below it on any page lacking `x`. Use `on(id, ev, fn)`. This is the single most likely way to break this feature invisibly.
- **`backtester.js` is only loaded by `/ilgar`,** so bare `getElementById` there is safe — but only for ids that exist in `ilgar.html`.
- **Do not add a refund path** for the AI budget. There is deliberately none; spending happens after the point of no return.
- **`CACHE_VERSION` in `screener.py` is unrelated** to this work and must not be touched.
- The model still carries post-cutoff knowledge in its weights. The pipeline is sealed; the model is not. Do not strengthen the page's claims beyond what the pipeline delivers.
