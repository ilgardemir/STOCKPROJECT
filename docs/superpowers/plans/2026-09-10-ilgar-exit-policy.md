# /ilgar Exit Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/ilgar` exiting trades at a level sized for a single day when the holding period is a quarter, and stop a fixed target capping winners at a fraction of the move.

**Architecture:** Two changes in `server.js`. A `stopNoiseFloor` helper scales the noise band by √term and becomes a *floor* under the stop, with `risk_stop_cap` still the ceiling. In `simulateTrade`, the target stops being an exit and becomes a one-way arming threshold for a trailing stop. The mode rides on `decision.exit_mode` so `simulateTrade` stays pure.

**Tech Stack:** Vanilla Node (zero deps), vanilla browser JS, Python 3 engines. Tests run through the zero-dependency `npm test` harness.

## Global Constraints

- **Vanilla everything.** No new dependencies in Node, browser or Python.
- **`simulateTrade` must stay pure** — no I/O, no clock, no globals, no `process.env`. It is exported into `tests/js` and the purity is the reason it can be.
- **MySquall is a ceiling.** `risk_stop_cap` must still bind; the new floor is itself capped by it.
- **The analysis instruction block in `backtester.py` must stay under 2,600 characters.** There is a test.
- **Anything decidable from numbers belongs in the engine, not the prompt.** The prompt must not learn to multiply by √t.
- **stdout is sacred in the Python engines.** Diagnostics to stderr only.
- Commit after each task; push at the end.

---

### Task 1: `stopNoiseFloor` and the horizon reorder

**Files:**
- Modify: `server.js:1240-1271` (`ensureBacktestPosition`), new helper above it
- Modify: `server.js:1116-1118` (BT constants block) — add `BT_TERM_REFERENCE`, `BT_EXIT_MODE`
- Modify: `server.js:3091-3107` (exports) — add `stopNoiseFloor`
- Test: `tests/js/server.test.js`

**Interfaces:**
- Produces: `stopNoiseFloor(atrPct, sessions, cap) -> number|null`
- Produces: `decision.exit_mode` — `"runner"` | `"fixed"`, read by `simulateTrade` in Task 2
- Consumes: existing `backtestProfilePlan(raw).risk_stop_cap`, `BT_HORIZON_SESSIONS`

- [ ] **Step 1: Write the failing tests**

```js
test("stopNoiseFloor scales with the term and never exceeds the cap", () => {
  // 2% daily ATR, 1-month term: the reference term, so the band is unscaled 2.5x ATR.
  assert.ok(Math.abs(S.stopNoiseFloor(0.02, 21, 0.5) - 0.05) < 1e-9);
  // 3 months is sqrt(3) wider, 6 months is sqrt(6).
  assert.ok(Math.abs(S.stopNoiseFloor(0.02, 63, 0.5) - 0.05 * Math.sqrt(3)) < 1e-9);
  assert.ok(S.stopNoiseFloor(0.02, 126, 0.5) > S.stopNoiseFloor(0.02, 63, 0.5));
  // The cap wins outright: MySquall's stated maximum loss is not scalable.
  assert.strictEqual(S.stopNoiseFloor(0.06, 126, 0.07), 0.07);
  // No ATR, no floor — the existing clamp is left exactly as it was.
  assert.strictEqual(S.stopNoiseFloor(null, 63, 0.1), null);
});

test("a stop tighter than the term-scaled floor is widened, one wider is left alone", () => {
  const snap = { technical:{ metrics:{ atr_pct:0.02 }, scores:{} } };
  const profile = { risk:3, horizon:3, experience:3, depth:3, style:"balanced", priorities:[], custom:"" };
  const tight = S.ensureBacktestPosition(
    { direction:"long", conviction:3, horizon:"3m", stop_pct:0.03, target_pct:0.06 }, snap, profile);
  assert.ok(tight.stop_pct > 0.03, "a 3% stop on a 3m hold is inside daily noise and must widen");
  assert.ok(Math.abs(tight.stop_pct - 0.0866) < 0.001);
  const wide = S.ensureBacktestPosition(
    { direction:"long", conviction:3, horizon:"3m", stop_pct:0.095, target_pct:0.19 }, snap, profile);
  assert.strictEqual(wide.stop_pct, 0.095, "a stop already outside the noise band is the model's call");
  // risk 3 caps at 10%, and the cap still binds over both the request and the floor.
  const capped = S.ensureBacktestPosition(
    { direction:"long", conviction:3, horizon:"6m", stop_pct:0.40, target_pct:0.8 }, snap, profile);
  assert.strictEqual(capped.stop_pct, 0.10);
});

test("the horizon is resolved BEFORE the stop, so term scaling sees the real term", () => {
  // The defect this guards: the horizon used to be resolved after the stop, so every
  // trade would silently size its floor against the default 3m term.
  const snap = { technical:{ metrics:{ atr_pct:0.02 }, scores:{} } };
  const profile = { risk:5, horizon:5, experience:3, depth:3, style:"balanced", priorities:[], custom:"" };
  const short = S.ensureBacktestPosition({ direction:"long", conviction:3, horizon:"1m" }, snap, profile);
  const long = S.ensureBacktestPosition({ direction:"long", conviction:3, horizon:"6m" }, snap, profile);
  assert.strictEqual(short.horizon, "1m");
  assert.strictEqual(long.horizon, "6m");
  assert.ok(long.stop_pct > short.stop_pct, "a 6m hold must get a wider noise floor than a 1m hold");
});

test("exit_mode defaults to runner and is carried on the decision", () => {
  const snap = { technical:{ metrics:{ atr_pct:0.02 }, scores:{} } };
  const d = S.ensureBacktestPosition({ direction:"long", conviction:3, horizon:"3m" }, snap, null);
  assert.strictEqual(d.exit_mode, "runner");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/js/run.js 2>&1 | tail -20`
Expected: FAIL — `S.stopNoiseFloor is not a function`.

- [ ] **Step 3: Add the constants**

At `server.js:1118`, after `BT_PROFILE_POSITION_PCT`:

```js
// The term the 2.5x daily-ATR band was implicitly sized for. atr_pct is a DAILY range
// (screener.py: tr.tail(14).mean() / last), so 2.5x it is about two sessions of noise —
// fine for a 1-month trade and far inside ordinary drift for a 6-month one, which is why
// the median /ilgar hold was 23 sessions against an intended 63.
const BT_TERM_REFERENCE = 21;
// Reverts the whole exit policy from the dashboard with no deploy, the same escape-hatch
// shape as SQUALL_AI_FREQ_PENALTY=0. Validated against a fixed set; a typo takes the default.
const BT_EXIT_MODE = ["runner", "fixed"].includes(process.env.SQUALL_BT_EXIT_MODE)
  ? process.env.SQUALL_BT_EXIT_MODE : "runner";
```

- [ ] **Step 4: Add the helper above `ensureBacktestPosition` (`server.js:1234`)**

```js
/**
 * The width below which a stop is measuring noise rather than a broken thesis.
 *
 * Price disperses with the square root of time, so a fixed multiple of a single day's
 * ATR is the wrong distance for every term but one. Scaling to the term is what stops a
 * 63-session trade being closed by drift it was always going to see.
 *
 * Capped by the profile's own risk cap, so this can only ever raise a stop toward what
 * MySquall already permits and never past it.
 */
function stopNoiseFloor(atrPct, sessions, cap) {
  const atr = btFinite(atrPct);
  if (atr == null) return null;
  const scaled = 2.5 * atr * Math.sqrt(sessions / BT_TERM_REFERENCE);
  return Math.min(Math.max(scaled, 0.03), 0.18, cap);
}
```

- [ ] **Step 5: Move the horizon block above the stop block and apply the floor**

In `ensureBacktestPosition`, delete lines `1249-1257` (the `metrics`/`atrPct`/stop/target block) and delete the horizon block at `1259-1271`, then insert — horizon first — immediately after the `decision_source` assignment:

```js
  /*
   * Horizon: the profile sets a CEILING, not a fixed term.
   *
   * This used to overwrite the model's horizon unconditionally, so all 18 runs of the
   * audit executed at 3m including the four that asked for 1m — and WMT 2025-01-15 was
   * scored a miss on a -0.1% three-month return after asking for the one month over
   * which the stock rose 13.7%. A shorter hold cannot breach a risk preference expressed
   * as "how long am I willing to be exposed", so the model keeps its own choice whenever
   * it is at or inside the profile's, and only a longer request is clamped down.
   *
   * Resolved BEFORE the stop because the stop's noise floor scales with the term. Sizing
   * the floor first would measure every trade against the default 3m and silently undo
   * the whole point of scaling it.
   */
  const requested = BT_HORIZONS.has(decision.horizon) ? decision.horizon : plan.horizon;
  const horizon = BT_HORIZON_SESSIONS[requested] <= BT_HORIZON_SESSIONS[plan.horizon]
    ? requested : plan.horizon;

  const metrics = snapshot?.technical?.metrics || {};
  const atrPct = btFinite(metrics.atr_pct);
  const volatilityStop = atrPct != null ? Math.max(0.03, Math.min(0.18, atrPct * 2.5)) : 0.08;
  const requestedStop = decision.stop_pct == null ? volatilityStop : decision.stop_pct;
  /*
   * The floor applies to the MODEL's stop, not only to the engine's fallback.
   *
   * The prompt tells the model to size the stop off atr_pct, so it faithfully reproduces
   * the same daily-vs-quarterly mismatch the engine had; a floor that only caught the
   * fallback would fix almost nothing, because the model supplies a stop on nearly every
   * run. fallbackBacktestDecision needs no matching change for the same reason in
   * reverse — its stop flows through this clamp too.
   */
  const floor = stopNoiseFloor(atrPct, BT_HORIZON_SESSIONS[horizon], plan.risk_stop_cap);
  const flooredStop = floor == null ? requestedStop : Math.max(requestedStop, floor);
  decision.stop_pct = Math.round(Math.min(flooredStop, plan.risk_stop_cap) * 10000) / 10000;
  const profileTarget = decision.stop_pct * plan.reward_ratio;
  const requestedTarget = decision.target_pct == null ? profileTarget : decision.target_pct;
  decision.target_pct = Math.round(Math.min(0.50, Math.max(0.03,
    requestedTarget, profileTarget)) * 10000) / 10000;
```

- [ ] **Step 6: Add `exit_mode` to the returned object**

In the `return { ...decision, ... }` at the end of `ensureBacktestPosition`, after `entry_rule: "next_open",`:

```js
    exit_mode: BT_EXIT_MODE,
```

- [ ] **Step 7: Export the helper**

In `module.exports`, on the `simulateTrade, sanitizeBacktestDecision, backtestProfilePlan,` line, append `stopNoiseFloor,`.

- [ ] **Step 8: Run the tests**

Run: `node tests/js/run.js 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server.js tests/js/server.test.js
git commit -m "Scale the /ilgar stop to its holding period, not to one day"
```

---

### Task 2: The runner exit in `simulateTrade`

**Files:**
- Modify: `server.js:1348-1407` (`simulateTrade` exit loop and its doc comment)
- Test: `tests/js/server.test.js`

**Interfaces:**
- Consumes: `decision.exit_mode` from Task 1
- Produces: `simulation.exit.reason` gains the value `"trail"`, consumed by Task 3

- [ ] **Step 1: Write the failing tests**

```js
const runner = (over) => ({ direction:"long", stop_pct:0.10, target_pct:0.20,
  horizon:"3m", exit_mode:"runner", ...over });
const bars = (closes) => ({
  dates: closes.map((_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`),
  open: closes.map(c => c), close: closes.slice(), spyOpen:[], spyClose:[] });

test("the target arms a trail instead of exiting", () => {
  // Runs to +25% (arming at +20%), then gives back more than the 10% stop from the peak.
  const sim = S.simulateTrade(runner(), bars([100, 110, 125, 130, 116, 115, 115]));
  assert.strictEqual(sim.exit.reason, "trail");
  // Peak close 130, trail sits at 117; the 116 close breaches it and fills at the next open.
  assert.strictEqual(sim.exit.date, "2024-01-06");
});

test("an unarmed trade still exits on the fixed stop, exactly as before", () => {
  const sim = S.simulateTrade(runner(), bars([100, 96, 89, 88, 88]));
  assert.strictEqual(sim.exit.reason, "stop");
  assert.strictEqual(sim.exit.date, "2024-01-04");
});

test("a pullback after arming does not disarm the trail", () => {
  // Arms at 125, falls to 118 (above the 112.5 trail), recovers, then trails off the new peak.
  const sim = S.simulateTrade(runner(), bars([100, 125, 118, 140, 150, 134, 134]));
  assert.strictEqual(sim.exit.reason, "trail");
  assert.strictEqual(sim.exit.date, "2024-01-07");
});

test("an armed trail that never breaches still ends at the horizon", () => {
  const closes = [100]; for (let i = 1; i < 25; i++) closes.push(100 + i * 2);
  const sim = S.simulateTrade(runner({ horizon:"1m" }), bars(closes));
  assert.strictEqual(sim.exit.reason, "horizon");
});

test("the short side mirrors the trail", () => {
  const sim = S.simulateTrade(runner({ direction:"short" }), bars([100, 90, 75, 70, 84, 85, 85]));
  assert.strictEqual(sim.exit.reason, "trail");
  assert.strictEqual(sim.exit.date, "2024-01-06");
});

test("exit_mode absent keeps the legacy fixed-target exit", () => {
  const legacy = { direction:"long", stop_pct:0.10, target_pct:0.20, horizon:"3m" };
  const sim = S.simulateTrade(legacy, bars([100, 110, 125, 130, 116, 115, 115]));
  assert.strictEqual(sim.exit.reason, "target");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/js/run.js 2>&1 | tail -20`
Expected: FAIL — the first test reports `target`, not `trail`.

- [ ] **Step 3: Replace the exit loop (`server.js:1381-1407`)**

```js
  /*
   * The target arms a trailing stop; it is not itself an exit.
   *
   * As a hard exit it was sized off a single day's ATR (target = stop x reward_ratio,
   * stop = 2.5x a DAILY atr_pct), so it sat about five daily ATRs from entry while a
   * 63-session hold disperses roughly eight on noise alone. It was therefore hit by drift
   * before any thesis resolved: NVDA 2023-01-17 took +6.6% on day 13 of a +56.6% quarter,
   * AMD 2025-04-07 +9.5% of +60.7%, TSLA 2023-04-20 +7.4% of +57.8%.
   *
   * Arming is one-way and the anchor is the best CLOSE, consistent with every other
   * threshold here being evaluated on the close. The initial stop is untouched, which is
   * why the worst case does not move at risk 1-3: the protective role of the stop is what
   * turned INTC 2024-07-15 into -3.0% instead of -31.4%.
   */
  const runnerMode = decision && decision.exit_mode === "runner";
  let exitIdx = null, exitPrice = null, exitReason = null;
  if (trading) {
    let best = entry, armed = false;
    for (let i = 0; i < n; i++) {
      const c = btFinite(close[i]);
      if (c == null) continue;
      best = long ? Math.max(best, c) : Math.min(best, c);
      if (runnerMode && targetPrice != null && !armed)
        armed = long ? best >= targetPrice : best <= targetPrice;
      // Unarmed, the anchor is the entry and this is the original fixed stop.
      const anchor = armed ? best : entry;
      const level = stopPct == null ? null
        : long ? anchor * (1 - stopPct) : anchor * (1 + stopPct);
      const hitStop = level != null && (long ? c <= level : c >= level);
      const hitTarget = !runnerMode && targetPrice != null
        && (long ? c >= targetPrice : c <= targetPrice);
      const hitHorizon = i + 1 >= horizonN;
      if (!hitStop && !hitTarget && !hitHorizon) continue;
      // Fill at the next session's open. On the final bar there is no next open,
      // so the close stands in rather than inventing a price.
      const next = i + 1;
      exitIdx = next < n ? next : i;
      exitPrice = next < n ? btFinite(open[next]) : c;
      if (exitPrice == null) exitPrice = c;
      // Stop wins a same-close tie. Close-based evaluation makes a genuine tie
      // near-impossible (a long's stop sits below entry and its target above),
      // but resolving it toward the loss is the conservative direction.
      exitReason = hitStop ? (armed ? "trail" : "stop") : hitTarget ? "target" : "horizon";
      break;
    }
    if (exitIdx === null) {
      exitIdx = n - 1;
      exitPrice = btFinite(close[n - 1]);
      exitReason = "end";
    }
  }
```

Note `stopPrice` (declared at `server.js:1376`) becomes unused — delete that line. `targetPrice` is still needed.

- [ ] **Step 4: Update the function doc comment (`server.js:1337-1347`)**

Add after the existing "Deliberately conservative" paragraph:

```
 * The target arms a trailing stop rather than closing the trade — see the exit loop.
 * `decision.exit_mode` selects this; an ABSENT mode means the legacy fixed target, the
 * same precedent as an absent position_pct meaning fully invested. The mode is a field
 * rather than an env read because this function is pure and that is what lets it drop
 * straight into tests/js.
```

- [ ] **Step 5: Run the tests**

Run: `node tests/js/run.js 2>&1 | tail -20`
Expected: PASS. Any pre-existing test asserting a `target` exit through `ensureBacktestPosition` now legitimately sees `trail` — update those assertions, do not weaken them.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/js/server.test.js
git commit -m "Let /ilgar winners run: the target now arms a trail, not an exit"
```

---

### Task 3: Front end names the new exit

**Files:**
- Modify: `backtester.js:862-866` (`EXIT_LOOK`), `:765` (execution-plan prose), `:786` (Target stat)

**Interfaces:**
- Consumes: `simulation.exit.reason === "trail"` from Task 2, `d.exit_mode` from Task 1

- [ ] **Step 1: Add the `trail` entry to `EXIT_LOOK`**

An unknown reason falls back to `EXIT_LOOK.end`, so without this a successful trailing exit renders as "window ended" — a completed trade reported as a truncated one, and nothing errors.

```js
    trail:   { token:"--up",      fallback:"#4c9a72", label:"trailing stop" },
```

Place it directly after the `target` row. It takes `--up` because arming requires the target to have been reached, so a trailing exit is always a trade that ran into profit first.

- [ ] **Step 2: Rewrite the execution-plan prose (`backtester.js:765`)**

Replace the single target line with a mode-aware one:

```js
    d.target_pct == null ? ""
      : d.exit_mode === "runner"
        ? `If a daily close ${targetMove} ${btMagnitudePct(d.target_pct)} from entry, start trailing the stop ${btMagnitudePct(d.stop_pct)} behind the best close instead of exiting.`
        : `If a daily close ${targetMove} ${btMagnitudePct(d.target_pct)} from entry, exit at the following session's open.`,
```

- [ ] **Step 3: Relabel the stat (`backtester.js:786`)**

```js
    `<div class="backtest-stat"><span>${d.exit_mode === "runner" ? "Trail arms at" : "Target"}</span><b>${d.target_pct == null ? "—" : btPct(d.target_pct)}</b></div>`
```

- [ ] **Step 4: Verify both pages still execute**

Run: `node tests/js/pagecheck.js 2>&1 | tail -20`
Expected: PASS for `index.html`, `screener.html`, `ilgar.html`, `404.html`.

- [ ] **Step 5: Commit**

```bash
git add backtester.js
git commit -m "Name the trailing exit in the /ilgar decision card and chart"
```

---

### Task 4: The prompt stops describing an exit that no longer happens

**Files:**
- Modify: `backtester.py:1150`, `backtester.py:1154`

- [ ] **Step 1: Reword the two lines**

`:1150` — replace `a positive target distance` with `a positive target distance (the level at which the stop starts trailing)`.

`:1154` — replace the sentence `"Size the stop off atr_pct, not a round number — closer than about 2x atr_pct is ordinary daily noise."` with `"Size the stop off atr_pct, not a round number; the engine widens a stop that is inside the noise band for your holding period."`

The prompt must not be taught to compute √t. The engine already decided this, which is the rule that keeps reasoning length down.

- [ ] **Step 2: Confirm the instruction block is still under 2,600 characters**

Run: `python -m unittest discover tests/python -v 2>&1 | tail -20`
Expected: PASS, including the instruction-block length test.

- [ ] **Step 3: Run the full suite**

Run: `npm test 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 4: Commit and push**

```bash
git add backtester.py
git commit -m "Stop the /ilgar prompt describing a target exit that no longer fires"
git push
```

---

### Task 5: Re-measure against real bars

**Files:**
- None modified. Verification only, using the harness in the session scratchpad.

- [ ] **Step 1: Re-run the 18-case measurement through the shipped code**

The scratchpad harness drives the real `ensureBacktestPosition` and `simulateTrade` over real
post-cutoff bars. After Tasks 1-2 it should reproduce the spec's figures without the
harness re-implementing any policy.

Expected at risk 3, model-supplied stop: hold ~19 → ~37 sessions, worst case unchanged
at −23.2%.

- [ ] **Step 2: Report the measured numbers, not the predicted ones**

If they differ from the spec, say so and investigate before claiming the task is done.

---

## Self-Review

**Spec coverage:** Section A → Task 1 (including the ordering constraint, which has its own
test). Section B → Task 2 (purity preserved via `exit_mode`; env knob in Task 1). Section C
→ Task 3 (all three touch points). Section D → Task 4. Measured-effect claims → Task 5.
Failure-mode table → covered by Task 1 tests (null `atr_pct`, cap binding, floor above cap)
and Task 2 tests (target never reached, `exit_mode` absent).

**Type consistency:** `stopNoiseFloor(atrPct, sessions, cap)` is defined in Task 1 and used
only there. `decision.exit_mode` is written in Task 1 Step 6, read in Task 2 Step 3 and
Task 3 Steps 2-3, spelled identically throughout. `"trail"` is produced in Task 2 Step 3
and consumed in Task 3 Step 1.

**Known gap:** gap risk (UNH 2025-04-15) is explicitly out of scope in the spec and has no
task, by design.
