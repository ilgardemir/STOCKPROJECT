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
    <section class="backtest-panel" id="backtestCurve"></section>
    <div class="backtest-outcome-entry">Next-session entry: <b>${outcome.entry_date ? `${btUsd(outcome.entry_price)} on ${btEsc(outcome.entry_date)}` : "Unavailable"}</b> · split-adjusted</div>
    <div class="backtest-outcomes">${cards}</div>
    <div class="backtest-integrity">Maximum six-month drawdown after entry: <b>${btPct(outcome.max_drawdown_6m)}</b>. These realized returns evaluate the historical analysis; they did not affect it.</div>`;
  renderBacktestCurve(payload.simulation);
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
  document.getElementById("backtestDecision").innerHTML = "";
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
  source.addEventListener("backtest_decision", event => {
    renderBacktestDecision(JSON.parse(event.data));
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

const backtestDate = document.getElementById("backtestDate");
if (backtestDate) {
  backtestDate.max = btDateDaysAgo(1);
  backtestDate.value = btDateDaysAgo(365);
}
document.getElementById("backtestForm")?.addEventListener("submit", event => { event.preventDefault(); runBacktest(); });
document.getElementById("backtestTicker")?.focus();
