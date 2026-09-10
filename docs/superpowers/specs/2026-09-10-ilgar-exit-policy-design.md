# /ilgar — a stop sized for the holding period, and winners that are allowed to run

**Date:** 2026-09-10
**Status:** Approved, ready for implementation planning
**Touches:** `server.js`, `backtester.js`, `backtester.py`, `tests/js/`

## Problem

`/ilgar` trades exit far sooner than the horizon the model asked for. Measured on 18
cutoffs, both directions, a risk-3 balanced profile and a 3-month horizon — 36 forced
trades run through the shipping `ensureBacktestPosition` and `simulateTrade` against real
post-cutoff bars — the median hold was **23 sessions against an intended 63**, and only 2
of 36 reached the horizon at all.

The cause is a unit mismatch. `stop_pct` is `2.5 × atr_pct` (`server.js:1251`) and
`atr_pct` is a **daily** average true range as a fraction of price
(`screener.py:321` — `tr.tail(14).mean() / last`). `target_pct` is `stop_pct ×
reward_ratio`, so the target is roughly **five daily ATRs**. A 63-session hold disperses
about **√63 ≈ 8 ATRs** on noise alone. Both levels therefore sit inside ordinary drift for
the term they are supposed to govern, and neither is scaled to that term: a 1-month and a
6-month trade get identically sized levels.

The visible damage is on the target side, not the stop side. Long trades:

| | exit | trade | same-direction hold to 63d |
|---|---|---|---|
| NVDA 2023-01-17 | target, day 13 | +6.6% | **+56.6%** |
| AMD 2025-04-07 | target, day 25 | +9.5% | **+60.7%** |
| TSLA 2023-04-20 | target, day 28 | +7.4% | **+57.8%** |
| CRM 2024-08-15 | target, day 59 | +6.1% | +30.6% |

The stop, by contrast, is doing real work and must be preserved: of 21 stop-outs, holding
to the horizon would have been better in only 38%, and the stop is what turned INTC
2024-07-15 into −3.0% instead of −31.4%, and UNH 2025-04-15 into −8.1% instead of −50.8%.

### The fix that was rejected, and why it is recorded here

The original request was to review conditions before honoring an exit rather than selling
mechanically. That was built and measured: requiring a stop to be confirmed by two
consecutive closes beyond the level moved average return **0.3% → 0.4%** and made the
worst case **worse** (−8.1% → −9.6%). It is a no-op that costs tail risk. Re-deciding at
the stop is not where the duration is lost — the target is.

This is written down because the idea is intuitive and will be proposed again.

## What we are building

Two changes to the exit mechanics, shipped as one policy, plus an env knob that reverts it.

Nothing about the sealing guarantee, the next-open entry rule, the close-based /
next-open-fill convention, or MySquall's role as a **ceiling** changes.

## Section A — the stop is scaled to the holding period

New helper in `server.js` beside `ensureBacktestPosition`:

```js
const BT_TERM_REFERENCE = 21;  // the term a 2.5x daily-ATR band was actually sized for

function stopNoiseFloor(atrPct, sessions, cap) {
  if (atrPct == null) return null;
  return Math.min(Math.max(2.5 * atrPct * Math.sqrt(sessions / BT_TERM_REFERENCE), 0.03), 0.18, cap);
}
```

`ensureBacktestPosition` currently clamps `min(requested, risk_stop_cap)`. It becomes
`min(max(requested, floor), risk_stop_cap)` — **a floor as well as a ceiling**.

Three properties are load-bearing:

1. **The floor is itself capped**, so `risk_stop_cap` still wins outright and MySquall's
   meaning is unchanged. A profile that says "I will lose at most 7% on a trade" still
   loses at most 7%.
2. **It applies to the model's own `stop_pct`, not just the engine's fallback.** The
   prompt instructs the model to size the stop off `atr_pct`, so the model faithfully
   reproduces the same daily/quarterly mismatch. A floor that only caught the fallback
   would fix almost nothing, because the model supplies a stop on nearly every run.
3. **`fallbackBacktestDecision` needs no change.** Its stop flows through the same clamp in
   `ensureBacktestPosition`, so the floor covers the rules path automatically. Adding a
   second copy of the scaling there would be a drift risk for no benefit.

### Ordering constraint

`sessions` requires the **resolved** horizon, and the horizon is currently resolved at
`server.js:1269`, *after* the stop is computed at `:1250-1257`. The horizon block must move
above the stop block. This is the one non-obvious edit in Section A and the easiest way to
ship a floor computed against the wrong term.

## Section B — the target becomes a trail, not an exit

In `simulateTrade`, the target stops firing as an exit. It becomes a one-way arming
threshold: once the best close since entry reaches the target level, the stop trails that
extreme by `stop_pct`. New exit reason `"trail"`.

- The trail anchor is the best **close**, consistent with close-based evaluation
  everywhere else in the function.
- Arming is one-way; a pullback does not disarm it.
- Before arming, behavior is byte-identical to today except that the target does not exit.
- Horizon still terminates the trade. Exits still fill at the **next** session's open, with
  the final bar's close standing in when there is no next open.
- Long and short share one path with the sign flipped, as they do today.

### Purity

`simulateTrade` is documented as pure — no I/O, no clock, no globals — precisely so it
drops into `tests/js` unmodified. The mode therefore rides on the decision object as
`decision.exit_mode`, written by `ensureBacktestPosition`; `simulateTrade` never reads env.

**An absent `exit_mode` means `"fixed"`**, exactly mirroring the existing precedent that an
absent `position_pct` means fully invested: route decisions always arrive through
`ensureBacktestPosition`, so legacy and unit-test decisions keep their old behavior and the
policy has exactly one owner.

### Env knob

`SQUALL_BT_EXIT_MODE` ∈ `{runner, fixed}`, default `runner`, typo falls back to the
default — the validation convention every other knob in the file already follows. `fixed`
reverts the whole policy from the Railway dashboard with no deploy, the same escape-hatch
shape as `SQUALL_AI_FREQ_PENALTY=0` and `SQUALL_REASON_MAX_TOKENS=0`.

## Measured effect

Risk-3 balanced profile, model supplying a stop the way today's prompt asks, 36 forced
trades, returns before position sizing:

```
current    held=19  ret= 0.1%  win=13/36  worst=-23.2%  avg stop=6.0%
proposed   held=37  ret= 3.9%  win=15/36  worst=-23.2%  avg stop=9.1%
```

Across risk levels:

| risk | current | proposed | worst (cur → prop) |
|---|---|---|---|
| 1 | −2.0%, 16d | −0.5%, 23d | −23.2% → −23.2% |
| 2 | −1.0%, 18d | +2.5%, 32d | −23.2% → −23.2% |
| 3 | +0.1%, 19d | +3.9%, 37d | −23.2% → −23.2% |
| 4 | +0.7%, 23d | +4.1%, 44d | −23.2% → −36.1% |
| 5 | +0.9%, 24d | +4.7%, 46d | −23.2% → −36.1% |

**This is a trend-following trade-off, not a free win, and the spec should not be read as
claiming otherwise.** The win rate barely moves (13 → 15 of 36). The entire gain is that
winners run — CRM −5.4% → +30.8%, AMD +39.1% → +66.0%, TSLA +21.2% → +47.6% — and it is
paid for with larger individual losers: MSFT −6.8% → −10.9%, GOOGL −5.5% → −9.8%, PFE
−3.9% → −7.2%, INTC −8.7% → −10.2%.

The worst case is **unchanged at risk 1–3**. It widens at risk 4–5 because the cap there is
14–18% and the scaled floor can reach further; that is the risk setting doing what it says
rather than a regression.

UNH 2025-04-15's −23.2% is identical under both policies. It is **gap risk, not stop
width** — the stop is evaluated on the close and fills at the next open, so a gap opens
straight past it. Nothing in this design addresses that, and nothing in it should be
credited with addressing it.

### Sample caveat

18 large caps over a mostly-rising window, with direction forced both ways rather than
taken from the model. This measures exit *mechanics*, not strategy edge, and trailing stops
flatter in trending samples. Treat the direction of the effect as solid and the magnitude
as optimistic.

## Section C — front end (`backtester.js`)

- **`EXIT_LOOK` (line 862) needs a `trail` entry.** Unknown reasons fall back to
  `EXIT_LOOK.end`, so without this a trailing exit renders as "ran out of data" — a
  successful exit reported as a truncated one, and nothing errors.
- **The prose rule at line 765** states "if a daily close rises N% from entry, exit at the
  following session's open". That exit no longer exists; it becomes the level at which the
  stop starts trailing.
- **The "Target" stat at line 786** is likewise no longer a target. Relabel to name what
  the number now is.
- The equity chart's exit marker already reads `simulation.exit.reason` and needs no
  structural change once `EXIT_LOOK` knows the new reason.

## Section D — prompt (`backtester.py`)

Two lines in the analysis instruction block are now inaccurate:

- `:1150` asks for a "target distance". Reword as the level at which the trade begins
  trailing.
- `:1154` says "closer than about 2x atr_pct is ordinary daily noise" — guidance the engine
  now overrides with a term-scaled floor. Drop the specific figure.

Constraints, both from CLAUDE.md and both non-negotiable:

- The instruction block must stay **under 2,600 characters** (there is a test).
- Anything decidable from the numbers belongs in the engine as a decided value, not in the
  prompt as a computation. The prompt must **not** learn to multiply by √t.
- After the edit, read `describeAiStream`'s `reasoning=` figure before assuming it was
  free. A prompt edit on a reasoning route has previously tripled-to-octupled reasoning
  length on the same model, effort and cap.

## Failure modes

| Condition | Result |
|---|---|
| `atr_pct` absent from the snapshot | `stopNoiseFloor` returns null; stop clamps exactly as it does today |
| Model returns a stop wider than the cap | Cap binds, unchanged from today |
| Model returns a stop tighter than the floor | Widened to the floor, then capped |
| Floor computes above the cap | Cap wins; floor is capped by construction |
| Target never reached | Trail never arms; fixed stop and horizon behave as today |
| Trail arms on the final bar | Exit fills at that bar's close, per the existing final-bar rule |
| `exit_mode` absent | `"fixed"` — legacy behavior |
| `SQUALL_BT_EXIT_MODE` typo | Falls back to `runner` |

## Testing

**`tests/js/` — `simulateTrade`**

- Trail arms when the best close reaches the target, and not before.
- Trail exit fires at the next open after the anchor is breached; reason is `"trail"`.
- A pullback below the target after arming does **not** disarm.
- An unarmed stop-out is byte-identical to today's result.
- Horizon still terminates an armed, never-breached trail.
- Short-side mirror of each of the above.
- `exit_mode` absent → fixed-target behavior preserved (guards the legacy contract).

**`tests/js/` — `ensureBacktestPosition` / `stopNoiseFloor`**

- The floor never exceeds `risk_stop_cap`, at every risk level 1–5.
- A model stop tighter than the floor is widened; one wider is left alone; one wider than
  the cap is capped.
- The floor scales with horizon: 1m < 3m < 6m for the same `atr_pct`.
- `atr_pct` null leaves the existing clamp untouched.
- The horizon is resolved before the stop — assert a 1m and a 6m decision on identical
  inputs receive different stops. This is the ordering constraint from Section A, and it is
  the one defect that would otherwise pass every other test.

**Regression**

- `npm test` in full; the existing target-exit cases in `tests/js/backtester.test.js` will
  need to become trail-arming cases.
- `tests/js/pagecheck.js`, since `backtester.js` changes.
- The instruction-block length test after the Section D edit.

## Out of scope

- Gap risk. UNH's −23.2% on a 7.1% stop is unaddressed and stays unaddressed; only intraday
  or options data could speak to it, and neither is available point-in-time.
- Re-deciding direction mid-trade, or any second AI call inside the holding window. Cost,
  latency and the sealing guarantee all argue against it.
- Entry filtering. Entry remains the next session's open, unconditionally.
- Position sizing, which conviction already scales.
- Any change to `/` or `/screener`.
