"use strict";

let backtestSource = null;
let backtestFinished = false;
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
function btNum(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function btPct(value, digits = 1) {
  const number = btNum(value);
  return number === null ? "—" : `${number > 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
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

  const filings = (snapshot.filings_known_by_cutoff || []).slice(0, 8).map(filing =>
    `<div class="backtest-filing"><b>${btEsc(filing.form)}</b><span>Filed ${btEsc(filing.filed)}${filing.report_date ? ` · report date ${btEsc(filing.report_date)}` : ""}</span></div>`
  ).join("") || `<p class="backtest-empty">No SEC filing list was available by the cutoff.</p>`;

  document.getElementById("backtestSnapshot").innerHTML = `
    <div class="backtest-section-head"><div><span>Frozen snapshot</span><h2>${btEsc(snapshot.company_name || snapshot.ticker)} <small>${btEsc(snapshot.ticker)}</small></h2></div><b>As of ${btEsc(snapshot.effective_market_date || snapshot.as_of)}</b></div>
    <div class="backtest-integrity" id="backtestIntegrityState">Everything in this section existed by the cutoff. The AI is now analyzing this snapshot while the future outcome remains sealed.</div>
    <section class="backtest-panel"><h3>Price and technical condition</h3><div class="backtest-stats">${metricCards}</div><div class="backtest-scores">${scoreCards}</div></section>
    <section class="backtest-panel"><h3>SEC facts known by the cutoff</h3><div class="backtest-facts">${factCards}</div></section>
    <section class="backtest-panel"><h3>Recent filings known by the cutoff</h3><div class="backtest-filings">${filings}</div></section>`;
}

function paintBacktestAi() {
  backtestPaint = null;
  const body = document.getElementById("backtestAiBody");
  if (!body) return;
  const html = typeof renderMarkdown === "function" ? renderMarkdown(backtestAnswer) : `<p>${btEsc(backtestAnswer)}</p>`;
  body.innerHTML = html || `<div class="backtest-ai-wait"><span></span><span></span><span></span></div>`;
  const thinking = document.getElementById("backtestThinkingText");
  if (thinking) thinking.textContent = backtestThinking;
}
function scheduleBacktestAiPaint() {
  if (!backtestPaint) backtestPaint = requestAnimationFrame(paintBacktestAi);
}
function openBacktestAi(model) {
  document.getElementById("backtestAi").innerHTML = `
    <div class="backtest-section-head"><div><span>Blind historical read</span><h2>What Squall would have seen then</h2></div><b>${btEsc(model || "AI")}</b></div>
    <section class="backtest-panel backtest-ai-panel"><details><summary>Model reasoning</summary><pre id="backtestThinkingText"></pre></details><div id="backtestAiBody" class="prose"><div class="backtest-ai-wait"><span></span><span></span><span></span></div></div></section>`;
}

function renderBacktestOutcomes(payload) {
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
    <div class="backtest-section-head"><div><span>Outcome reveal</span><h2>What happened afterward</h2></div><b>Not shown to the AI</b></div>
    <div class="backtest-outcome-entry">Next-session entry: <b>${outcome.entry_date ? `${btUsd(outcome.entry_price)} on ${btEsc(outcome.entry_date)}` : "Unavailable"}</b> · split-adjusted</div>
    <div class="backtest-outcomes">${cards}</div>
    <div class="backtest-integrity">Maximum six-month drawdown after entry: <b>${btPct(outcome.max_drawdown_6m)}</b>. These realized returns evaluate the historical analysis; they did not affect it.</div>`;
  const integrity = document.getElementById("backtestIntegrityState");
  if (integrity) integrity.textContent = "Everything in this section existed by the cutoff. The AI analysis finished before Squall released the outcome data below.";
}

function finishBacktest(label, error = false) {
  backtestFinished = true;
  const button = document.getElementById("backtestRun");
  button.disabled = false;
  button.textContent = "Run historical analysis";
  setBacktestProgress(error ? 0 : 100, label, error);
  if (backtestSource) { backtestSource.close(); backtestSource = null; }
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
  document.getElementById("backtestAi").innerHTML = "";
  document.getElementById("backtestOutcomes").innerHTML = "";
  const button = document.getElementById("backtestRun");
  button.disabled = true; button.textContent = "Running…";
  setBacktestProgress(1, "Starting the historical analysis");
  let url = `/backtest-stream?ticker=${encodeURIComponent(ticker)}&as_of=${encodeURIComponent(asOf)}`;
  const profile = typeof getMySquallProfile === "function" ? getMySquallProfile() : null;
  if (profile) url += `&profile=${encodeURIComponent(JSON.stringify(profile))}`;
  const source = backtestSource = new EventSource(url);
  source.addEventListener("backtest_progress", event => {
    const data = JSON.parse(event.data); setBacktestProgress(data.percent, data.label);
  });
  source.addEventListener("backtest_snapshot", event => {
    const data = JSON.parse(event.data); renderBacktestSnapshot(data); openBacktestAi(data.model);
  });
  source.addEventListener("backtest_ai_start", event => {
    const data = JSON.parse(event.data); setBacktestProgress(98, "Writing the blind historical analysis");
    if (!document.getElementById("backtestAiBody")) openBacktestAi(data.model);
  });
  source.addEventListener("backtest_ai_thinking", event => {
    backtestThinking += JSON.parse(event.data).t || ""; scheduleBacktestAiPaint();
  });
  source.addEventListener("backtest_ai_delta", event => {
    backtestAnswer += JSON.parse(event.data).t || ""; scheduleBacktestAiPaint();
  });
  source.addEventListener("backtest_ai_done", event => {
    const data = JSON.parse(event.data);
    if (data.aiSummary) backtestAnswer = data.aiSummary;
    if (data.aiReasoning) backtestThinking = data.aiReasoning;
    paintBacktestAi();
  });
  source.addEventListener("backtest_ai_error", event => {
    const data = JSON.parse(event.data);
    if (!document.getElementById("backtestAiBody")) openBacktestAi("AI unavailable");
    backtestAnswer += `${backtestAnswer ? "\n\n" : ""}> ${data.error}`;
    paintBacktestAi();
  });
  source.addEventListener("backtest_outcomes", event => {
    renderBacktestOutcomes(JSON.parse(event.data));
  });
  source.addEventListener("backtest_done", () => finishBacktest("Historical analysis complete"));
  source.addEventListener("backtest_error", event => {
    const data = JSON.parse(event.data);
    document.getElementById("backtestError").innerHTML = `<div class="backtest-error"><b>Historical analysis unavailable</b><span>${btEsc(data.error || "The request could not be completed.")}</span></div>`;
    finishBacktest(data.error || "Historical analysis unavailable", true);
  });
  source.onerror = () => {
    if (backtestFinished || backtestSource !== source) return;
    document.getElementById("backtestError").innerHTML = `<div class="backtest-error"><b>Connection lost</b><span>Confirm that the Squall server is running, then try again.</span></div>`;
    finishBacktest("Connection lost before completion", true);
  };
}

const backtestDate = document.getElementById("backtestDate");
if (backtestDate) {
  backtestDate.max = btDateDaysAgo(1);
  backtestDate.value = btDateDaysAgo(365);
}
document.getElementById("backtestForm")?.addEventListener("submit", event => { event.preventDefault(); runBacktest(); });
document.getElementById("backtestTicker")?.focus();
