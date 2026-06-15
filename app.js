"use strict";

/* ════════════════ STATE: per-ticker sessions (declared first — theme init reads `active`) ════════════════ */
const sessions = {};   // { TICKER: { data, context, history, range } }
let active = null;     // active ticker for the chat/AI/data panes
const chartOpts = { ma20: false, ma50: true, ma200: true, bb: false, fib: false, sr: true, pct: false, vol: true, instWindow: false };

/* ════════════════ THEME ════════════════ */
const SUN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.getElementById("themeBtn").innerHTML = t === "dark" ? SUN : MOON;
  try { localStorage.setItem("squall-theme", t); } catch (e) {}
  if (active && sessions[active]) drawChart();
}
(function () { let t; try { t = localStorage.getItem("squall-theme"); } catch (e) {}
  if (!t) t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; applyTheme(t); })();
document.getElementById("themeBtn").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

/* ════════════════ FORMATTERS ════════════════ */
const isNum = v => v !== null && v !== undefined && typeof v === "number" && isFinite(v);
const fPct = (v, dp = 2) => isNum(v) ? (v * 100).toFixed(dp) + "%" : "N/A";
const fRatio = (v, dp = 2) => isNum(v) ? v.toFixed(dp) : "N/A";
function fUsd(v) { if (!isNum(v)) return "N/A"; const a = Math.abs(v);
  if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T"; if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const fInt = v => isNum(v) ? Math.round(v).toLocaleString("en-US") : "N/A";
const signCls = (v, inv = false) => (!isNum(v) || v === 0) ? "" : ((inv ? v < 0 : v > 0) ? "green" : "red");
const esc = t => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ════════════════ PROGRESS ════════════════ */
function showProgress(stage, total, label, isErr = false) {
  document.getElementById("progressWrap").classList.add("show");
  const pct = Math.round((stage / total) * 100);
  const fill = document.getElementById("progressFill");
  fill.style.width = pct + "%"; fill.classList.toggle("error", isErr);
  document.getElementById("progressStage").textContent = label;
  document.getElementById("progressMeta").classList.toggle("error", isErr);
  document.getElementById("progressPct").textContent = isErr ? "—" : pct + "%";
}
function hideProgress(delay = 600) { setTimeout(() => {
  document.getElementById("progressWrap").classList.remove("show");
  document.getElementById("progressFill").style.width = "0%"; }, delay); }

/* ════════════════ ANALYSIS (SSE streaming) ════════════════ */
function quick(t) { document.getElementById("ticker").value = t; runAnalysis(); }
let _es = null;

function runAnalysis() {
  const ticker = document.getElementById("ticker").value.trim().toUpperCase();
  const btn = document.getElementById("analyzeBtn");
  if (!ticker) { showProgress(0, 7, "Enter a ticker symbol first", true); hideProgress(2200); return; }
  if (_es) { _es.close(); _es = null; }

  btn.disabled = true;
  document.getElementById("hero").style.display = "none";
  document.getElementById("workspace").classList.add("show");
  showProgress(0, 7, "Starting data pipeline for " + ticker);

  document.getElementById("dataBody").innerHTML =
    `<div class="placeholder"><div class="spinner"></div><span>Collecting filings, prices and quotes for ${esc(ticker)}…</span></div>`;
  const ai = document.getElementById("aiSummary");
  ai.className = "prose thinking"; ai.innerHTML = `<div class="spinner"></div> Waiting for the data run to finish…`;

  const es = new EventSource("/analyze-stream?ticker=" + encodeURIComponent(ticker));
  _es = es;

  es.addEventListener("progress", e => { const d = JSON.parse(e.data); showProgress(d.stage, d.total || 7, d.label); });

  es.addEventListener("error", e => {
    let msg = "Connection lost. Is the server running? (node server.js)";
    try { if (e.data) msg = JSON.parse(e.data).error || msg; } catch (x) {}
    showProgress(0, 7, "Error: " + msg, true);
    document.getElementById("dataBody").innerHTML = `<div class="placeholder"><span style="color:var(--red);font-family:var(--mono);font-size:12px">${esc(msg)}</span></div>`;
    ai.className = "prose"; ai.innerHTML = `<div class="placeholder"><span>Analysis unavailable — fix the error above and run again.</span></div>`;
    btn.disabled = false; es.close(); _es = null; hideProgress(3000);
  });

  es.addEventListener("result", e => {
    const data = JSON.parse(e.data);
    showProgress(7, 7, "Complete — " + (data.company_name || ticker));
    sessions[data.ticker] = { data, context: data.ai_prompt || data.aiSummary || "", history: [], range: 252 };
    active = data.ticker;
    renderTickerPills();
    renderAll(data);
    btn.disabled = false; es.close(); _es = null; hideProgress(900);
  });
}

/* ════════════════ RENDER HELPERS ════════════════ */
let _cardN = 0;
function card(id, icon, title, bodyHtml, { open = true, count = null } = {}) {
  _cardN++;
  return `<details class="card" id="card-${id}" ${open ? "open" : ""} style="--d:${Math.min(_cardN * 0.05, 0.5)}s">
    <summary>${icon}<span>${title}</span>${count !== null ? `<span class="count">${count}</span>` : ""}
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </summary><div class="card-body">${bodyHtml}</div></details>`;
}
const I = {
  bolt:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 11-12h-7l1-8z"/></svg>',
  chart:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>',
  scale:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 7l7-4 7 4M3 13l2-6 2 6a3 3 0 0 1-4 0zM17 13l2-6 2 6a3 3 0 0 1-4 0z"/></svg>',
  margin:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 9 9h-9z"/></svg>',
  shield:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/></svg>',
  bank:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M4 18h16M6 18V10M10 18V10M14 18V10M18 18V10M2 10l10-7 10 7z"/></svg>',
  gauge:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 14 8 8"/><path d="M3.3 17a10 10 0 1 1 17.4 0"/></svg>',
  pulse:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  eye:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  cal:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  doc:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
  layers:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/></svg>',
  struct:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l4-6 4 3 4-8 6 9"/></svg>',
  whale:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c2 0 3-2 3-2s2 4 6 4 7-3 9-3M3 12c0 4 4 7 9 7 6 0 9-5 9-9 0-1-.3-2-1-3"/></svg>',
  brain:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z"/></svg>'
};
const metric = (label, value, cls = "") => `<div class="metric"><div class="k">${label}</div><div class="v ${cls}">${value}</div></div>`;
function rangeBar(title, lo, hi, val, fmt = fUsd, altVal = null, altName = "") {
  if (!isNum(lo) || !isNum(hi) || !isNum(val) || hi <= lo) return "";
  const pos = Math.min(100, Math.max(0, ((val - lo) / (hi - lo)) * 100));
  let alt = "";
  if (isNum(altVal)) { const ap = Math.min(100, Math.max(0, ((altVal - lo) / (hi - lo)) * 100));
    alt = `<div class="rb-marker alt" style="left:${ap}%" title="${altName}: ${fmt(altVal)}"></div>`; }
  return `<div class="rangebar"><div class="rb-title">${title}</div>
    <div class="rb-labels"><span>${fmt(lo)}</span><b>${fmt(val)}</b><span>${fmt(hi)}</span></div>
    <div class="rb-track"><div class="rb-fill" style="left:0;width:${pos}%"></div>${alt}<div class="rb-marker" style="left:${pos}%"></div></div></div>`;
}
function signalClass(text) { const t = String(text).toUpperCase();
  if (/(BULLISH|FUNDAMENTAL VALUE|BEAT|GOLDEN CROSS|INSIDER BUYING|DOUBLE BOTTOM|UPTREND|AT SUPPORT|BASE FORMATION|ACCUMULATION|OBV RISING|UP-VOLUME)/.test(t)) return "green";
  if (/(RED FLAG|BEARISH|EXTREME|MISSED|DEATH CROSS|NET LOSS|DECLINING|HEAVY INSIDER SELLING|DOUBLE TOP|DOWNTREND|DISTRIBUTION|OBV FALLING|DOWN-VOLUME)/.test(t)) return "red";
  if (/(WARNING|WEAK|FAKE|EXPENSIVE|RECOVERY|STRETCH|SHORT|CYCLE|OVERSOLD|OVERBOUGHT|SQUEEZE|LEVERAGE|ACTIVIST|AT RESISTANCE|VOLUME|NEGATIVE PEG|SIDEWAYS|RANGE|TRANSITION|CHANGE OF CHARACTER|BREAK OF STRUCTURE)/.test(t)) return "amber";
  return "neutral"; }
function signalHtml(s) { const m = String(s).match(/^([^:]+):\s*(.*)$/);
  const inner = m ? `<b>${esc(m[1])}:</b>&nbsp;<span>${esc(m[2])}</span>` : esc(s);
  return `<div class="signal ${signalClass(s)}">${inner}</div>`; }

/* ════════════════ TICKER PILLS (per-ticker sessions) ════════════════ */
function renderTickerPills() {
  const keys = Object.keys(sessions);
  const el = document.getElementById("chatTickers");
  if (keys.length <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = keys.map(t => `<button class="chat-tick ${t === active ? "active" : ""}" onclick="switchTicker('${t}')">${esc(t)}</button>`).join("");
}
function switchTicker(t) {
  if (!sessions[t]) return;
  active = t;
  renderTickerPills();
  renderAll(sessions[t].data);
}

/* ════════════════ RENDER: SUMMARY STRIP ════════════════ */
function renderStrip(d) {
  const q = d.live_quote || {}, t = (d.raw_data || {}).technicals || {};
  const price = q.last_price ?? t.current_price, chg = t.daily_change;
  const strip = document.getElementById("summaryStrip");
  strip.innerHTML = `
    <span id="sCompany">${esc(d.company_name)}</span>
    <span id="sTicker">${esc(d.ticker)}${q.exchange ? " · " + esc(q.exchange) : ""}</span>
    <span id="sPrice">${fUsd(price)}</span>
    ${isNum(chg) ? `<span class="pill ${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲" : "▼"} ${fPct(chg)}</span>` : ""}
    ${(d.price_action && d.price_action.trend) ? `<span class="meta-dot">Structure <b>${esc(d.price_action.trend)}</b></span>` : ""}
    ${q.market_state ? `<span class="meta-dot">Market <b>${esc(q.market_state)}</b></span>` : ""}
    ${q.fetched_at ? `<span class="meta-dot">Fetched <b>${esc(q.fetched_at)}</b></span>` : ""}`;
  strip.classList.add("show");
}

/* ════════════════ RENDER: EVERYTHING ════════════════ */
function renderAll(d) {
  renderStrip(d);
  _cardN = 0;
  const r = d.raw_data || {};
  const v = r.valuation || {}, p = r.profitability || {}, fh = r.financial_health || {}, sec = r.sec_fundamentals || {},
        t = r.technicals || {}, rr = r.risk_return || {}, s = r.sentiment || {}, kl = r.key_levels || {};
  const q = d.live_quote || {}, pa = d.price_action || {}, inst = d.institutional || {};
  let html = "";

  /* Snapshot */
  let snap = `<div class="mgrid">
    ${metric("Last Price", fUsd(q.last_price ?? t.current_price))}
    ${metric("Day Change", fPct(t.daily_change), signCls(t.daily_change))}
    ${metric("Open", fUsd(q.open))}
    ${metric("Prev Close", fUsd(q.previous_close))}
    ${metric("Bid / Ask", (isNum(q.bid) || isNum(q.ask)) ? `${fUsd(q.bid)} <small>/</small> ${fUsd(q.ask)}` : "N/A")}
    ${metric("Volume", fInt(q.last_volume))}
    ${metric("Market Cap", fUsd(q.market_cap))}
    ${metric("Currency", esc(q.currency || "N/A"))}
  </div>`;
  snap += rangeBar("Day range", q.day_low, q.day_high, q.last_price ?? t.current_price);
  snap += rangeBar("52-week range", t.low_52w ?? q.year_low, t.high_52w ?? q.year_high, q.last_price ?? t.current_price);
  html += card("snapshot", I.bolt, "Live Snapshot", snap);

  /* Candlestick chart + controls */
  if (Array.isArray(d.price_history || d.price_history_1y) && (d.price_history || d.price_history_1y).length > 10) {
    html += card("chart", I.chart, "Candlestick — Price Action", chartCardBody());
  }

  /* Price action / market structure */
  if (pa.trend && pa.trend !== "INSUFFICIENT DATA") {
    let body = `${signalHtml((pa.trend === "UPTREND" ? "UPTREND: " : pa.trend === "DOWNTREND" ? "DOWNTREND: " : "RANGE: ") + (pa.trend_basis || ""))}`;
    (pa.events || []).forEach(e => body += signalHtml(e));
    body += `<div class="mgrid" style="margin-top:8px">
      ${metric("Recent Swing High", fUsd(pa.recent_swing_high))}
      ${metric("Recent Swing Low", fUsd(pa.recent_swing_low))}</div>`;
    if (pa.fib && Object.keys(pa.fib).length) {
      body += `<div class="lvl-label">Fibonacci retracement (last swing leg)</div><div class="levels">`;
      Object.entries(pa.fib).forEach(([k, val]) => body += `<span class="lvl" style="color:var(--violet);background:rgba(157,140,240,.12)">${k} · ${fUsd(val)}</span>`);
      body += `</div>`;
    }
    html += card("priceaction", I.struct, "Price Action & Market Structure", body, { count: pa.trend });
  }

  /* Institutional footprint */
  if (inst.signals || inst.net_bias) {
    const bias = inst.net_bias || "NEUTRAL";
    const biasCls = bias === "ACCUMULATION" ? "green" : bias === "DISTRIBUTION" ? "red" : "";
    let body = `<label class="toggle ${chartOpts.instWindow ? "on" : ""}" style="--swatch:var(--violet);margin-bottom:10px">
      <input type="checkbox" id="instToggle" ${chartOpts.instWindow ? "checked" : ""} onchange="toggleInstFocus(this.checked)">
      Focus the next question on institutional positioning</label>
      <div class="mgrid">
      ${metric("Net Bias", esc(bias), biasCls)}
      ${metric("OBV Trend", esc(inst.obv_trend || "N/A"), inst.obv_trend === "RISING" ? "green" : inst.obv_trend === "FALLING" ? "red" : "")}
      ${metric("Up-Day Volume (20D)", fPct(inst.up_vol_ratio, 0))}
      ${metric("Accum. Days (25)", String(inst.accumulation_days ?? 0), (inst.accumulation_days || 0) >= 3 ? "green" : "")}
      ${metric("Distrib. Days (25)", String(inst.distribution_days ?? 0), (inst.distribution_days || 0) >= 3 ? "red" : "")}
    </div>`;
    (inst.signals || []).forEach(sg => body += signalHtml(sg));
    html += card("institutional", I.whale, "Institutional Footprint", body);
  }

  /* Algorithmic signals */
  const flags = d.algorithmic_signals || [];
  html += card("signals", I.pulse, "Algorithmic Signals", flags.length ? flags.map(signalHtml).join("") : signalHtml("NEUTRAL: No strong signals triggered."), { count: flags.length });

  /* Chart patterns */
  const pats = d.chart_patterns || [];
  if (pats.length) html += card("patterns", I.layers, "Chart Patterns", pats.map(signalHtml).join(""), { count: pats.length });

  /* Valuation */
  html += card("valuation", I.scale, "Valuation", `<div class="mgrid">
    ${metric("P/E Trailing", fRatio(v.pe_trailing))}${metric("P/E Forward", fRatio(v.pe_forward))}
    ${metric("PEG", fRatio(v.peg_ratio), isNum(v.peg_ratio) ? (v.peg_ratio > 0 && v.peg_ratio < 1 ? "green" : v.peg_ratio > 3 ? "red" : "") : "")}
    ${metric("Price / Book", fRatio(v.price_to_book))}${metric("Price / Sales", fRatio(v.price_to_sales))}
    ${metric("EV / EBITDA", fRatio(v.ev_ebitda))}${metric("FCF Yield", fPct(v.fcf_yield), signCls(v.fcf_yield))}</div>`);

  /* Profitability */
  html += card("profit", I.margin, "Profitability & Margins", `<div class="mgrid">
    ${metric("Gross Margin", fPct(p.gross_margin))}${metric("Operating Margin", fPct(p.operating_margin), signCls(p.operating_margin))}
    ${metric("Net Margin", fPct(p.net_margin), signCls(p.net_margin))}${metric("FCF Margin", fPct(p.fcf_margin), signCls(p.fcf_margin))}
    ${metric("ROE", fPct(p.roe), signCls(p.roe))}${metric("ROA", fPct(p.roa), signCls(p.roa))}</div>`);

  /* Health */
  html += card("health", I.shield, "Financial Health", `<div class="mgrid">
    ${metric("Current Ratio", fRatio(fh.current_ratio), isNum(fh.current_ratio) ? (fh.current_ratio >= 1.5 ? "green" : fh.current_ratio < 1 ? "red" : "amber") : "")}
    ${metric("Debt / Equity", fRatio(fh.debt_to_equity), isNum(fh.debt_to_equity) && fh.debt_to_equity > 200 ? "red" : "")}
    ${metric("Earnings Quality <small>(OCF/NI)</small>", fRatio(fh.earnings_quality), isNum(fh.earnings_quality) ? (fh.earnings_quality >= 1 ? "green" : fh.earnings_quality < 0.5 ? "red" : "amber") : "")}</div>`);

  /* SEC fundamentals */
  let secBody = `<div class="mgrid">
    ${metric("Revenue", fUsd(sec.revenue))}${metric("Net Income", fUsd(sec.net_income), signCls(sec.net_income))}
    ${metric("Total Assets", fUsd(sec.assets))}${metric("Liabilities", fUsd(sec.liabilities))}
    ${metric("Equity", fUsd(sec.equity))}${metric("Operating CF", fUsd(sec.ocf), signCls(sec.ocf))}
    ${metric("Rev CAGR (3Y)", fPct(sec.rev_cagr_3y), signCls(sec.rev_cagr_3y))}</div>`;
  if (d.sec_filing && d.sec_filing.source_url)
    secBody += `<p style="margin-top:10px;font-size:12px;color:var(--text-dim)">Source filing: <a href="${esc(d.sec_filing.source_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(d.sec_filing.form)} · filed ${esc(d.sec_filing.filing_date)}</a></p>`;
  if (d.sec_available === false)
    secBody = `<div class="signal amber"><b>NOTE:</b>&nbsp;SEC EDGAR data unavailable for this ticker — figures rely on the market-data provider only.</div>` + secBody;
  html += card("sec", I.bank, "SEC-Verified Fundamentals (Latest 10-K)", secBody);

  /* Technicals */
  let tech = `<div class="mgrid">
    ${metric("50-Day MA", fUsd(t.ma_50))}${metric("200-Day MA", fUsd(t.ma_200))}
    ${metric("RSI (14)", fRatio(t.rsi_14), isNum(t.rsi_14) ? (t.rsi_14 >= 70 ? "red" : t.rsi_14 <= 30 ? "green" : "") : "")}
    ${metric("MACD", fRatio(t.macd), signCls(t.macd))}${metric("MACD Signal", fRatio(t.macd_signal))}
    ${metric("MACD Hist", fRatio(kl.macd_hist), signCls(kl.macd_hist))}
    ${metric("Bollinger Upper", fUsd(t.bb_upper))}${metric("Bollinger Lower", fUsd(t.bb_lower))}
    ${metric("BB Width", fPct(kl.bb_width_pct))}
    ${metric("Volume Ratio", isNum(t.volume_ratio) ? t.volume_ratio.toFixed(2) + "× <small>20d avg</small>" : "N/A")}
    ${metric("vs 52W High", fPct(t.pct_from_52_high), signCls(t.pct_from_52_high))}
    ${isNum(kl.trend_slope_daily_pct) ? metric("60D Trend Slope", kl.trend_slope_daily_pct.toFixed(2) + "%<small>/day</small>", signCls(kl.trend_slope_daily_pct)) : ""}</div>`;
  if (isNum(t.rsi_14)) tech += rangeBar("RSI scale", 0, 100, t.rsi_14, x => x.toFixed(0));
  const resL = (kl.resistance || []).filter(isNum), supL = (kl.support || []).filter(isNum);
  if (resL.length || supL.length) tech += `<div class="lvl-label">Key price levels</div><div class="levels">
    ${resL.map(x => `<span class="lvl res">R ${fUsd(x)}</span>`).join("")}${supL.map(x => `<span class="lvl sup">S ${fUsd(x)}</span>`).join("")}</div>`;
  html += card("tech", I.gauge, "Technicals & Key Levels", tech);

  /* Risk */
  html += card("risk", I.pulse, "Risk & Return (5Y)", `<div class="mgrid">
    ${metric("CAGR", fPct(rr.cagr), signCls(rr.cagr))}${metric("Annual Volatility", fPct(rr.annual_volatility))}
    ${metric("Sharpe Ratio", fRatio(rr.sharpe), signCls(rr.sharpe))}${metric("Max Drawdown", fPct(rr.max_drawdown), signCls(rr.max_drawdown, true))}
    ${metric("Beta (vs SPY)", fRatio(rr.beta), isNum(rr.beta) && rr.beta > 1.6 ? "amber" : "")}</div>`);

  /* Sentiment */
  let sent = `<div class="mgrid">
    ${metric("Consensus", esc(String(s.rec_key || "N/A").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())))}
    ${metric("Target Mean", fUsd(s.target_mean))}${metric("Target High", fUsd(s.target_high))}${metric("Target Low", fUsd(s.target_low))}
    ${metric("Institutional Own.", fPct(s.inst_ownership))}
    ${metric("Short Interest", fPct(s.short_percent), isNum(s.short_percent) && s.short_percent > 0.10 ? "red" : "")}</div>`;
  sent += rangeBar("Analyst targets vs price (amber = mean target)", s.target_low, s.target_high, t.current_price, fUsd, s.target_mean, "Mean target");
  html += card("sentiment", I.eye, "Sentiment & Ownership", sent);

  /* Earnings */
  const earn = r.earnings_surprises || [];
  if (earn.length) {
    const rows = earn.map(e => { const pos = e.surprise_pct >= 0;
      return `<tr><td class="hi">${esc(e.date)}</td><td>$${e.estimate.toFixed(2)}</td><td class="hi">$${e.reported.toFixed(2)}</td>
        <td class="${pos ? "pos" : "neg"}">${pos ? "+" : ""}${(e.surprise_pct * 100).toFixed(1)}%</td><td class="${pos ? "pos" : "neg"}">${pos ? "Beat" : "Miss"}</td></tr>`; }).join("");
    html += card("earnings", I.cal, "Recent Earnings Surprises",
      `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Estimate</th><th>Reported</th><th>Surprise</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`, { count: earn.length });
  }

  /* Filing activity */
  const fa = d.filing_activity;
  if (fa && d.sec_available !== false) {
    const ev = fa["8k_events"] || [];
    let body = `<div class="mgrid">
      ${metric("Insider Buys <small>(90D)</small>", String(fa.insider_buys ?? 0), fa.insider_buys > 0 ? "green" : "")}
      ${metric("Insider Sells <small>(90D)</small>", String(fa.insider_sells ?? 0), fa.insider_sells >= 5 ? "red" : "")}
      ${metric("Activist 13D", fa.activist_13d ? "Yes" : "No", fa.activist_13d ? "amber" : "")}</div>`;
    body += `<div class="lvl-label">8-K events (last 90 days)</div><div class="levels">` +
      (ev.length ? ev.map(e => `<span class="lvl" style="color:var(--text);background:var(--surface-2)">${esc(e)}</span>`).join("") : `<span style="font-size:12px;color:var(--text-dim)">None filed.</span>`) + `</div>`;
    html += card("filings", I.doc, "SEC Filing Activity (90 Days)", body);
  }

  /* Options */
  const od = d.options_data || {};
  if (od.chains && od.chains.length) {
    let body = `<p style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Available expirations: <span style="font-family:var(--mono)">${(od.available_expirations || []).map(esc).join(" · ")}</span></p>`;
    od.chains.forEach(ch => {
      body += `<div class="opt-exp"><b>${esc(ch.expiration)}</b><span>${ch.days_to_exp} days out</span><span>ATM ${fUsd(ch.atm_strike)}</span>${isNum(od.iv_summary?.[ch.expiration]) ? `<span>IV ${fPct(od.iv_summary[ch.expiration], 1)}</span>` : ""}</div><div class="opt-pair">`;
      [["calls", ch.calls], ["puts", ch.puts]].forEach(([side, arr]) => {
        const rows = (arr || []).map(o => `<tr class="${o.in_the_money ? "itm" : ""}"><td class="hi">${fUsd(o.strike)}${o.in_the_money ? '<span class="itm-badge">ITM</span>' : ""}</td>
          <td>${fUsd(o.bid)}</td><td>${fUsd(o.ask)}</td><td>${fUsd(o.last)}</td><td>${fPct(o.iv, 1)}</td><td>${fInt(o.open_interest)}</td><td>${fInt(o.volume)}</td></tr>`).join("");
        body += `<div><div class="opt-side-label ${side}">${side}</div><div class="tbl-wrap"><table><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Last</th><th>IV</th><th>OI</th><th>Vol</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No data</td></tr>'}</tbody></table></div></div>`;
      });
      body += `</div>`;
    });
    html += card("options", I.layers, "Live Options Chains", body, { open: false, count: od.chains.length + " exp" });
  }

  /* MD&A */
  if (d.mda_excerpt && !/unavailable|Failed|not found/i.test(d.mda_excerpt))
    html += card("mda", I.doc, "MD&A Excerpt (Latest 10-K)", `<div class="prose" style="font-size:13px"><blockquote>${esc(d.mda_excerpt)}</blockquote></div>`, { open: false });

  /* Raw prompt */
  if (d.ai_prompt)
    html += card("prompt", I.brain, "Exact Data Sent to the AI",
      `<p style="font-size:12px;color:var(--text-dim);margin-bottom:8px">The verbatim prompt the model received — every figure above is here, so what you see is what the AI reads.</p>
       <button class="copy-btn" onclick="copyPrompt(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy prompt</button>
       <pre class="raw">${esc(d.ai_prompt)}</pre>`, { open: false });

  document.getElementById("dataBody").innerHTML = html;
  document.getElementById("dataBody").scrollTop = 0;
  wireChartControls();

  /* AI summary */
  const ai = document.getElementById("aiSummary");
  ai.className = "prose";
  ai.innerHTML = (d.aiError ? `<div class="ai-warn">${esc(d.aiError)} — the data dashboard is still fully available.</div>` : "") + renderMarkdown(d.aiSummary || "");
  document.getElementById("aiScroll").scrollTop = 0;

  renderChat();
  requestAnimationFrame(drawChart);
}

function copyPrompt(btn) { navigator.clipboard.writeText(sessions[active]?.data?.ai_prompt || "").then(() => {
  btn.lastChild.textContent = " Copied"; setTimeout(() => (btn.lastChild.textContent = " Copy prompt"), 1600); }); }

function toggleInstFocus(on) { chartOpts.instWindow = on; }

/* ════════════════ CHART: controls + candlestick engine ════════════════ */
function chartCardBody() {
  const tog = (id, label, swatch, dash, dotted = false) =>
    `<label class="toggle ${chartOpts[id] ? "on" : ""}" style="--swatch:${swatch}">
      <input type="checkbox" data-opt="${id}" ${chartOpts[id] ? "checked" : ""}>
      ${dash ? `<span class="dash ${dotted ? "dotted" : ""}"></span>` : ""}${label}</label>`;
  return `<div id="chartControls">
    ${tog("ma20", "MA 20", "var(--accent)", true)}
    ${tog("ma50", "MA 50", "var(--amber)", true)}
    ${tog("ma200", "MA 200", "var(--text-dim)", true)}
    ${tog("bb", "Bollinger", "var(--violet)", true, true)}
    ${tog("fib", "Fibonacci", "var(--violet)", true, true)}
    ${tog("sr", "Support / Resistance", "var(--red)", true, true)}
    ${tog("pct", "% scale", "var(--accent)", false)}
    ${tog("vol", "Volume", "var(--text-dim)", false)}
    <div id="rangeSel"></div></div>
    <div id="chartBox">
      <canvas id="priceChart"></canvas><div id="chartTip"></div>
      <button class="chart-expand-btn" title="Expand chart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
    </div>`;
}
const RANGES = [["1W", 5], ["1M", 21], ["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["5Y", 1260]];

function buildRangeSel(container) {
  if (!container) return;
  const cur = sessions[active]?.range || 252;
  container.innerHTML = RANGES.map(([l, n]) =>
    `<button data-range="${n}" class="${cur === n ? "active" : ""}">${l}</button>`).join("");
  container.querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      const n = Number(b.dataset.range);
      if (sessions[active]) sessions[active].range = n;
      // keep both selectors in sync
      ["#rangeSel", "#chartModalRangeSel"].forEach(sel =>
        document.querySelectorAll(sel + " button").forEach(x => x.classList.toggle("active", Number(x.dataset.range) === n)));
      drawChart();
    };
  });
}

function wireChartControls() {
  document.querySelectorAll('#chartControls input[data-opt]').forEach(cb => {
    cb.onchange = () => { chartOpts[cb.dataset.opt] = cb.checked; cb.closest(".toggle").classList.toggle("on", cb.checked); drawChart(); };
  });
  buildRangeSel(document.getElementById("rangeSel"));
  buildRangeSel(document.getElementById("chartModalRangeSel"));
  const expandBtn = document.querySelector('.chart-expand-btn');
  if (expandBtn) expandBtn.onclick = () => window.expandChart(active);
}
function movingAvg(arr, n) { const out = new Array(arr.length).fill(null); let sum = 0;
  for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= n) sum -= arr[i - n]; if (i >= n - 1) out[i] = sum / n; } return out; }
function bollinger(arr, n = 20, k = 2) {
  const mid = movingAvg(arr, n), up = new Array(arr.length).fill(null), lo = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) { const win = arr.slice(i - n + 1, i + 1); const m = mid[i];
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / n); up[i] = m + k * sd; lo[i] = m - k * sd; }
  return { mid, up, lo };
}

function drawChart() {
  const sess = sessions[active]; if (!sess) return;
  const d = sess.data;
  const canvas = window._chartCanvasEl ? window._chartCanvasEl() : document.getElementById("priceChart");
  const tipEl  = window._chartTipEl   ? window._chartTipEl()   : document.getElementById("chartTip");
  const all = d.price_history || d.price_history_1y;
  if (!canvas || !Array.isArray(all) || all.length < 5) return;

  const full = all.filter(p => isNum(p.close) && isNum(p.open) && isNum(p.high) && isNum(p.low));
  const closesFull = full.map(p => p.close);
  const ma20f = movingAvg(closesFull, 20), ma50f = movingAvg(closesFull, 50), ma200f = movingAvg(closesFull, 200);
  const bbF = bollinger(closesFull, 20, 2);

  const N = Math.min(sess.range || 252, full.length);
  const s0 = full.length - N;
  const data = full.slice(s0);
  const ma20 = ma20f.slice(s0), ma50 = ma50f.slice(s0), ma200 = ma200f.slice(s0);
  const bb = { up: bbF.up.slice(s0), lo: bbF.lo.slice(s0), mid: bbF.mid.slice(s0) };

  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

  const kl = d.raw_data?.key_levels || {};
  const srLevels = chartOpts.sr ? [...(kl.resistance || []).filter(isNum).map(x => [x, cssVar("--red")]),
                                   ...(kl.support || []).filter(isNum).map(x => [x, cssVar("--green")])] : [];
  const fib = (chartOpts.fib && d.price_action && d.price_action.fib) ? d.price_action.fib : null;

  // price bounds (include overlays so nothing clips)
  let vals = [];
  data.forEach(p => { vals.push(p.high, p.low); });
  if (chartOpts.bb) bb.up.forEach((x, i) => { if (isNum(x)) vals.push(x, bb.lo[i]); });
  srLevels.forEach(l => vals.push(l[0]));
  if (fib) Object.values(fib).forEach(x => { if (isNum(x)) vals.push(x); });
  const lo = Math.min(...vals) * 0.99, hi = Math.max(...vals) * 1.01;

  const padL = 54, padR = chartOpts.pct ? 50 : 14, padT = 12, padB = 30;
  const volH = chartOpts.vol ? 46 : 0;
  const plotB = H - padB - volH;
  const X = i => padL + (i + 0.5) / data.length * (W - padL - padR);
  const Y = val => padT + (1 - (val - lo) / (hi - lo)) * (plotB - padT);
  const cw = Math.max(1, (W - padL - padR) / data.length);
  const bodyW = Math.max(1, Math.min(cw * 0.66, 13));

  // grid + y axis ($)
  ctx.font = "10px 'IBM Plex Mono', monospace"; ctx.fillStyle = cssVar("--text-dim"); ctx.strokeStyle = cssVar("--border-soft"); ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const val = lo + g / 4 * (hi - lo), y = Y(val);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillText(val >= 1000 ? "$" + (val / 1000).toFixed(1) + "k" : "$" + val.toFixed(val < 10 ? 2 : 0), 6, y + 3);
    if (chartOpts.pct) { const base = data[0].close; const pc = ((val - base) / base) * 100;
      ctx.textAlign = "left"; ctx.fillStyle = cssVar("--text-dim"); ctx.fillText((pc >= 0 ? "+" : "") + pc.toFixed(0) + "%", W - padR + 6, y + 3); }
  }
  // x axis (dates)
  ctx.textAlign = "center"; ctx.fillStyle = cssVar("--text-dim");
  for (let g = 0; g <= 4; g++) { const i = Math.round(g / 4 * (data.length - 1)); ctx.fillText(data[i].date.slice(2), X(i), H - 8); }

  // volume
  if (chartOpts.vol) {
    const maxVol = Math.max(...data.map(p => p.volume || 0)) || 1;
    data.forEach((p, i) => { const h = (p.volume || 0) / maxVol * (volH - 6);
      ctx.fillStyle = (p.close >= p.open ? cssVar("--green") : cssVar("--red")); ctx.globalAlpha = .35;
      ctx.fillRect(X(i) - bodyW / 2, H - 6 - h, bodyW, h); ctx.globalAlpha = 1; });
  }

  // Bollinger band fill + lines
  if (chartOpts.bb) {
    ctx.beginPath(); let started = false;
    bb.up.forEach((x, i) => { if (!isNum(x)) return; started ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); started = true; });
    for (let i = bb.lo.length - 1; i >= 0; i--) if (isNum(bb.lo[i])) ctx.lineTo(X(i), Y(bb.lo[i]));
    ctx.closePath(); ctx.fillStyle = "rgba(157,140,240,.07)"; ctx.fill();
    [["up", bb.up], ["lo", bb.lo]].forEach(([, arr]) => { ctx.beginPath(); let st = false;
      arr.forEach((x, i) => { if (!isNum(x)) return; st ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); st = true; });
      ctx.strokeStyle = cssVar("--violet"); ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1; });
  }

  // S/R lines
  srLevels.forEach(([val, color]) => { ctx.strokeStyle = color; ctx.globalAlpha = .55; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, Y(val)); ctx.lineTo(W - padR, Y(val)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(fUsd(val), padL + 3, Y(val) - 3); });

  // Fibonacci
  if (fib) { Object.entries(fib).forEach(([k, val]) => { if (!isNum(val)) return;
    ctx.strokeStyle = cssVar("--violet"); ctx.globalAlpha = .4; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(val)); ctx.lineTo(W - padR, Y(val)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar("--violet"); ctx.textAlign = "right"; ctx.fillText(k, W - padR - 3, Y(val) - 3); }); }

  // MA lines
  const maSpec = [[chartOpts.ma200, ma200, cssVar("--text-dim"), 1.2], [chartOpts.ma50, ma50, cssVar("--amber"), 1.4], [chartOpts.ma20, ma20, cssVar("--accent"), 1.4]];
  maSpec.forEach(([on, arr, color, wgt]) => { if (!on) return; ctx.beginPath(); let st = false;
    arr.forEach((val, i) => { if (val === null) return; st ? ctx.lineTo(X(i), Y(val)) : ctx.moveTo(X(i), Y(val)); st = true; });
    ctx.strokeStyle = color; ctx.lineWidth = wgt; ctx.stroke(); });

  // CANDLES
  ctx.lineWidth = 1;
  data.forEach((p, i) => {
    const up = p.close >= p.open, color = up ? cssVar("--green") : cssVar("--red");
    const x = X(i);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    // wick
    ctx.beginPath(); ctx.moveTo(x, Y(p.high)); ctx.lineTo(x, Y(p.low)); ctx.stroke();
    // body
    const yO = Y(p.open), yC = Y(p.close); const top = Math.min(yO, yC); const hgt = Math.max(1, Math.abs(yC - yO));
    if (up) { ctx.globalAlpha = document.documentElement.dataset.theme === "dark" ? .85 : 1; ctx.fillRect(x - bodyW / 2, top, bodyW, hgt); ctx.globalAlpha = 1; }
    else { ctx.fillRect(x - bodyW / 2, top, bodyW, hgt); }
  });

  // crosshair / tooltip
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(data.length - 1, Math.floor(((e.clientX - rect.left) - padL) / (W - padL - padR) * data.length)));
    const p = data[i]; if (!p) return;
    drawChart._hover = i; drawChart();
    tipEl.style.display = "block";
    const chg = ((p.close - p.open) / p.open) * 100;
    tipEl.innerHTML = `<b>${p.date}</b><br>O ${fUsd(p.open)} · H ${fUsd(p.high)}<br>L ${fUsd(p.low)} · C ${fUsd(p.close)}<br>
      <span class="${chg >= 0 ? "tg" : "tr"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span> · Vol ${fInt(p.volume)}`;
    const tx = Math.min(X(i) + 12, W - 160); tipEl.style.left = Math.max(padL, tx) + "px"; tipEl.style.top = "10px";
  };
  canvas.onmouseleave = () => { tipEl.style.display = "none"; drawChart._hover = null; drawChart(); };

  // draw crosshair if hovering
  if (isNum(drawChart._hover) && drawChart._hover < data.length) {
    const x = X(drawChart._hover);
    ctx.strokeStyle = cssVar("--text-dim"); ctx.globalAlpha = .4; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, plotB); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
}
drawChart._hover = null;
window.chartRedrawCallback = function () { drawChart(); };
window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => { if (active) drawChart(); }, 120); });

/* ════════════════ MARKDOWN ════════════════ */
function renderMarkdown(text) {
  let t = esc(text);
  t = t.replace(/((?:^\|.*\|[ \t]*$\n?)+)/gm, block => {
    const lines = block.trim().split("\n").filter(l => l.trim()); if (lines.length < 2) return block;
    const cells = l => l.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    let out = "<div class='tbl-wrap'><table>";
    lines.forEach((line, idx) => { if (/^\|?\s*:?-{2,}/.test(line)) return; const tag = idx === 0 ? "th" : "td";
      out += "<tr>" + cells(line).map(c => `<${tag}>${c}</${tag}>`).join("") + "</tr>"; });
    return out + "</table></div>\n";
  });
  return t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^#{3,4} (.+)$/gm, "<h3>$1</h3>").replace(/^#{1,2} (.+)$/gm, "<h2>$1</h2>")
    .replace(/^>\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^[-•*]\s+(.+)$/gm, "<li>$1</li>").replace(/^(\d+)\.\s+(.+)$/gm, "<li>$2</li>")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
    .replace(/^-{3,}$/gm, "<hr>").replace(/\n{2,}/g, "</p><p>")
    .replace(/^(?!\s*<[hpuoldbt])(.+)$/gm, "<p>$1</p>").replace(/<p>\s*<\/p>/g, "");
}

/* ════════════════ CHAT (per-ticker) ════════════════ */
function renderChat() {
  const m = document.getElementById("chatMessages"); const sess = sessions[active];
  if (!sess) { m.innerHTML = ""; return; }
  if (!sess.history.length) {
    m.innerHTML = `<div class="chat-empty">Ask anything about <b>${esc(active)}</b> — risks, peers, options ideas, or how institutions are positioned. Each ticker keeps its own thread.</div>`;
    return;
  }
  m.innerHTML = sess.history.map(msg => msg.role === "user"
    ? `<div class="msg user">${esc(msg.content)}</div>`
    : `<div class="msg ai"><div class="prose">${renderMarkdown(msg.content)}</div></div>`).join("");
  scrollChat();
}
async function sendChat() {
  const input = document.getElementById("chatInput"), btn = document.getElementById("chatSend");
  const sess = sessions[active]; const msg = input.value.trim();
  if (!msg || !sess) return;
  input.value = ""; btn.disabled = true;

  let content = msg;
  if (chartOpts.instWindow) content = "[Focus on institutional positioning and price-action evidence] " + msg;

  sess.history.push({ role: "user", content });
  renderChat();
  const m = document.getElementById("chatMessages");
  const typingId = "typing_" + Date.now();
  m.insertAdjacentHTML("beforeend", `<div class="msg ai" id="${typingId}" style="display:flex;align-items:center;gap:8px"><div class="spinner"></div> Thinking…</div>`);
  scrollChat();

  try {
    const res = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: sess.history, context: sess.context }) });
    const data = await res.json();
    document.getElementById(typingId)?.remove();
    if (data.error) { sess.history.push({ role: "assistant", content: "Error: " + data.error }); }
    else sess.history.push({ role: "assistant", content: data.reply });
    renderChat();
  } catch (e) {
    document.getElementById(typingId)?.remove();
    sess.history.push({ role: "assistant", content: "Connection error: " + e.message }); renderChat();
  }
  btn.disabled = false; input.focus();
}
function scrollChat() { const m = document.getElementById("chatMessages"); m.scrollTop = m.scrollHeight; }
document.getElementById("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
document.getElementById("ticker").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); runAnalysis(); } });

/* ════════════════ RESIZERS ════════════════ */
(function () {
  const rz = document.getElementById("resizer"), split = document.getElementById("split");
  try { const saved = localStorage.getItem("squall-split"); if (saved) split.style.setProperty("--left-w", saved); } catch (e) {}
  let dragging = false;
  rz.addEventListener("pointerdown", e => { dragging = true; rz.classList.add("dragging"); rz.setPointerCapture(e.pointerId); document.body.style.userSelect = "none"; });
  rz.addEventListener("pointermove", e => { if (!dragging) return; const rect = split.getBoundingClientRect();
    let pct = Math.max(30, Math.min(70, (e.clientX - rect.left) / rect.width * 100)); split.style.setProperty("--left-w", pct + "%"); });
  const stop = () => { if (!dragging) return; dragging = false; rz.classList.remove("dragging"); document.body.style.userSelect = "";
    try { localStorage.setItem("squall-split", split.style.getPropertyValue("--left-w")); } catch (e) {} if (active) drawChart(); };
  rz.addEventListener("pointerup", stop); rz.addEventListener("pointercancel", stop);
  rz.addEventListener("dblclick", () => { split.style.setProperty("--left-w", "50%"); try { localStorage.removeItem("squall-split"); } catch (e) {} if (active) drawChart(); });
})();

(function () {
  const grip = document.getElementById("chatGrip"), dock = document.getElementById("chatDock");
  try { const saved = localStorage.getItem("squall-chat-h"); if (saved) dock.style.setProperty("--chat-h", saved); } catch (e) {}
  let dragging = false;
  grip.addEventListener("pointerdown", e => { dragging = true; grip.classList.add("dragging"); grip.setPointerCapture(e.pointerId); document.body.style.userSelect = "none"; });
  grip.addEventListener("pointermove", e => { if (!dragging) return;
    const aiPane = document.getElementById("aiPane").getBoundingClientRect();
    let h = Math.max(120, Math.min(aiPane.height * 0.8, aiPane.bottom - e.clientY)); dock.style.setProperty("--chat-h", h + "px"); });
  const stop = () => { if (!dragging) return; dragging = false; grip.classList.remove("dragging"); document.body.style.userSelect = "";
    try { localStorage.setItem("squall-chat-h", dock.style.getPropertyValue("--chat-h")); } catch (e) {} };
  grip.addEventListener("pointerup", stop); grip.addEventListener("pointercancel", stop);
})();

/* ════════════════ MOBILE TABS ════════════════ */
document.querySelectorAll("#mobileTabs button").forEach(btn => {
  btn.onclick = () => { document.querySelectorAll("#mobileTabs button").forEach(b => b.classList.toggle("active", b === btn));
    if (matchMedia("(max-width: 960px)").matches) {
      document.getElementById("dataPane").toggleAttribute("data-hidden", btn.dataset.pane !== "dataPane");
      document.getElementById("aiPane").toggleAttribute("data-hidden", btn.dataset.pane !== "aiPane");
      if (btn.dataset.pane === "dataPane" && active) drawChart(); } };
});
matchMedia("(max-width: 960px)").addEventListener("change", ev => {
  if (!ev.matches) { document.getElementById("dataPane").removeAttribute("data-hidden"); document.getElementById("aiPane").removeAttribute("data-hidden"); }
  else document.querySelector("#mobileTabs button.active")?.click();
  if (active) drawChart();
});
if (matchMedia("(max-width: 960px)").matches) document.getElementById("aiPane").setAttribute("data-hidden", "");

/* ════════════════ MODAL OVERLAY TOGGLES (delegation — fires on cloned checkboxes) ════════════════ */
document.getElementById("chartModalControls").addEventListener("change", function (e) {
  const opt = e.target.dataset.opt;
  if (!opt) return;
  chartOpts[opt] = e.target.checked;
  e.target.closest(".toggle")?.classList.toggle("on", e.target.checked);
  // Mirror state back to the source checkbox in #chartControls
  const src = document.querySelector(`#chartControls input[data-opt="${opt}"]`);
  if (src) { src.checked = e.target.checked; src.closest(".toggle")?.classList.toggle("on", e.target.checked); }
  drawChart();
});
