"use strict";

const assert = require("node:assert/strict");
const {
  sanitizeProfile, fallbackScreenerSpec, sanitizeScreenerSpec,
  validateBacktestDate, simulateTrade, sanitizeBacktestDecision,
  backtestProfilePlan, ensureBacktestPosition,
  LIM, COST, clientIp, clientKey, admit, buckets, globals,
  newAiStreamState, readAiStreamLine, aiStreamTruncated, describeAiStream, AI_SAMPLING,
  reasoningConfig, REASON_MAX_TOKENS, REASON_EFFORT, ANALYSIS_MAX
} = require("../../server");
const BARS = require("../fixtures/backtest_bars.json");

const BASE_LIMITS = { ...LIM };

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

function resetLimits(overrides = {}) {
  Object.assign(LIM, BASE_LIMITS, overrides);
  buckets.clear();
  Object.assign(globals, { dayId: "", ai: 0, scrape: 0, screen: 0, ceilingLogged: {} });
}

test("sanitizeProfile clamps scores and removes unsafe preference data", () => {
  const profile = sanitizeProfile({
    risk: 99, horizon: 0, experience: "unknown", depth: 3.6,
    style: "invented",
    priorities: ["growth", "growth", "downside", "bogus", "income", "momentum", "options"],
    custom: "  patient\u0000 investor\nwith context  "
  });
  assert.deepEqual(profile, {
    risk: 5, horizon: 1, experience: 3, depth: 4, style: "balanced",
    priorities: ["growth", "downside", "income", "momentum"],
    custom: "patient investor with context"
  });
  assert.equal(sanitizeProfile("not json"), null);
  assert.equal(sanitizeProfile([]), null);
});

test("sanitizeScreenerSpec rejects unknown concepts and unsafe model defaults", () => {
  const fallback = fallbackScreenerSpec("quality companies", null);
  const safe = sanitizeScreenerSpec({
    title: "  Quality\u0000 screen  ",
    summary: "measurable candidates",
    concepts: [
      { id: "quality", weight: 99, required: true },
      { id: "not_a_real_concept", weight: 2 }
    ],
    filters: {
      sectors: ["Technology", "Technology", "Not a sector"],
      price_min: 20, price_max: 10, pe_max: 0, beta_max: "none"
    },
    settings: { match_threshold: 999, consolidation_window: 45, momentum_window: 126 },
    max_results: 500,
    theme: {
      label: "AI\u0000 infrastructure",
      keywords: ["GPU!!!", "gpu", "data center", "x", "valid-term"],
      exclude_keywords: ["consulting<script>", ""],
      min_score: 999
    }
  }, fallback);

  assert.deepEqual(safe.concepts.map(c => c.id), ["quality"]);
  assert.equal(safe.concepts[0].weight, 3);
  assert.equal(safe.concepts[0].required, true);
  assert.deepEqual(safe.filters.sectors, ["Technology"]);
  assert.equal(safe.filters.price_min, 20);
  assert.equal("price_max" in safe.filters, false);
  assert.equal("pe_max" in safe.filters, false);
  assert.equal(safe.settings.match_threshold, 85);
  assert.equal(safe.settings.momentum_window, 126);
  assert.equal(safe.max_results, 50);
  assert.deepEqual(safe.theme.keywords, ["gpu", "data center", "valid-term"]);
  assert.equal(safe.theme.min_score, 80);
  assert.equal(safe.definitions[0].id, "quality");
});

test("historical analyzer dates are real, past, and within the supported era", () => {
  const now = new Date("2026-08-20T12:00:00Z");
  assert.deepEqual(validateBacktestDate("2024-02-29", now), { ok:true, value:"2024-02-29" });
  assert.equal(validateBacktestDate("2024-02-30", now).ok, false);
  assert.equal(validateBacktestDate("1999-12-31", now).ok, false);
  assert.equal(validateBacktestDate("2026-08-20", now).ok, false);
});

test("client identity ignores spoofed forwarding headers on a public peer", () => {
  resetLimits({ TRUST_PROXY: 1 });
  const req = request("203.0.113.80", { "x-forwarded-for": "1.2.3.4" });
  assert.equal(clientIp(req), "203.0.113.80");
  assert.equal(clientKey(req), "4:203.0.113.80");
});

test("client identity trusts the rightmost public hop behind a private proxy", () => {
  resetLimits({ TRUST_PROXY: 1 });
  const req = request("10.0.0.8", { "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
  assert.equal(clientIp(req), "203.0.113.9");
});

test("IPv6 client keys bucket addresses by /64", () => {
  resetLimits();
  const a = clientKey(request("2001:db8:1234:5678:0000:0000:0000:0001"));
  const b = clientKey(request("2001:db8:1234:5678:ffff:ffff:ffff:ffff"));
  const c = clientKey(request("2001:db8:1234:9999::1"));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(clientKey(request("::ffff:192.0.2.4")), "4:192.0.2.4");
});

test("admit enforces burst limits without charging a denied request", () => {
  resetLimits({
    BURST_CAP: 1, BURST_REFILL_MS: 600000,
    IP_HOURLY: 100, IP_DAILY: 100, IP_ANALYZE_DAILY: 100,
    GLOBAL_SCRAPE_DAILY: 100, GLOBAL_SCREEN_DAILY: 100
  });
  const req = request("192.0.2.20");
  assert.equal(admit(req, "chat").ok, true);
  const denied = admit(req, "chat");
  assert.equal(denied.ok, false);
  assert.equal(denied.rule, "burst");
  const entry = buckets.get("4:192.0.2.20");
  assert.equal(entry.dayN, 1);
  assert.equal(entry.hourN, 1);
});

test("admit applies engine costs only after every gate passes", () => {
  resetLimits({
    BURST_CAP: 10, IP_HOURLY: 100, IP_DAILY: 100, IP_ANALYZE_DAILY: 100,
    GLOBAL_SCRAPE_DAILY: 100, GLOBAL_SCREEN_DAILY: 0
  });
  const screenReq = request("192.0.2.21");
  const denied = admit(screenReq, "screen");
  assert.equal(denied.rule, "global_screen");
  const untouched = buckets.get("4:192.0.2.21");
  assert.equal(untouched.tokens, 10);
  assert.equal(untouched.dayN, 0);
  assert.equal(globals.screen, 0);

  LIM.GLOBAL_SCREEN_DAILY = 100;
  const analyzeReq = request("192.0.2.22");
  assert.equal(admit(analyzeReq, "analyze").ok, true);
  assert.equal(buckets.get("4:192.0.2.22").analyzeN, COST.analyze.scrape);
  assert.equal(globals.scrape, COST.analyze.scrape);
});

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

test("a simulated trade that hits none of its exits runs to the horizon", () => {
  // 30 rising sessions; close[i] = 100 + i, open[i] = 99.5 + i
  const dates = [], open = [], close = [], spyOpen = [], spyClose = [];
  for (let i = 0; i < 30; i++) {
    dates.push(`2023-06-${String(i + 1).padStart(2, "0")}`);
    open.push(99.5 + i); close.push(100 + i);
    spyOpen.push(300); spyClose.push(300);
  }
  const result = simulateTrade(
    { direction: "long", horizon: "1m", stop_pct: null, target_pct: null },
    { dates, open, close, spyOpen, spyClose });

  // 1m is 21 sessions: the 21st session is index 20, so the fill is index 21's open
  assert.equal(result.exit.reason, "horizon");
  assert.equal(result.exit.date, dates[21]);
  assert.equal(result.exit.price, 120.5);
  assert.equal(Math.round(result.stats.trade_return * 1e6) / 1e6, 0.211055);
});

test("an exit triggered on the final bar fills at that close, not an invented open", () => {
  const bars = {
    dates: ["2023-06-01", "2023-06-02", "2023-06-05", "2023-06-06", "2023-06-07"],
    open:  [100, 100, 100, 100, 100],
    close: [100, 100, 100, 100, 80],
    spyOpen:  [300, 300, 300, 300, 300],
    spyClose: [300, 300, 300, 300, 300]
  };
  const result = simulateTrade(
    { direction: "long", horizon: "6m", stop_pct: 0.08, target_pct: null }, bars);

  // The breach is on the last bar, so there is no next open to fill against.
  assert.equal(result.exit.reason, "stop");
  assert.equal(result.exit.date, "2023-06-07");
  assert.equal(result.exit.price, 80);
  assert.equal(Math.round(result.stats.trade_return * 1e6) / 1e6, -0.2);
});

test("simulated drawdown and excess return are measured against the right baselines", () => {
  const result = simulateTrade(
    { direction: "long", horizon: "6m", stop_pct: 0.08, target_pct: null }, BARS);

  // Trade equity peaks at 11200 (close 112) and bottoms at the 9000 stop fill.
  assert.equal(Math.round(result.stats.max_dd * 1e6) / 1e6, -0.196429);
  // SPY ran 200 -> 210 over the window, so +5% against the trade's -10%.
  assert.equal(Math.round(result.stats.spy_return * 1e6) / 1e6, 0.05);
  assert.equal(Math.round(result.stats.excess_vs_spy * 1e6) / 1e6, -0.15);
});

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

test("backtest decisions reject sub-noise stops and clamp conviction upward", () => {
  // Without these, deleting the 0.01 floor or the Math.max(1, …) clamp still passes
  // every other test — only the ceiling checks above would be load-bearing.
  const tiny = sanitizeBacktestDecision({ direction: "long", stop_pct: 0.009, target_pct: 0.009 });
  assert.equal(tiny.stop_pct, null);
  assert.equal(tiny.target_pct, null);
  // 0.01 itself is inside the range — the floor is inclusive.
  assert.equal(sanitizeBacktestDecision({ direction: "long", stop_pct: 0.01 }).stop_pct, 0.01);
  assert.equal(sanitizeBacktestDecision({ direction: "long", conviction: 0 }).conviction, 1);
  assert.equal(sanitizeBacktestDecision({ direction: "long", conviction: -7 }).conviction, 1);
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

test("MySquall deterministically controls backtest exposure and supported horizon", () => {
  const cautious = backtestProfilePlan({ risk:1, horizon:1, style:"balanced" });
  assert.equal(cautious.position_pct, 0.10);
  assert.equal(cautious.horizon, "1m");

  const options = backtestProfilePlan({ risk:5, horizon:5, style:"options" });
  assert.equal(options.position_pct, 0.33);
  assert.equal(options.horizon, "6m");
  assert.equal(options.options_proxy, true);
  assert.equal(options.instrument, "underlying_stock_proxy");
});

test("completed backtests always receive a long or short position", () => {
  const snapshot = { technical:{
    scores:{ uptrend:72, accumulation:65, momentum:70, breakout:60,
      downtrend:28, distribution:35 },
    metrics:{ return_20d:0.08, return_60d:0.15, atr_pct:0.025 }
  }};
  const decision = ensureBacktestPosition(null, snapshot,
    { risk:2, horizon:3, style:"balanced" });
  assert.equal(decision.direction, "long");
  assert.equal(decision.decision_source, "rules_fallback");
  assert.equal(decision.position_pct, 0.20);
  assert.equal(decision.horizon, "3m");
  assert.ok(decision.stop_pct > 0);
  assert.ok(decision.target_pct > decision.stop_pct);
});

test("AI direction survives and conviction scales the profile's exposure", () => {
  const decision = ensureBacktestPosition(
    { direction:"short", conviction:4, horizon:"1m", stop_pct:0.08, target_pct:0.2,
      thesis:"Weak trend." },
    { technical:{ metrics:{ atr_pct:0.03 } } },
    { risk:4, horizon:5, style:"long-term" });
  assert.equal(decision.direction, "short");
  assert.equal(decision.decision_source, "ai");
  // risk 4 sizes at 0.50; conviction 4 scales it 1.3x. Conviction used to be rendered and
  // discarded, which left the model no way to bet more on a setup it believed in.
  assert.equal(decision.position_pct, 0.65);
  assert.equal(decision.position_pct_base, 0.50);
  assert.equal(decision.conviction_scale, 1.3);
});

test("conviction 3 sizes exactly as the profile alone did", () => {
  // The multiplier is centred on 1.0 so an unchanged profile is bit-identical to the
  // pre-conviction behaviour. Without this every existing saved profile silently resizes.
  for (const risk of [1, 2, 3, 4, 5]) {
    const plan = backtestProfilePlan({ risk, horizon:3, style:"balanced" });
    const decision = ensureBacktestPosition(
      { direction:"long", conviction:3, horizon:"3m", stop_pct:0.06 },
      { technical:{ metrics:{ atr_pct:0.03 } } }, { risk, horizon:3, style:"balanced" });
    assert.equal(decision.position_pct, plan.position_pct);
    assert.equal(decision.conviction_scale, 1);
  }
});

test("conviction can never size past the profile's own ceiling", () => {
  // 0.75 is the band backtestProfilePlan enforces; a 5 must not vault over it.
  const decision = ensureBacktestPosition(
    { direction:"long", conviction:5, horizon:"6m", stop_pct:0.10 },
    { technical:{ metrics:{ atr_pct:0.05 } } },
    { risk:5, horizon:5, style:"growth" });
  assert.ok(decision.position_pct <= 0.75, `sized ${decision.position_pct} past the ceiling`);
  // ...and the floor holds at the other end.
  const timid = ensureBacktestPosition(
    { direction:"long", conviction:1, horizon:"1m", stop_pct:0.04 },
    { technical:{ metrics:{ atr_pct:0.02 } } },
    { risk:1, horizon:1, style:"options" });
  assert.ok(timid.position_pct >= 0.05, `sized ${timid.position_pct} under the floor`);
});

test("the profile caps the horizon but does not lengthen it", () => {
  // A shorter hold cannot breach a preference expressed as "how long am I willing to be
  // exposed". This used to overwrite unconditionally, so all 18 runs of the /ilgar audit
  // executed at 3m including the four that asked for 1m.
  const shorter = ensureBacktestPosition(
    { direction:"long", conviction:3, horizon:"1m", stop_pct:0.05 },
    { technical:{ metrics:{ atr_pct:0.03 } } },
    { risk:3, horizon:5, style:"long-term" });
  assert.equal(shorter.horizon, "1m");
  assert.equal(shorter.horizon_capped, false);

  const longer = ensureBacktestPosition(
    { direction:"long", conviction:3, horizon:"6m", stop_pct:0.05 },
    { technical:{ metrics:{ atr_pct:0.03 } } },
    { risk:3, horizon:1, style:"swing" });
  assert.equal(longer.horizon, "1m");
  assert.equal(longer.horizon_requested, "6m");
  assert.equal(longer.horizon_capped, true);
});

test("MySquall risk settings bound an extracted stop and reward target", () => {
  const decision = ensureBacktestPosition(
    { direction:"long", conviction:3, horizon:"6m", stop_pct:0.40, target_pct:0.01 },
    { technical:{ metrics:{ atr_pct:0.04 } } },
    { risk:1, horizon:1, style:"balanced" });
  assert.equal(decision.stop_pct, 0.05);
  assert.equal(decision.target_pct, 0.075);
  assert.equal(decision.position_pct, 0.10);
});

test("simulated trade return scales with the MySquall position size", () => {
  const bars = {
    dates:["2024-01-02", "2024-01-03"], open:[100, 110], close:[100, 110],
    spyOpen:[100, 100], spyClose:[100, 100]
  };
  const result = simulateTrade(
    { direction:"long", horizon:"6m", position_pct:0.25, stop_pct:null, target_pct:null }, bars);
  assert.equal(Math.round(result.stats.trade_return * 10000) / 10000, 0.025);
  assert.equal(result.curve.at(-1).trade, 10250);
});

/* ── AI stream termination ──────────────────────────────────────────────────
   A response that stops because it hit max_tokens ends the SSE stream cleanly:
   no error, no dropped socket, just a last chunk carrying finish_reason.
   Reading the deltas alone cannot tell that apart from a finished answer, which
   is why a truncated write-up used to render as "Analysis complete". */

function feed(lines, state, emit = () => {}) {
  for (const line of lines) {
    const err = readAiStreamLine(line, state, emit);
    if (err) return err;
  }
  return null;
}

function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}`;
}

test("readAiStreamLine accumulates reasoning and answer deltas and reports neither as truncated", () => {
  const state = newAiStreamState();
  const seen = [];
  const err = feed([
    ": OPENROUTER PROCESSING",
    chunk({ reasoning: "weighing " }),
    chunk({ reasoning: "the multiple" }),
    chunk({ content: "## Verdict\n" }),
    chunk({ content: "Hold." }, { finish_reason: "stop", native_finish_reason: "stop" }),
    "data: [DONE]"
  ], state, (kind, text) => seen.push([kind, text]));

  assert.equal(err, null);
  assert.equal(state.reasoning, "weighing the multiple");
  assert.equal(state.answer, "## Verdict\nHold.");
  assert.equal(state.emitted, true);
  assert.equal(state.finishReason, "stop");
  assert.equal(aiStreamTruncated(state), false);
  assert.deepEqual(seen, [
    ["reasoning", "weighing "], ["reasoning", "the multiple"],
    ["answer", "## Verdict\n"], ["answer", "Hold."]
  ]);
});

test("aiStreamTruncated catches a response cut off at max_tokens", () => {
  const state = newAiStreamState();
  feed([
    chunk({ content: "## Verdict\nThe balance sheet carries" }),
    chunk({}, { finish_reason: "length" }),
    "data: [DONE]"
  ], state);
  assert.equal(state.finishReason, "length");
  assert.equal(aiStreamTruncated(state), true);
});

test("aiStreamTruncated reads a provider's own truncation wording, whatever its case", () => {
  for (const native of ["MAX_TOKENS", "max_tokens", "length", "Length"]) {
    const state = newAiStreamState();
    feed([chunk({ content: "cut" }, { finish_reason: null, native_finish_reason: native })], state);
    assert.equal(aiStreamTruncated(state), true, `native_finish_reason ${native} should read as truncated`);
  }
  const clean = newAiStreamState();
  feed([chunk({ content: "done" }, { native_finish_reason: "STOP" })], clean);
  assert.equal(aiStreamTruncated(clean), false);
});

test("readAiStreamLine records usage and the serving provider so a thinking loop is visible", () => {
  const state = newAiStreamState();
  feed([
    chunk({ reasoning: "..." }),
    `data: ${JSON.stringify({
      provider: "SomeHost",
      choices: [{ delta: {}, finish_reason: "length" }],
      usage: { completion_tokens: 5980, prompt_tokens: 9000,
               completion_tokens_details: { reasoning_tokens: 5975 } }
    })}`,
    "data: [DONE]"
  ], state);

  assert.equal(state.provider, "SomeHost");
  assert.equal(state.usage.completion_tokens, 5980);
  const line = describeAiStream(state);
  // The whole point of the log line is spotting reasoning that ate the answer budget.
  assert.match(line, /SomeHost/);
  assert.match(line, /length/);
  assert.match(line, /reasoning=5975/);
  assert.match(line, /answer=5/);
});

test("readAiStreamLine surfaces an in-stream provider error instead of swallowing it", () => {
  const state = newAiStreamState();
  const err = feed([`data: ${JSON.stringify({ error: { message: "upstream exploded" } })}`], state);
  assert.ok(err instanceof Error);
  assert.match(err.message, /upstream exploded/);
});

test("readAiStreamLine ignores keep-alives, blank data and unparseable chunks", () => {
  const state = newAiStreamState();
  const err = feed([": keep-alive", "", "data:", "data: {not json", "id: 7"], state);
  assert.equal(err, null);
  assert.equal(state.emitted, false);
  assert.equal(state.finishReason, null);
});

test("thinking is capped in absolute tokens, leaving the answer a guaranteed floor", () => {
  // `effort` is a percentage of max_tokens and is not honored by every serving stack:
  // measured on /backtest-stream, effort "low" (nominally ~20%) produced 47,000-62,000
  // CHARACTERS of reasoning — 75-97% of the whole budget — and since thinking and answer
  // share max_tokens the write-up arrived corrupted, truncated, or not at all.
  const cfg = reasoningConfig();
  assert.ok("max_tokens" in cfg, "reasoning must carry an absolute cap, not just effort");
  assert.equal(cfg.max_tokens, REASON_MAX_TOKENS);
  assert.ok(cfg.max_tokens > 0);
  // The point of the cap: whatever the host does, the answer keeps this much room.
  const answerFloor = ANALYSIS_MAX - cfg.max_tokens;
  assert.ok(answerFloor >= 8000,
    `answer floor is only ${answerFloor} tokens of ${ANALYSIS_MAX}`);
});

test("zeroing the reasoning cap falls back to effort rather than sending nothing", () => {
  // The escape hatch, same shape as SQUALL_AI_FREQ_PENALTY=0: if a host rejects the
  // absolute form and routing starts failing, this reverts to the previous behaviour
  // from the dashboard with no deploy. It must never yield an empty reasoning object,
  // which would disable thinking outright and empty the UI's "Show thinking" panel.
  const prev = process.env.SQUALL_REASON_MAX_TOKENS;
  try {
    process.env.SQUALL_REASON_MAX_TOKENS = "0";
    delete require.cache[require.resolve("../../server.js")];
    const reloaded = require("../../server.js");
    const cfg = reloaded.reasoningConfig();
    assert.ok(!("max_tokens" in cfg));
    assert.equal(cfg.effort, reloaded.REASON_EFFORT);
    assert.ok(cfg.effort && cfg.effort !== "none");
  } finally {
    if (prev === undefined) delete process.env.SQUALL_REASON_MAX_TOKENS;
    else process.env.SQUALL_REASON_MAX_TOKENS = prev;
    delete require.cache[require.resolve("../../server.js")];
    require("../../server.js");
  }
});

test("AI sampling sends a repetition damper and only routes to providers that honor it", () => {
  // A degenerate loop is the failure this defends against; OpenRouter silently DROPS
  // an unsupported parameter, so require_parameters is what makes the damper real.
  assert.ok(AI_SAMPLING.frequency_penalty > 0, "frequency_penalty must be applied");
  assert.equal(AI_SAMPLING.provider.require_parameters, true);
  assert.equal(AI_SAMPLING.provider.allow_fallbacks, true);
});

test("zeroing the repetition damper also drops the provider constraint it needs", () => {
  // require_parameters filters the pool BEFORE allow_fallbacks can reroute, so leaving it
  // on with no parameter to require would narrow routing for nothing. This is the documented
  // one-env-var revert, and it is only a revert if both halves come off together.
  const { execFileSync } = require("node:child_process");
  const read = env => JSON.parse(execFileSync(process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(require('./server').AI_SAMPLING))"],
    { env: { ...process.env, ...env }, encoding: "utf8" }));

  const off = read({ SQUALL_AI_FREQ_PENALTY: "0" });
  assert.equal("frequency_penalty" in off, false);
  assert.equal("require_parameters" in off.provider, false);
  assert.equal(off.provider.allow_fallbacks, true);

  const on = read({ SQUALL_AI_FREQ_PENALTY: "0.5" });
  assert.equal(on.frequency_penalty, 0.5);
  assert.equal(on.provider.require_parameters, true);

  // An out-of-range or garbage value must fall back to the default, never disable silently.
  assert.equal(read({ SQUALL_AI_FREQ_PENALTY: "banana" }).frequency_penalty, 0.3);
  assert.equal(read({ SQUALL_AI_FREQ_PENALTY: "9" }).frequency_penalty, 0.3);
});
