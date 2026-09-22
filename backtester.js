"use strict";

let backtestSource = null;
let backtestFinished = false;
let backtestWatchdog = null;
let backtestAnswer = "";
let backtestThinking = "";
let backtestPaint = null;

const BT_FACT_LABELS = {
  revenue:"Revenue", net_income:"Net income", operating_income:"Operating income",
  operating_cash_flow:"Operating cash flow", assets:"Assets", liabilities:"Liabilities",
  equity:"Stockholders’ equity", cash:"Cash and equivalents", diluted_eps:"Diluted EPS",
  shares_outstanding:"Shares outstanding"
};
const BT_SCORE_LABELS = {
  uptrend:"Uptrend", momentum:"Momentum", accumulation:"Accumulation", breakout:"Breakout quality",
  vcp:"VCP candidate", cup_and_handle:"Cup with handle", flat_base:"Flat base",
  double_bottom:"Double bottom", bull_flag:"Bull flag", volatility_contraction:"Volatility contraction"
};

function btEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
}
function btNum(value) {
  // Number(null) is 0 and 0 passes Number.isFinite, so a missing figure would render
  // as a confident "0.0%" rather than an em dash — and btPct's caller would style it
  // as a positive result. The engine sends null for a horizon that has not elapsed
  // yet, so this is reachable from any recent cutoff. Same trap as btFinite in
  // server.js, which was caught during Task 1 and is the reason this was looked for.
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function btPct(value, digits = 1) {
  const number = btNum(value);
  return number === null ? "—" : `${number > 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
}
function btMagnitudePct(value, digits = 1) {
  const number = btNum(value);
  return number === null ? "—" : `${(Math.abs(number) * 100).toFixed(digits)}%`;
}
function btUsd(value) {
  const number = btNum(value);
  if (number === null) return "—";
  const abs = Math.abs(number);
  if (abs >= 1e12) return `${number < 0 ? "−" : ""}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${number < 0 ? "−" : ""}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${number < 0 ? "−" : ""}$${(abs / 1e6).toFixed(1)}M`;
  return `${number < 0 ? "−" : ""}$${abs.toLocaleString(undefined, { maximumFractionDigits:2 })}`;
}
function btFactValue(row) {
  if (!row) return "—";
  if (row.unit === "USD") return btUsd(row.value);
  if (row.unit === "USD/shares") return btUsd(row.value);
  if (row.unit === "shares") {
    const value = btNum(row.value);
    if (value === null) return "—";
    return value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value.toLocaleString();
  }
  return btEsc(row.value);
}
function btDateDaysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }

function setBacktestProgress(percent, label, error = false) {
  const wrap = document.getElementById("backtestProgress");
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  wrap.classList.add("show");
  wrap.classList.toggle("error", error);
  document.getElementById("backtestProgressText").textContent = label;
  document.getElementById("backtestProgressPct").textContent = `${pct}%`;
  document.getElementById("backtestProgressFill").style.width = `${pct}%`;
  wrap.querySelector("[role=progressbar]").setAttribute("aria-valuenow", String(pct));
}

function renderBacktestSnapshot(payload) {
  const snapshot = payload.snapshot || {};
  const metrics = snapshot.technical?.metrics || {};
  const scores = snapshot.technical?.scores || {};
  const metricCards = [
    ["Adjusted close", btUsd(metrics.price)], ["20-session return", btPct(metrics.return_20d)],
    ["60-session return", btPct(metrics.return_60d)], ["RSI (14)", btNum(metrics.rsi14)?.toFixed(1) || "—"],
    ["From 52-week high", btPct(metrics.distance_52w_high)], ["Realized volatility", btPct(metrics.volatility)],
    ["Volume vs 20-day", btNum(metrics.volume_ratio) === null ? "—" : `${btNum(metrics.volume_ratio).toFixed(2)}×`],
    ["1-year max drawdown", btPct(metrics.max_drawdown_1y)]
  ].map(([label, value]) => `<div class="backtest-stat"><span>${btEsc(label)}</span><b>${btEsc(value)}</b></div>`).join("");

  const scoreCards = Object.entries(BT_SCORE_LABELS)
    .map(([key, label]) => [label, btNum(scores[key])])
    .filter(([, value]) => value !== null)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => `<div class="backtest-score"><div><span>${btEsc(label)}</span><b>${Math.round(value)}</b></div><div><i style="width:${Math.max(0, Math.min(100, value))}%"></i></div></div>`).join("");

  const factCards = Object.entries(snapshot.sec_facts || {}).map(([key, fact]) => {
    const latest = fact.series?.[0];
    const history = (fact.series || []).slice(1, 4).map(row => `<span>${btEsc(row.period_end)} · ${btFactValue(row)}</span>`).join("");
    return `<article class="backtest-fact"><span>${btEsc(BT_FACT_LABELS[key] || key)}</span><b>${btFactValue(latest)}</b><small>${latest ? `${btEsc(latest.form)} · period ended ${btEsc(latest.period_end)} · filed ${btEsc(latest.filed)}` : "Unavailable"}</small>${history ? `<details><summary>Earlier reported periods</summary>${history}</details>` : ""}</article>`;
  }).join("") || `<p class="backtest-empty">No structured SEC facts were available for this issuer by the cutoff.</p>`;

  /*
   * Two blocks, two panels, deliberately not one.
   *
   * `fundamentals` is built from filing figures alone — no price enters it — so it is
   * exact as reported. `valuation` divides a split-adjusted price stated on TODAY's
   * share basis by as-reported filing figures stated on the cutoff's basis, which the
   * engine flags with per_share_ratios_reliable:false. NVDA at a 2024-05-01 cutoff
   * computes a P/E of 6.96 against a true ~70 because of the June-2024 10:1 split.
   * Rendering "P/E 7.0" as a bare number publishes a wrong figure with confidence, so
   * the caveat ships inside the same panel and cannot be read apart from the ratios.
   * A single shared panel would have done the opposite damage as well: it would cast
   * the caveat over margins and ROE, which need no caveat at all.
   */
  const VAL_LABELS = { pe:"P/E", ps:"P/S", pb:"P/B", ev_ebitda:"EV/EBITDA", fcf_yield:"FCF yield" };
  const FUND_LABELS = { gross_margin:"Gross margin", operating_margin:"Operating margin",
    net_margin:"Net margin", roe:"ROE", current_ratio:"Current ratio", debt_to_equity:"Debt/equity" };
  const valuation = snapshot.valuation || {};
  const fundamentals = snapshot.fundamentals || {};
  const btStat = (label, value) => `<div class="backtest-stat"><span>${btEsc(label)}</span><b>${btEsc(value)}</b></div>`;
  const ratioCards = Object.entries(VAL_LABELS).map(([key, label]) => {
    const value = btNum(valuation[key]);
    return value === null ? "" : btStat(label, key === "fcf_yield" ? btPct(value) : `${value.toFixed(1)}×`);
  }).join("");
  const fundCards = Object.entries(FUND_LABELS).map(([key, label]) => {
    const value = btNum(fundamentals[key]);
    if (value === null) return "";
    return btStat(label, key.endsWith("_margin") || key === "roe" ? btPct(value) : value.toFixed(2));
  }).join("");
  const ttm = valuation.ttm_basis || fundamentals.ttm_basis;
  const ttmNote = ttm ? ` Trailing-twelve-month figures are on a ${btEsc(ttm)} basis.` : "";
  // The engine's own wording is reproduced rather than paraphrased, so this cannot
  // drift into understating a caveat that backtester.py later strengthens.
  const ratioCaveat = valuation.per_share_ratios_reliable === true
    ? `<p class="backtest-caveat">Priced off the close at the cutoff.${ttmNote}</p>`
    : `<div class="backtest-caveat"><b>Unreliable in level.</b> Every ratio above divides a
        split-adjusted price stated on today's share basis by as-reported filing figures stated
        on the cutoff's basis. A split between that date and now divides all of them by the split
        ratio, so a later 10-for-1 makes them read ten times too cheap. Whether one happened is
        not knowable from data dated on or before the cutoff, so it is not corrected. Read them
        against each other, never against a remembered multiple.${ttmNote}${
      valuation.basis_caveat ? `<details><summary>The engine's own wording</summary>${btEsc(valuation.basis_caveat)}</details>` : ""}</div>`;
  const valuationPanel = ratioCards
    ? `<section class="backtest-panel"><h3>Valuation multiples known by the cutoff</h3><div class="backtest-stats">${ratioCards}</div>${ratioCaveat}</section>`
    : "";
  const fundamentalsPanel = fundCards
    ? `<section class="backtest-panel"><h3>Fundamentals known by the cutoff</h3><div class="backtest-stats">${fundCards}</div><p class="backtest-caveat">Computed from filing figures alone. No price enters these, so unlike the multiples above they are exact as reported.${ttmNote}</p></section>`
    : "";

  /*
   * When the next results were due, reconstructed from the issuer's own filing cadence.
   *
   * Rendered beside the filings it was derived from, and always carrying its own
   * uncertainty: this is an estimate from a median lag, not a calendar entry, and a panel
   * that showed a bare date would be claiming a precision the method does not have.
   */
  const event = snapshot.event_risk;
  const eventPanel = !event ? "" : (() => {
    const opens = btNum(event.days_until_earnings_window_opens);
    const open = event.earnings_window_already_open;
    const imminent = open || (opens != null && opens <= 21);
    const win = Array.isArray(event.earnings_window) ? event.earnings_window : [];
    const filed = Array.isArray(event.expected_filing_window) ? event.expected_filing_window : [];
    return `<section class="backtest-panel"><h3>Event risk known by the cutoff</h3>
      <div class="backtest-stats">
        ${btStat("Earnings window", `${btEsc(win[0] || "—")} → ${btEsc(win[1] || "—")}`)}
        ${btStat("Opens in", open ? "already open" : opens == null ? "—" : `~${opens} days`)}
        ${btStat("Pending period ended", btEsc(event.pending_period_end))}
        ${btStat("Filing lag used", `${btEsc(event.observed_filing_lag_days?.median)}d median`)}
      </div>
      ${imminent ? `<p class="backtest-caveat"><b>Inside the holding window.</b> Results are
        expected ${open ? "any session now" : `within about ${opens} days`}. An earnings gap
        opens past a stop rather than through it, so a stop distance does not bound the loss
        across this event.</p>` : ""}
      <p class="backtest-curve-note">Periodic filing expected between
        ${btEsc(filed[0] || "—")} and ${btEsc(filed[1] || "—")}; the results announcement
        lands at or before it. Derived from this issuer's own period-end-to-filing lags on a
        ${btEsc(event.reporting_cadence_days)}-day cadence — no calendar and no post-cutoff
        data was used, so treat it as accurate to within a week or two, never to the day.</p>
    </section>`;
  })();

  const filings = (snapshot.filings_known_by_cutoff || []).slice(0, 8).map(filing =>
    `<div class="backtest-filing"><b>${btEsc(filing.form)}</b><span>Filed ${btEsc(filing.filed)}${filing.report_date ? ` · report date ${btEsc(filing.report_date)}` : ""}</span></div>`
  ).join("") || `<p class="backtest-empty">No SEC filing list was available by the cutoff.</p>`;

  document.getElementById("backtestSnapshot").innerHTML = `
    <div class="backtest-section-head"><div><span>Frozen snapshot</span><h2>${btEsc(snapshot.company_name || snapshot.ticker)} <small>${btEsc(snapshot.ticker)}</small></h2></div><b>As of ${btEsc(snapshot.effective_market_date || snapshot.as_of)}</b></div>
    <div class="backtest-integrity" id="backtestIntegrityState">Bars and filing dates are restricted to the cutoff. Current-vintage adjustments and provider revisions remain possible. Forward outcomes are excluded from the AI input.</div>
    <section class="backtest-panel" id="backtestSetup"></section>
    <section class="backtest-panel"><h3>Price and technical condition</h3><div class="backtest-stats">${metricCards}</div><div class="backtest-scores">${scoreCards}</div></section>
    ${valuationPanel}${fundamentalsPanel}${eventPanel}
    <section class="backtest-panel"><h3>SEC facts known by the cutoff</h3><div class="backtest-facts">${factCards}</div></section>
    <section class="backtest-panel"><h3>Recent filings known by the cutoff</h3><div class="backtest-filings">${filings}</div></section>`;
  renderBacktestSetupChart(snapshot);
}

function paintBacktestAi() {
  backtestPaint = null;
  const body = document.getElementById("backtestAiBody");
  if (!body) return;
  const narrative = backtestAnswer.replace(/<replay_decision>[\s\S]*?(?:<\/replay_decision>|$)/g, "");
  const html = typeof renderMarkdown === "function" ? renderMarkdown(narrative) : `<p>${btEsc(narrative)}</p>`;
  body.innerHTML = html || `<div class="backtest-ai-wait"><span></span><span></span><span></span></div>`;
  const thinking = document.getElementById("backtestThinkingText");
  if (thinking) thinking.textContent = backtestThinking;
}
function scheduleBacktestAiPaint() {
  if (!backtestPaint) backtestPaint = requestAnimationFrame(paintBacktestAi);
}
// ilgar.html loads app.js before this file, so prettyModel is in scope — but guard it
// rather than assume, because a raw id here is a visible regression ("openai/gpt-5.6-luna"
// instead of "GPT 5.6 Luna") and a missing function would take the whole panel down.
function btModelLabel(model) {
  if (!model) return "AI";
  return typeof prettyModel === "function" ? prettyModel(model) : model;
}
function openBacktestAi(model) {
  document.getElementById("backtestAi").innerHTML = `
    <div class="backtest-section-head"><div><span>Retrospective AI research</span><h2>Interpretation of the dated evidence</h2></div><b>${btEsc(btModelLabel(model))}</b></div>
    <section class="backtest-panel backtest-ai-panel"><details><summary>Model reasoning</summary><pre id="backtestThinkingText"></pre></details><div id="backtestAiBody" class="prose"><div class="backtest-ai-wait"><span></span><span></span><span></span></div></div></section>`;
}

function renderBacktestOutcomes(payload) {
  replayAudit = payload.audit || null;
  const outcome = payload.outcomes || {};
  const returns = outcome.returns || {};
  const benchmark = outcome.benchmark_returns || {};
  const excess = outcome.excess_returns || {};
  const periods = [["1m", "1 month"], ["3m", "3 months"], ["6m", "6 months"]];
  const cards = periods.map(([key, label]) => {
    const value = btNum(returns[key]);
    const cls = value === null ? "" : value >= 0 ? "positive" : "negative";
    return `<article class="backtest-outcome ${cls}"><span>${label}</span><b>${btPct(value)}</b><small>SPY ${btPct(benchmark[key])} · excess ${btPct(excess[key])}</small><em>${outcome.exit_dates?.[key] ? `through ${btEsc(outcome.exit_dates[key])}` : "Not enough future sessions yet"}</em></article>`;
  }).join("");
  document.getElementById("backtestOutcomes").innerHTML = `
    <div class="backtest-section-head"><div><span>Outcome reveal</span><h2>What happened afterward</h2></div><button type="button" class="chip" onclick="downloadReplayAudit()" ${replayAudit ? "" : "disabled"}>Download audit JSON</button></div>
    <section class="backtest-panel" id="backtestCurve"></section>
    <div class="backtest-outcome-entry">Separate market-context returns below use dividend-adjusted data where available; they are not the price-return trade simulation above. Entry: <b>${outcome.entry_date ? `${btUsd(outcome.entry_price)} on ${btEsc(outcome.entry_date)}` : "Unavailable"}</b></div>
    <div class="backtest-outcomes">${cards}</div>
    <div class="backtest-integrity">Maximum available six-month drawdown after entry: <b>${btPct(outcome.max_drawdown_6m)}</b>. Future bars were excluded from the prompt. Model memory and case selection prevent treating this as proof of predictive skill.</div>`;
  renderBacktestCurve(payload.simulation);
  const integrity = document.getElementById("backtestIntegrityState");
  if (integrity) integrity.textContent = "Forward outcomes were released after generation ended. Date filtering does not erase model memory or provider revisions; this is retrospective research.";
}

function finishBacktest(label, error = false) {
  backtestFinished = true;
  clearTimeout(backtestWatchdog);
  const button = document.getElementById("backtestRun");
  button.disabled = false;
  button.textContent = "Run research replay";
  setBacktestProgress(error ? 0 : 100, label, error);
  if (backtestSource) { backtestSource.close(); backtestSource = null; }
}

function showBacktestError(title, detail) {
  document.getElementById("backtestError").innerHTML =
    `<div class="backtest-error"><b>${btEsc(title)}</b><span>${btEsc(detail)}</span></div>`;
}

/*
 * A silent stream must not look like a working one.
 *
 * An EventSource that connects and then says nothing is, to the page, identical to
 * one that is busy: no error fires, so every handler below simply never runs and the
 * progress bar keeps whatever label was last written. That label is set here at 1%
 * BEFORE the stream is opened, so the observed failure was /ilgar sitting on
 * "Starting the historical analysis" indefinitely with the Run button latched
 * disabled — a page reload the only way out.
 *
 * Two windows rather than one, because the two silences mean different things.
 * Nothing at all is a connection fault: the server's first event is unconditional
 * and immediate (it precedes the queue, the engine and the AI), so twenty seconds
 * without it means the request never arrived or was never answered. A gap AFTER
 * events have flowed is normal — the model can think for a long stretch between
 * tokens, and the decision-extraction call late in the run is a deliberate pause —
 * so that window is generous and only catches a genuinely dead stream.
 */
const BT_FIRST_EVENT_MS = 20000;
const BT_SILENCE_MS = 90000;

function armBacktestWatchdog(source, ms, title, detail) {
  clearTimeout(backtestWatchdog);
  backtestWatchdog = setTimeout(() => {
    if (backtestFinished || backtestSource !== source) return;
    showBacktestError(title, detail);
    finishBacktest(title, true);
  }, ms);
}

function runBacktest() {
  const ticker = document.getElementById("backtestTicker").value.trim();
  const asOf = document.getElementById("backtestDate").value;
  if (!ticker || !asOf) {
    document.getElementById("backtestError").innerHTML = `<div class="backtest-error">Enter a company and choose a cutoff date.</div>`;
    return;
  }
  if (backtestSource) backtestSource.close();
  backtestFinished = false; backtestAnswer = ""; backtestThinking = "";
  document.getElementById("backtestError").innerHTML = "";
  document.getElementById("backtestSnapshot").innerHTML = "";
  document.getElementById("backtestDecision").innerHTML = "";
  document.getElementById("backtestAi").innerHTML = "";
  document.getElementById("backtestOutcomes").innerHTML = "";
  const button = document.getElementById("backtestRun");
  button.disabled = true; button.textContent = "Running…";
  setBacktestProgress(1, "Starting the historical analysis");
  try {
    openBacktestStream(ticker, asOf);
  } catch (error) {
    // Nothing else can report this. The submit handler swallows the exception, so an
    // uncaught throw here left the button disabled under a 1% bar that never moved.
    showBacktestError("Could not start the historical analysis",
      `The request could not be opened in this browser (${error && error.message ? error.message : error}). Reload the page and try again.`);
    finishBacktest("Could not start the historical analysis", true);
  }
}

/*
 * Reading MySquall across the script boundary, without letting app.js's health decide
 * whether /ilgar runs at all.
 *
 * app.js and this file are separate <script> elements, so a throw at app.js's top level
 * does not stop this one — it leaves app.js HALF-EXECUTED. Its function DECLARATIONS are
 * hoisted and initialised before the first statement runs, so they all remain callable,
 * while every `let`/`const` below the throw stays permanently in its temporal dead zone.
 * `typeof getMySquallProfile === "function"` is therefore TRUE, and calling it throws
 * "Cannot access 'mySquallProfile' before initialization" — which is exactly how a fault
 * somewhere else in app.js surfaced here as /ilgar refusing to start. The typeof guard
 * was checking the wrong thing: the CALL is what needs guarding, not the binding.
 *
 * MySquall is personalization, so losing it must not cost the run — but it is reported
 * rather than dropped silently, because a backtest sized by default risk when the user set
 * their own is a different answer, not a cosmetic difference.
 */
function readMySquallForBacktest() {
  if (typeof getMySquallProfile !== "function") return { profile:null, error:null };
  try { return { profile:getMySquallProfile(), error:null }; }
  catch (error) { return { profile:null, error:(error && error.message) || String(error) }; }
}

function openBacktestStream(ticker, asOf) {
  let url = `/backtest-stream?ticker=${encodeURIComponent(ticker)}&as_of=${encodeURIComponent(asOf)}`;
  url += `&horizon=${encodeURIComponent(document.getElementById("replayHorizon")?.value || "3m")}`;
  replayAudit = null;
  // v2 is independent of MySquall, including when its shared UI fails to initialize.
  const source = backtestSource = new EventSource(url);

  // Every event is proof of life, so the timer is re-armed from one place rather than
  // per handler — a listener added later cannot forget to keep the run alive.
  const on = (name, fn) => source.addEventListener(name, event => {
    armBacktestWatchdog(source, BT_SILENCE_MS, "The historical analysis stopped responding",
      "The connection stayed open but sent nothing further. Nothing was charged for the unfinished part — run it again.");
    fn(event);
  });

  armBacktestWatchdog(source, BT_FIRST_EVENT_MS, "No response from the historical analyzer",
    "The connection opened but the server never answered. Check that Squall is reachable, then run it again.");

  on("backtest_progress", event => {
    const data = JSON.parse(event.data); setBacktestProgress(data.percent, data.label);
  });
  on("backtest_snapshot", event => {
    const data = JSON.parse(event.data); renderBacktestSnapshot(data); openBacktestAi(data.model);
  });
  on("backtest_ai_start", event => {
    const data = JSON.parse(event.data); setBacktestProgress(98, "Writing the retrospective research analysis");
    if (!document.getElementById("backtestAiBody")) openBacktestAi(data.model);
  });
  on("backtest_ai_thinking", event => {
    backtestThinking += JSON.parse(event.data).t || ""; scheduleBacktestAiPaint();
  });
  on("backtest_ai_delta", event => {
    backtestAnswer += JSON.parse(event.data).t || ""; scheduleBacktestAiPaint();
  });
  on("backtest_ai_done", event => {
    const data = JSON.parse(event.data);
    if (data.aiSummary) backtestAnswer = data.aiSummary;
    if (data.aiReasoning) backtestThinking = data.aiReasoning;
    paintBacktestAi();
  });
  on("backtest_ai_error", event => {
    const data = JSON.parse(event.data);
    if (!document.getElementById("backtestAiBody")) openBacktestAi("AI unavailable");
    backtestAnswer += `${backtestAnswer ? "\n\n" : ""}> ${data.error}`;
    paintBacktestAi();
  });
  on("backtest_decision", event => {
    renderBacktestDecision(JSON.parse(event.data));
  });
  on("backtest_outcomes", event => {
    renderBacktestOutcomes(JSON.parse(event.data));
  });
  on("backtest_done", () => finishBacktest("Historical analysis complete"));
  on("backtest_error", event => {
    const data = JSON.parse(event.data);
    showBacktestError("Historical analysis unavailable", data.error || "The request could not be completed.");
    finishBacktest(data.error || "Historical analysis unavailable", true);
  });
  source.onerror = () => {
    if (backtestFinished || backtestSource !== source) return;
    showBacktestError("Connection lost", "Confirm that the Squall server is running, then try again.");
    finishBacktest("Connection lost before completion", true);
  };
}

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

/**
 * Gridline values at round numbers INSIDE [lo, hi].
 *
 * The usual nice-scale move is to snap the RANGE outward to a whole step, which
 * would push an equity curve spanning 9.5k–13.2k out to 9k–14k and spend a
 * seventh of the plot height on empty axis. Here the range stays exactly as
 * measured and only the tick POSITIONS are rounded, so the labels read as numbers
 * a person would say out loud without the series losing any vertical room.
 *
 * This replaces an even four-way split of the range, which produced ticks like
 * $9,510 / $10,428 / $11,346 — unreadable, and on the equity curve it left
 * break-even at $10,000 off the axis entirely, which is the one value that chart
 * exists to answer against.
 */
const BT_TICK_STEPS = [1, 2, 2.5, 5];

function btNiceTicks(lo, hi, target = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
  const magnitude = Math.pow(10, Math.floor(Math.log10((hi - lo) / target)));
  let best = null, widest = null;
  // Two decades of candidates, so a span sitting just under a power of ten can
  // still reach the coarser step that its own magnitude does not offer.
  for (const decade of [magnitude, magnitude * 10]) {
    for (const multiple of BT_TICK_STEPS) {
      const step = multiple * decade;
      if (!(step > 0)) continue;
      const ticks = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && ticks.length <= 40; v += step)
        // Re-derived from the step each time rather than accumulated: 0.5 + 0.1
        // is 0.6000000000000001, and that renders as a label.
        ticks.push(Number((Math.round(v / step) * step).toPrecision(12)));
      if (!widest || ticks.length > widest.length) widest = ticks;
      if (ticks.length < 3) continue;
      const score = Math.abs(ticks.length - target);
      if (!best || score < best.score) best = { score, ticks };
    }
  }
  return best ? best.ticks : (widest || []);
}

const BT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Date ticks spread across the window rather than only at its two ends.
 *
 * Labelling just the first and last bar means nothing on the chart can be placed
 * in time — a stop-out four fifths of the way along is simply "somewhere in these
 * six months". app.js's drawChart already lays down five date ticks; this brings
 * the /ilgar renderer to the same idiom.
 */
function btDateTicks(dates, target = 5) {
  const n = Array.isArray(dates) ? dates.length : 0;
  if (n < 2) return [];
  const wanted = Math.min(target, n);
  const indices = [];
  for (let g = 0; g < wanted; g++) {
    const i = Math.round((g / (wanted - 1)) * (n - 1));
    if (indices[indices.length - 1] !== i) indices.push(i);
  }
  /*
   * Three formats, coarsest first; the first one that labels every tick
   * distinctly wins.
   *
   * Month-and-year repeats once the window is short enough that two ticks land in
   * the same month, and month-and-day repeats once it is long enough to cross a
   * year. Two identical labels on an axis locate nothing, so the full date is kept
   * as the format that cannot collide.
   */
  const FORMATS = [
    parts => `${BT_MONTHS[Number(parts[2]) - 1] || parts[2]} ’${parts[1].slice(2)}`,
    parts => `${BT_MONTHS[Number(parts[2]) - 1] || parts[2]} ${Number(parts[3])}`,
    parts => parts[0]
  ];
  for (const format of FORMATS) {
    const ticks = indices.map(i => {
      const parts = String(dates[i] || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return { index:i, label:parts ? format(parts) : String(dates[i] || "") };
    });
    if (new Set(ticks.map(t => t.label)).size === ticks.length) return ticks;
  }
  return indices.map(i => ({ index:i, label:String(dates[i] || "") }));
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

  const padL = 58, padR = marks.yRight ? 54 : 14, padT = 14, padB = 26;
  const X = i => padL + (i / (n - 1)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const rule = btVar("--rule", "#262c33");
  const inkDim = btVar("--ink-dim", "#8b959e");
  const fmt = marks.yFormat || (v => Math.round(v).toLocaleString());

  // Matches the page's own type. ui-monospace resolves to a different family than
  // the IBM Plex Mono everything around the canvas is set in, and the mismatch is
  // visible in the axis labels.
  ctx.font = "10px 'IBM Plex Mono', ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (const v of btNiceTicks(lo, hi)) {
    const y = Y(v);
    ctx.strokeStyle = rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
    ctx.fillStyle = inkDim; ctx.textAlign = "right";
    ctx.fillText(fmt(v), padL - 8, y);
    if (marks.yRight) {
      ctx.textAlign = "left";
      ctx.fillText(marks.yRight(v), W - padR + 8, y);
    }
  }

  /*
   * The reference line, drawn after the grid and brighter than it.
   *
   * On the equity curve every series starts at exactly the same value, so "above
   * or below this line" is the whole question. A gridline of equal weight would
   * hide the answer among four others.
   */
  if (marks.baseline && Number.isFinite(marks.baseline.value)
      && marks.baseline.value > lo && marks.baseline.value < hi) {
    const y = Y(marks.baseline.value);
    ctx.strokeStyle = btVar("--ink-dim", "#8b959e"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
    if (marks.baseline.label) {
      ctx.fillStyle = inkDim; ctx.textAlign = "left";
      ctx.fillText(marks.baseline.label, padL + 6, y - 8);
    }
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
    // Name the exit on the chart. Colour alone cannot carry it: a target hit and a
    // stop-out are both "the trade ended here", and only the label says which.
    if (dot.title) {
      ctx.fillStyle = dot.color;
      const right = X(dot.index) > W - padR - 60;
      ctx.textAlign = right ? "right" : "left";
      // Cleared far enough above the marker that the label does not sit on the
      // line it annotates — the cash tail runs flat out of this dot, so a tighter
      // offset put the text directly on top of a stroke.
      ctx.fillText(dot.title, X(dot.index) + (right ? -7 : 7), Y(v) - 14);
    }
  }

  ctx.fillStyle = inkDim; ctx.textBaseline = "middle";
  // How many date labels fit, rather than a fixed five: on a 340px canvas five
  // "Mmm ’23" labels overlap into a smear, measured at three colliding pairs.
  // Half a label again between neighbours is what keeps them legibly apart.
  const labelW = ctx.measureText("Mmm ’00").width || 42;
  const dateTicks = btDateTicks(labels,
    Math.max(2, Math.min(5, Math.floor((W - padL - padR) / (labelW * 1.7)))));
  dateTicks.forEach((tick, i) => {
    // The end labels are anchored inward so neither runs off the plot; the ones
    // between are centred on their own bar.
    ctx.textAlign = i === 0 ? "left" : i === dateTicks.length - 1 ? "right" : "center";
    ctx.fillText(tick.label, X(tick.index), H - padB + 12);
  });
}

/**
 * Legend swatches that reproduce each series' dash pattern.
 *
 * A solid colour block would be a lie here: the lines are told apart by weight and
 * dash, not hue, so three solid swatches in near-identical greys give the reader
 * nothing to match against the chart. The gradient reproduces the on/off run
 * lengths the canvas actually strokes.
 */
function btLegend(series) {
  return series.map(s => {
    const swatch = s.dash
      ? `background:repeating-linear-gradient(to right, ${s.color} 0 ${s.dash[0] * 2}px, transparent ${s.dash[0] * 2}px ${(s.dash[0] + s.dash[1]) * 2}px);height:${Math.max(2, Math.round(s.width))}px`
      : `background:${s.color};height:${Math.max(2, Math.round(s.width))}px`;
    return `<span><i style="${swatch}"></i>${btEsc(s.label)}</span>`;
  }).join("");
}

/**
 * Splits a trade line into the live position and the cash held after the exit.
 *
 * simulateTrade holds the trade flat to the end of the window by design, so every
 * run shares one x-axis. Stroked as a single line that made the boldest, widest
 * mark on the chart a position that no longer existed — a stop-out on day 8 of a
 * 126-session window drew 118 sessions of accent-coloured nothing.
 *
 * Both halves keep the exit point, so the two strokes meet rather than leaving a
 * gap. Returns null when there is no tail worth separating.
 */
function btSplitAtExit(points, exitIndex) {
  if (!Array.isArray(points)) return null;
  if (!Number.isInteger(exitIndex) || exitIndex <= 0 || exitIndex >= points.length - 1) return null;
  return {
    live: points.map((v, i) => (i <= exitIndex ? v : null)),
    cash: points.map((v, i) => (i >= exitIndex ? v : null))
  };
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

/**
 * Simple moving average over a series that may contain nulls.
 *
 * The running sum is kept over the last n NON-NULL values rather than the last n
 * slots, so a gap in the source shortens the window instead of poisoning the sum
 * with a subtracted null. price_history_rows drops bars with no close, so gaps are
 * rare — but a silently wrong MA is indistinguishable from a right one on a chart.
 */
function btMovingAvg(values, n) {
  const out = new Array(values.length).fill(null);
  const window = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = btNum(values[i]);
    if (v === null) continue;
    window.push(v); sum += v;
    if (window.length > n) sum -= window.shift();
    if (window.length === n) out[i] = sum / n;
  }
  return out;
}

/*
 * The pre-cutoff price chart. It lands with the snapshot, so the page shows the
 * setup the model is reading while the model is still writing about it.
 *
 * Same rule as the equity curve: the three lines are told apart by weight and dash,
 * not hue. --ink against --ink-dim measures as little as 1.11:1, and the design
 * system reserves the single accent, so hue is not an available lever here either.
 * A moving average is only added once enough bars exist to compute one — a legend
 * entry for a line that is entirely null is a label pointing at nothing.
 */
function renderBacktestSetupChart(snapshot) {
  const host = document.getElementById("backtestSetup");
  const bars = snapshot.price_history;
  if (!host || !Array.isArray(bars) || bars.length < 30) return;
  const closes = bars.map(b => btNum(b.c));
  const series = [
    { key:"close", label:"Close", color:btVar("--ink-bright", "#d7dee5"), points:closes, width:1.8 }
  ];
  if (bars.length >= 50) series.push({ key:"ma50", label:"MA50", color:btVar("--ink", "#b9c2ca"),
    points:btMovingAvg(closes, 50), width:1.4, dash:[5, 4] });
  if (bars.length >= 200) series.push({ key:"ma200", label:"MA200", color:btVar("--ink-dim", "#8b959e"),
    points:btMovingAvg(closes, 200), width:1.2, dash:[1, 3] });

  host.innerHTML = `
    <h3>What it looked like then</h3>
    <div class="backtest-chart-wrap"><canvas id="backtestSetupCanvas"></canvas></div>
    <div class="backtest-legend">${btLegend(series)}</div>
    <p class="backtest-curve-note">${bars.length} sessions up to ${btEsc(bars[bars.length - 1].d)}. Split-adjusted closes on the current share basis, so a later split has already been applied and these levels may never have traded.</p>`;

  btObserve(document.getElementById("backtestSetupCanvas"));
  btRegisterChart("setup", () => drawLineChart(
    document.getElementById("backtestSetupCanvas"), series, {
      labels: bars.map(b => b.d),
      yFormat: v => `$${v < 20 ? v.toFixed(2) : Math.round(v).toLocaleString()}`
    }));
}

const BT_DIRECTION_COPY = {
  long: "Long", short: "Short", flat: "No position"
};

let replayAudit = null;
function downloadReplayAudit() {
  if (!replayAudit) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(replayAudit, null, 2)], {type:"application/json"}));
  const link = document.createElement("a");
  link.href = url; link.download = `squall-${replayAudit.run_id}.json`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderBacktestDecision(data) {
  const host = document.getElementById("backtestDecision");
  if (!host) return;
  const d = data.decision;
  if (data.policy?.version === "replay-v2") {
    const p = data.policy;
    host.innerHTML = `<div class="backtest-section-head"><h2>${d ? btEsc(BT_DIRECTION_COPY[d.direction]) : "Decision unavailable"}</h2><b>${btEsc(p.version)}</b></div>
      <section class="backtest-panel"><p>${d ? btEsc(d.thesis) : "The response did not contain one valid structured decision. No replacement trade was invented; this is not an abstention."}</p>
      <p>${d?.direction === "flat" ? "The model explicitly chose no position. Cash remains flat." : `Policy: ${btMagnitudePct(p.position_pct)} initial exposure, ${p.sessions} held sessions, ${btMagnitudePct(p.stop_pct)} adverse / ${btMagnitudePct(p.target_pct)} favorable close triggers next-open exit.`}</p>
      <p class="backtest-curve-note">${btEsc(p.execution)} Costs ${p.cost_bps} bps each way; assumed short borrow ${btMagnitudePct(p.borrow_apr)} annually. No profile or conviction adjustment. See policy limitations above.</p></section>`;
    return;
  }
  if (!d) {
    host.innerHTML = `
      <div class="backtest-section-head"><div><span>The call</span><h2>No decision recorded</h2></div></div>
      <div class="backtest-integrity">The model did not return a usable trade, so only the stock and SPY are charted below.</div>`;
    return;
  }
  const positionPct = btNum(d.position_pct);
  const positionLabel = positionPct == null ? "—" : btMagnitudePct(positionPct);
  const instrumentLabel = d.options_proxy ? "Underlying stock proxy" : "Stock";
  const sourceLabel = d.decision_source === "rules_fallback" ? "Rules fallback" : "Blind AI call";
  const side = d.direction === "short" ? "short" : "long";
  const stopMove = d.direction === "short" ? "rises" : "falls";
  const targetMove = d.direction === "short" ? "falls" : "rises";
  const executionPlan = [
    `Enter a ${positionLabel} ${side} ${d.options_proxy ? "position in the underlying stock proxy" : "stock position"} at the next session's open.`,
    d.stop_pct == null ? "" : `If a daily close ${stopMove} ${btMagnitudePct(d.stop_pct)} from entry, exit at the following session's open.`,
    d.target_pct == null ? ""
      : d.exit_mode === "runner"
        ? `If a daily close ${targetMove} ${btMagnitudePct(d.target_pct)} from entry, start trailing the stop ${btMagnitudePct(d.stop_pct)} behind the best close instead of exiting.`
        : `If a daily close ${targetMove} ${btMagnitudePct(d.target_pct)} from entry, exit at the following session's open.`,
    `Otherwise, exit when the ${btEsc(d.horizon)} maximum holding period ends.`
  ].filter(Boolean).join(" ");
  // Conviction now moves the position, so the two stats have to be readable together —
  // "3/5" beside "35%" says nothing about why that size, and a 5 that quietly sized up
  // 1.6x would look like a profile change rather than a judgment.
  const sizeBits = [];
  if (btNum(d.conviction_scale) != null && d.conviction_scale !== 1)
    sizeBits.push(`${d.conviction_scale}× conviction`);
  // Named rather than folded silently into the number: halving for an earnings window is
  // a risk decision the reader should be able to disagree with.
  if (d.event_imminent) sizeBits.push("½ for imminent earnings");
  const sizeNote = sizeBits.length
    ? ` <small>${btEsc(sizeBits.join(" · "))} on base ${btMagnitudePct(d.position_pct_base)}</small>` : "";
  const bits = [
    `<div class="backtest-stat"><span>Direction</span><b>${btEsc(BT_DIRECTION_COPY[d.direction] || d.direction)}</b></div>`,
    `<div class="backtest-stat"><span>Conviction</span><b>${btEsc(d.conviction)}/5</b></div>`,
    `<div class="backtest-stat"><span>Position size</span><b>${positionLabel}${sizeNote}</b></div>`,
    `<div class="backtest-stat"><span>Instrument</span><b>${btEsc(instrumentLabel)}</b></div>`,
    `<div class="backtest-stat"><span>Horizon</span><b>${btEsc(d.horizon)}${d.horizon_capped ? ` <small>asked ${btEsc(d.horizon_requested)}, capped by profile</small>` : ""}</b></div>`,
    `<div class="backtest-stat"><span>Stop</span><b>${d.stop_pct == null ? "—" : btPct(-d.stop_pct)}</b></div>`,
    `<div class="backtest-stat"><span>${d.exit_mode === "runner" ? "Trail arms at" : "Target"}</span><b>${d.target_pct == null ? "—" : btPct(d.target_pct)}</b></div>`
  ].join("");
  host.innerHTML = `
    <div class="backtest-section-head"><div><span>The call</span><h2>What Squall committed to</h2></div><b>Blind</b></div>
    <section class="backtest-panel">
      <div class="backtest-stats">${bits}</div>
      ${d.thesis ? `<p class="backtest-thesis">${btEsc(d.thesis)}</p>` : ""}
      <p class="backtest-thesis"><b>Execution plan:</b> ${executionPlan}</p>
      <p class="backtest-curve-note">${btEsc(sourceLabel)} · MySquall calibration: ${btEsc(d.profile_basis || "balanced defaults")}.${d.options_proxy ? " Historical options-chain data is unavailable, so this tests the underlying stock rather than inventing an options contract." : ""}</p>
    </section>`;
}

/*
 * The scoreboard under the chart. simulateTrade computes these five figures and,
 * until now, nothing read them — the curve showed whether the call was profitable
 * but never said so in a number, which is the first thing anyone actually asks.
 *
 * Four cells rather than five: max drawdown is a qualifier on the trade, not a
 * competitor to it, so it belongs in the caption with the exit. Only the trade's
 * own return is tinted by direction — --up/--down mean direction and nothing else,
 * and tinting all four would turn a comparison into a wall of colour.
 */
function btCurveStats(simulation, hasTrade, exitLook) {
  const stats = (simulation && simulation.stats) || {};
  if (simulation?.policy?.version === "replay-v2") {
    const p = simulation.policy;
    return `<div class="backtest-stats">${[
      ["Net strategy return",stats.trade_return], ["Stock at matched exposure",stats.stock_return],
      ["SPY at matched exposure",stats.spy_return], ["Difference vs SPY (not alpha)",stats.excess_vs_spy],
      ["Marked strategy return",stats.marked_return], ["Costs / initial account",stats.costs_return],
      ["Daily marked drawdown",stats.max_dd]
    ].map(([label,value]) => btStat(label,btPct(value))).join("")}</div>
    <p class="backtest-curve-note">${btEsc(simulation.status)} · ${btEsc(simulation.reason || "Selected observation window completed.")} ${simulation.exit ? `Exit: ${btEsc(simulation.exit.reason)} at next open ${btUsd(simulation.exit.price)} on ${btEsc(simulation.exit.date)}.` : "No executed exit recorded."} ${simulation.pending_exit ? "An exit signal is awaiting an available next open." : ""}</p>
    <p class="backtest-curve-note">${btEsc(p.price_basis)}. ${btMagnitudePct(p.position_pct)} initial exposure for both benchmarks; cash earns zero. ${simulation.decision_status === "unavailable" ? "No valid AI decision; only benchmarks are evaluated." : ""}</p>`;
  }
  if (!hasTrade) {
    // A flat call is a real answer, not a missing one. Say what it cost or saved
    // rather than rendering an empty trade row.
    return `<p class="backtest-curve-note">Squall took no position, so there is no trade to score. Holding the stock instead would have returned <b>${btPct(stats.stock_return)}</b> against SPY's <b>${btPct(stats.spy_return)}</b>.</p>`;
  }
  const traded = btNum(stats.trade_return);
  const cells = [
    ["Squall's trade", btPct(stats.trade_return), traded === null ? "" : traded >= 0 ? " positive" : " negative"],
    ["Stock, buy & hold", btPct(stats.stock_return), ""],
    ["SPY", btPct(stats.spy_return), ""],
    ["Excess vs SPY", btPct(stats.excess_vs_spy), ""]
  ].map(([label, value, cls]) =>
    `<div class="backtest-stat${cls}"><span>${btEsc(label)}</span><b>${btEsc(value)}</b></div>`).join("");

  const exit = simulation.exit && exitLook
    ? `Exited ${btEsc(simulation.exit.date)} at ${btUsd(simulation.exit.price)} — ${btEsc(exitLook.label)}.`
    : "The trade was still open when the window ended.";
  const dd = btNum(stats.max_dd) === null ? "" : ` Worst drawdown while in the trade: <b>${btPct(stats.max_dd)}</b>.`;
  return `<div class="backtest-stats backtest-curve-stats">${cells}</div>
    <p class="backtest-curve-note">${exit}${dd}</p>`;
}

function renderBacktestCurve(simulation) {
  const host = document.getElementById("backtestCurve");
  if (!host) return;
  // A cutoff within a session or two of today leaves nothing to plot. Say so — an
  // empty panel where a chart belongs reads as a bug rather than as "no data yet".
  if (!simulation || !simulation.curve || simulation.curve.length < 2) {
    host.innerHTML = `<p class="backtest-empty">${btEsc(simulation?.reason || "Too few sessions are available to chart an outcome.")}</p>`;
    return;
  }
  const curve = simulation.curve;
  const hasTrade = curve.some(p => Number.isFinite(p.trade));
  // The level every line is indexed to, and therefore where break-even sits. Note
  // it is NOT curve[0]: entry fills at the first post-cutoff OPEN while the curve
  // is stamped from each session's CLOSE, so the first point already carries a
  // day's move. Reading the base off curve[0] would tilt the reference line by it.
  const base = btNum(simulation.base) ?? 10000;
  // Weight and dash carry the distinction, not hue. Measured across all six themes,
  // --ink against --ink-dim is only 1.11:1 (Daylight) to 1.45:1 (Noir), and --accent
  // against --ink bottoms out at 1.25:1 — so on colour alone these three lines are one
  // line. The design system also reserves the single accent and forbids inventing a
  // second hue, which leaves weight and dash as the honest levers.
  const series = [
    { key:"spy", label:simulation.policy ? "SPY, matched exposure" : "SPY", color:btVar("--ink-dim", "#7d8892"),
      points:curve.map(p => p.spy), width:1.2, dash:[1, 3] },
    { key:"stock", label:simulation.policy ? "Stock, matched exposure" : "Stock, buy & hold", color:btVar("--ink", "#b9c2ca"),
      points:curve.map(p => p.stock), width:1.5, dash:[5, 4] }
  ];
  // The exit reason decides the colour. Painting a target hit in loss-red because
  // "the trade ended" reads as a stop-out and inverts the result at a glance.
  const EXIT_LOOK = {
    stop:    { token:"--down",    fallback:"#c25b5b", label:"stopped out" },
    target:  { token:"--up",      fallback:"#4c9a72", label:"target hit" },
    // Arming requires the target to have been reached, so a trailing exit is always a
    // trade that ran into profit first — it reads as --up for the same reason target does.
    // Without this row an unknown reason falls through to `end`, and a completed trade
    // renders as "window ended": a success reported as a truncation, with nothing thrown.
    trail:   { token:"--up",      fallback:"#4c9a72", label:"trailing stop" },
    horizon: { token:"--ink-dim", fallback:"#8b959e", label:"horizon reached" },
    end:     { token:"--ink-dim", fallback:"#8b959e", label:"window ended" }
  };
  const exitLook = simulation.exit ? (EXIT_LOOK[simulation.exit.reason] || EXIT_LOOK.end) : null;
  const exitIndex = hasTrade && simulation.exit
    ? curve.findIndex(p => p.d === simulation.exit.date) : -1;

  if (hasTrade) {
    const tradePoints = curve.map(p => p.trade);
    const split = btSplitAtExit(tradePoints, exitIndex);
    series.push({ key:"trade", label:split ? "Squall's trade, in position" : "Squall's trade",
      color:btVar("--accent", "#e0a33a"), points:split ? split.live : tradePoints, width:2.2 });
    // Held flat in cash: same colour, so it still reads as the same account, but
    // thin and dashed so it stops competing with the live position for attention.
    if (split) series.push({ key:"cash", label:"Closed, held in cash",
      color:btVar("--accent", "#e0a33a"), points:split.cash, width:1, dash:[2, 4] });
  }

  const dots = [];
  if (exitIndex >= 0) dots.push({ index:exitIndex, series:"trade",
    color:btVar(exitLook.token, exitLook.fallback), title:exitLook.label });

  host.innerHTML = `
    <h3>The call against the stock and the market</h3>
    <div class="backtest-chart-wrap"><canvas id="backtestCurveCanvas"></canvas></div>
    <div class="backtest-legend">${btLegend(series)}</div>
    ${btCurveStats(simulation, hasTrade, exitLook)}`;

  btObserve(document.getElementById("backtestCurveCanvas"));
  btRegisterChart("curve", () => drawLineChart(
    document.getElementById("backtestCurveCanvas"), series, {
      labels: curve.map(p => p.d),
      dots,
      // Every line starts at $10,000, so the dollar axis is really a percentage
      // one. Both are labelled: the left says what the account is worth, the right
      // says what the stats row below says, which is how the two get connected.
      baseline: { value: base, label:"break-even" },
      yFormat: v => `$${Math.round(v).toLocaleString()}`,
      yRight: v => {
        const pct = (v / base - 1) * 100;
        return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
      }
    }));
}

const backtestDate = document.getElementById("backtestDate");
if (backtestDate) {
  backtestDate.max = btDateDaysAgo(1);
  backtestDate.value = btDateDaysAgo(365);
}
document.getElementById("backtestForm")?.addEventListener("submit", event => { event.preventDefault(); runBacktest(); });
document.getElementById("backtestTicker")?.focus();
