# /ilgar — graphed trade vs SPY, and a richer point-in-time snapshot

**Date:** 2026-08-21
**Status:** Approved, ready for implementation planning
**Touches:** `backtester.py`, `server.js`, `backtester.js`, `styles.css`, `tests/`

## Problem

`/ilgar` freezes a company at a past date, has the model analyze it blind, then reveals
what happened next. Two gaps:

1. **There is no trade.** The model writes prose; nothing machine-readable comes out of
   it. `outcomes` measures buy-and-hold from the next open regardless of what the model
   concluded, so a bullish call and a bearish call on the same ticker score identically.
   Nothing can be graphed because nothing has been decided.
2. **The snapshot is thin.** The model gets scalar technicals plus raw XBRL rows and a
   filing list. It has no valuation view, no pattern read, no market context, and no
   price series — it is asked to do arithmetic in its head off unformatted filing data.

The outcome is also reported only as percentages in three cards. There is no chart.

## What we are building

A decision the model commits to, a simulation of that decision against the sealed future,
and a chart of the resulting equity curve against both the stock and SPY — plus a
substantially richer frozen snapshot for the model to reason from.

## Decisions taken

| Question | Decision |
|---|---|
| Where does the trade come from? | A second structured call after the prose, sanitized server-side |
| Fill and exit rules | Close-based and conservative; exits fill at the next open |
| What does the chart plot? | Three lines: the trade, the stock buy-and-hold, SPY |
| Where does the simulation run? | Node, in JS, on bars sealed by Python |
| Snapshot enrichment | Price series, reused signal engines, SPY-relative context, computed valuation |

### Why three lines and not two

Two lines (trade vs SPY) cannot distinguish a bad stock pick from bad trade management.
The worked example: the model goes long with an 8% stop, the stock runs +28%, rolls over,
trips the stop, then recovers to +4% while SPY drifts +7%. Against SPY alone the verdict
is "the call lost." With the buy-and-hold line visible the verdict is "the pick was fine,
the stop was the problem" — a different lesson from identical data.

The third line is also the only way a `flat` / "avoid it" call is scoreable at all, since
that case draws no trade line.

### Why the simulation runs in Node

The decision arrives from the AI, which runs in Node after Python has already exited.
Simulating in Python would need a second subprocess and a second `MAX_PY` slot per run,
and `MAX_PY` is the request-rate knob, not a throughput knob. Python already holds the
bars and already ships an `outcomes` object the server withholds; adding the bars there
makes the simulation a pure function in Node with no I/O, which drops straight into the
existing zero-dependency `tests/js` harness.

## Architecture

```
backtester.py → { snapshot, outcomes (+ sealed bars), ai_prompt }
  1  backtest_snapshot      strips outcomes + ai_prompt        (unchanged)
  2  backtest_ai_delta…     prose streams, blind               (unchanged)
  3  second call: snapshot prompt + its own prose → JSON decision
  4  backtest_decision      sanitized decision
  5  simulateTrade(decision, sealedBars) → three equity curves
  6  backtest_outcomes      curves + trade result + existing cards
  7  backtest_done
```

The sealing guarantee is preserved. Neither model call sees a post-cutoff bar: the second
call receives the frozen snapshot prompt plus prose that was itself generated blind, which
contains no future data by construction.

## Section A — Python data layer (`backtester.py`)

### A1. Dual price basis

Stop passing `adj_ohlc=True`. Request history at yahooquery's default, which returns raw
`close` alongside `adjclose`. Build the adjusted series as `OHLC × (adjclose / close)` and
retain the raw close separately.

- **Adjusted** drives returns, technicals, and equity curves. Adjustment factors cancel in
  any ratio, so returns are unaffected by post-cutoff events.
- **Raw** drives valuation, because XBRL EPS and share counts are as-reported. A P/E built
  from a post-split-adjusted price against an as-reported EPS is a wrong number, and a
  split between the cutoff and today corrupts it silently.
- If `adjclose` is absent, both bases fall back to raw and `price_basis` says so.

This also removes the existing lookahead where absolute price levels shown to the model
were back-adjusted using post-cutoff dividends and splits.

### A2. Column shim and engine reuse

`YQData.history` in `scraperFinal.py` already standardises columns to
`Open/High/Low/Close/Volume` via a `col_map`. Reuse that map so the pre-cutoff frame drops
unchanged into four pure functions that already exist:

- `detect_chart_patterns(hist, price)` → patterns + `key_levels`
- `analyze_price_action(hist, price)` → trend, swing structure, fib
- `analyze_institutional(hist)` → OBV trend, accumulation/distribution
- `classify_market_regime(hist, price_action, institutional)` → regime

Each call is wrapped independently so one bad frame degrades that block rather than
failing the run.

### A3. TTM aggregation

Raw XBRL rows are not comparable: 10-K rows carry full-year spans, 10-Q rows carry quarter
spans, and many filers report year-to-date rather than discrete quarters.

The builder, in order:

1. Prefer discrete quarters — period spans of 80–100 days.
2. Where a quarter is missing but a YTD row exists, derive it by subtracting the previous
   YTD row.
3. Sum the latest four quarters ending on or before the cutoff.
4. If four clean quarters cannot be assembled, fall back to the latest annual figure and
   stamp `ttm_basis: "annual"`.
5. If that is also impossible, omit the block and set `availability.valuation: false`.

No silently-wrong multiples. Every derived figure carries its basis.

### A4. New snapshot blocks

| Block | Contents |
|---|---|
| `price_history` | ~252 pre-cutoff daily bars, rounded |
| `chart_patterns`, `key_levels` | from `detect_chart_patterns` |
| `price_action` | from `analyze_price_action` |
| `institutional` | from `analyze_institutional` |
| `market_regime` | from `classify_market_regime` |
| `relative` | beta and correlation vs SPY over the pre-cutoff year; relative strength over 1m/3m/6m/1y, defined as `stock_return − spy_return` for that window; SPY's own regime and drawdown at the cutoff |
| `valuation` | P/E, P/S, P/B, EV/EBITDA, FCF yield — priced off the **raw** cutoff close |
| `fundamentals` | gross/operating/net margin, ROE, YoY revenue and EPS growth, current ratio, debt/equity |

`sec_facts` and `filings_known_by_cutoff` are unchanged. Expanding `FACTS` with the
additional us-gaap concepts these require (gross profit, cost of revenue, current
assets/liabilities, debt, D&A) is part of this work.

Still explicitly unavailable and marked as such: historical news, analyst estimates,
options flow, short interest, index membership.

### A5. `ai_prompt` becomes a projection

`build_ai_prompt` currently serializes the whole snapshot. With 252 bars in it that would
bury the analysis in numbers. It becomes an explicit projection: every derived block goes
in, the raw bar array does not. The bars exist for the chart, not the prompt.

### A6. Sealed side

`outcomes` gains `bars`: post-cutoff adjusted opens and closes for the stock and SPY out to
+6 months (or today, whichever is sooner), as compact parallel arrays. Opens are required
because exits fill at the next open.

### A7. Two fixes taken in passing

- `company_identity` stamps the **present-day** SEC entity name onto a historical
  snapshot. A company renamed after the cutoff (Facebook → Meta) leaks a post-cutoff fact
  into `ai_prompt`. Resolve the name as of the cutoff where possible, otherwise omit it.
- `fact_series` falls back to an arbitrary unit when the requested one is absent but still
  records the **requested** unit on the row. The UI switches on that field, so a non-USD
  filer renders with a `$`. Record the actual unit.

## Section B — Server (`server.js`)

### B1. `sanitizeBacktestDecision(raw)`

Same discipline as `sanitizeScreenerSpec`: nothing the model returns is trusted.

```
direction    ∈ {long, short, flat}     unknown → no decision
conviction   int, clamped 1–5
horizon      ∈ {1m, 3m, 6m}            default 3m
stop_pct     finite, 0.01–0.50, else null
target_pct   finite, 0.01–2.00, else null
thesis       control chars stripped, ≤240 chars
```

Plus a coherence check the enums cannot catch: on a long, a stop above entry or a target
below it is nonsense, so the offending field is dropped rather than simulated. Inverted for
shorts.

### B2. `requestBacktestDecision(aiPrompt, prose)`

One non-streaming OpenRouter call. System message demands JSON only; user message is the
frozen snapshot prompt plus the prose just written. `temperature: 0`, `max_tokens: 400`,
`reasoning: { effort: "none" }` — this is extraction, not analysis. Parse tries
`JSON.parse`, then falls back to scanning for the first balanced `{…}`. One retry, then it
gives up and the feature degrades. Shares the existing `aiAbort` signal so a client
disconnect kills it.

### B3. `simulateTrade(decision, sealedBars)`

Pure function, no I/O, exported for tests.

```js
{ curve: [{ d, trade, stock, spy }],   // all indexed to $10,000
  entry: { date, price },
  exit:  { date, price, reason },      // "stop" | "target" | "horizon" | "end"
  stats: { trade_return, stock_return, spy_return, excess_vs_spy, max_dd } }
```

`max_dd` is the maximum drawdown of the **trade** line over the window, not the stock's.
`excess_vs_spy` is `trade_return − spy_return`.

**`conviction` does not affect the simulation.** Position size is always 100% of the
notional; conviction is displayed on the decision card and carried in the payload so it can
be correlated with outcomes later, but sizing is out of scope (see below). This is called
out because a 1–5 conviction field invites the assumption that it scales the position.

Rules:

- Entry at the first post-cutoff session's open.
- Each day, evaluate the **close** against stop and target thresholds derived from entry.
  On a breach, exit at the **next** session's open (or that day's close if it is the last
  bar available).
- Horizon exit at 21 / 63 / 126 sessions, also filling at the next open.
- After exit the trade line holds flat in cash to the end of the window, so every run
  shares one x-axis.
- Long and short share one code path with the sign flipped: a short's equity multiplier is
  `2 − price/entry`, its stop is a rise through `entry × (1 + stop_pct)`, its target a
  fall.
- `flat` draws no trade line; `curve[].trade` is null throughout and the verdict becomes
  "correctly avoided" or "missed the move" depending on the stock line.

The stock and SPY lines are always drawn from the same entry open regardless of the
decision, so the chart is never empty.

### B4. Budget

One `spendAi(COST.analyze.ai)` charge covers both calls, since it is one logical request —
consistent with the existing "charge once per logical request, never per attempt" rule. If
the day's AI budget is exhausted, both calls are skipped, `backtest_decision` reports
unavailable, and `backtest_outcomes` still reveals with the stock and SPY curves intact.

### B5. Exports

`sanitizeBacktestDecision` and `simulateTrade` join the test exports.

## Section C — Front end (`backtester.js`, `styles.css`)

### C1. Two charts, one new renderer

`drawChart()` is not reused — it is welded to `sessions[active]`, `chartOpts`, and the
analyzer's payload shape, and the adapter would be larger than a fresh renderer. A single
`drawLineChart(canvas, series, marks)` serves both:

- **"What it looked like then"** — pre-cutoff close line with MA50/MA200 and `key_levels`
  support/resistance as hairlines, drawn as soon as `backtest_snapshot` arrives. The page
  currently shows only text while the model writes; this puts the real setup on screen
  immediately and reads into the equity curve below.
- **The equity curve** — three lines indexed to $10,000, entry dot, stop/target fill dot, a
  faint vertical rule at the model's chosen horizon, and a hover tooltip reading all three
  values at a date.

### C2. Theme wiring

`backtester.js` has no canvas today, so this is new surface. Both canvases read tokens
through `cssVar()` and repaint on the `squall:theme` event, keying off `data-mode` and
never `data-theme`. A canvas silently losing its colors is the failure mode and nothing
errors. `cssVar` and `renderMarkdown` are reachable because `backtester.js` loads after
`app.js` in the same global scope; guard with `typeof` as the file already does.

### C3. Decision card

Above the outcome reveal: direction, conviction, horizon, stop and target, one-line
thesis. Attributed explicitly as the model's call under a blind snapshot, not as advice.

### C4. Resize

`ResizeObserver` plus dpr scaling on both canvases, matching what `drawChart` does.

## Failure modes

| Condition | Result |
|---|---|
| Decision call fails or returns unparseable output | No trade line; chart draws stock + SPY; card says unavailable |
| Cutoff too recent for the chosen horizon | Curve truncates, horizon rule omitted, exit reason `"end"` |
| No post-cutoff bars at all | Outcome section says so; equity chart skipped |
| TTM unbuildable | Valuation block omitted, `availability.valuation: false` |
| A signal engine throws | That block omitted, run continues |
| `adjclose` absent | Both bases fall back to raw, `price_basis` says so |
| AI budget exhausted | Both calls skipped, curves still drawn |

## Testing

**JS (`tests/js/server.test.js`)**

- `sanitizeBacktestDecision`: unknown direction, out-of-range conviction, a stop placed
  above entry on a long, an oversized thesis, non-JSON input.
- `simulateTrade`: stop fill at next open, horizon exit, short sign flip, `flat` producing
  a null trade line, target fill, truncated window, single-bar window.

**Python (`tests/python/test_backtester.py`)**

- TTM from four discrete quarters; TTM via YTD subtraction; annual fallback; refusal when
  neither is possible.
- Valuation uses the raw close, not the adjusted one.
- `price_history` contains no bar dated after the cutoff.
- **Replace the existing sealing test.** `assertNotIn("forward_returns", prompt)` checks a
  string that appears nowhere in the repository, so it would pass on a prompt leaking every
  outcome. It becomes: build the real output dict, assert no outcome *value* appears in
  `ai_prompt`, and assert the raw bar array is excluded.

**New contract check**

Every `send("backtest_*")` event name in `server.js` has a matching `addEventListener` in
`backtester.js`. CLAUDE.md calls the SSE names a contract but nothing enforces it, and this
feature adds two new events.

**Regression**

Re-run the three-page script execution check (`index.html`, `screener.html`, `ilgar.html`
against each page's real id set), since `backtester.js` grows substantially.

## Suggested phasing

The work is cohesive but large. Three phases, each independently shippable and verifiable:

1. **Decision + simulation + equity curve.** `sanitizeBacktestDecision`,
   `requestBacktestDecision`, `simulateTrade`, sealed bars in `outcomes`, the equity chart,
   the decision card, and the JS tests. This delivers the graph on its own — the snapshot
   stays as it is today.
2. **Snapshot enrichment, cheap half.** Dual price basis (A1), the column shim and four
   reused engines (A2), SPY-relative context, `price_history`, the `ai_prompt` projection,
   the "what it looked like then" chart, and the two passing fixes (A7).
3. **Valuation and fundamentals.** Expanded `FACTS`, TTM aggregation (A3), the derived
   multiples and margins, and their Python tests. Largest and most self-contained piece.

Phase 1 is the user-visible ask and depends on nothing in 2 or 3. Phase 2's dual price
basis (A1) is a prerequisite for phase 3's valuation math being correct.

## Out of scope

- Aggregating results across multiple backtest runs, or any leaderboard of model accuracy.
- Position sizing, multi-leg trades, options, or anything beyond a single long/short/flat.
- Historical news, analyst estimates, options flow, short interest, index membership —
  these cannot be honestly reconstructed and remain marked unavailable.
- Any change to `/` or `/screener`.

## Known limitation, unchanged by this work

The data pipeline is genuinely sealed, but the model carries post-cutoff knowledge in its
weights and the only defense is a system-prompt instruction. On a well-known ticker and
date the read is not truly blind. The page copy should not claim more than the pipeline
delivers.
