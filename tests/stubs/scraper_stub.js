// Stands in for scraperFinal.py: same argv/stdout/stderr contract, no Python needed.
// Exists so the full server path — queue, budgets, cache, SSE, and the whole front end —
// can be exercised on a box without Python or API keys. Production never sets these vars.
//
//   PORT=3271 PYTHON_BIN=node SQUALL_SCRAPER_PATH=./tests/stubs/scraper_stub.js node server.js
//
// Pass STUB_NO_INTRADAY=1 to emit a payload with intraday_history empty, which is what a
// fund, a thin name or a Yahoo miss actually looks like — the case where the chart must
// hide its 1D/1W/1M tiers rather than render an empty canvas.
"use strict";

const ticker = (process.argv[2] || "AAA").toUpperCase();
const NO_INTRADAY = process.env.STUB_NO_INTRADAY === "1";

for (let s = 0; s <= 6; s++) process.stderr.write(`STAGE|${s}|7|Stub stage ${s}\n`);

// Deterministic wave so candles have visible structure to eyeball rather than a ramp.
function dailyBars(n) {
  const out = [];
  const start = Date.UTC(2021, 0, 4);
  for (let i = 0; i < n; i++) {
    const t = new Date(start + i * 86400000);
    if (t.getUTCDay() === 0 || t.getUTCDay() === 6) continue;
    const base = 150 + Math.sin(i / 23) * 28 + i * 0.05;
    const open = base + Math.sin(i / 5) * 1.4;
    const close = base + Math.cos(i / 7) * 1.9;
    out.push({
      date: t.toISOString().slice(0, 10),
      open: +open.toFixed(4), high: +(Math.max(open, close) + 1.3).toFixed(4),
      low: +(Math.min(open, close) - 1.2).toFixed(4), close: +close.toFixed(4),
      volume: 40_000_000 + (i % 11) * 900_000
    });
  }
  return out;
}

// Intraday bars stamped "YYYY-MM-DD HH:MM", the shape get_intraday_series emits.
function intradayBars(days, perDay, stepMin) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.UTC(2024, 4, 6 + d));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    for (let b = 0; b < perDay; b++) {
      const mins = 570 + b * stepMin;                 // 09:30 open
      const hh = String(Math.floor(mins / 60)).padStart(2, "0");
      const mm = String(mins % 60).padStart(2, "0");
      const k = d * perDay + b;
      const base = 182 + Math.sin(k / 9) * 2.6 + d * 0.7;
      const open = base + Math.sin(k / 3) * 0.35;
      const close = base + Math.cos(k / 4) * 0.5;
      out.push({
        date: `${day.toISOString().slice(0, 10)} ${hh}:${mm}`,
        open: +open.toFixed(4), high: +(Math.max(open, close) + 0.28).toFixed(4),
        low: +(Math.min(open, close) - 0.26).toFixed(4), close: +close.toFixed(4),
        volume: 300_000 + (k % 7) * 22_000
      });
    }
  }
  return out;
}

const price_history = dailyBars(1900);
const bars5m = NO_INTRADAY ? [] : intradayBars(5, 78, 5);
const bars60m = NO_INTRADAY ? [] : intradayBars(21, 7, 60);
const last = price_history[price_history.length - 1].close;

const intraday_history = {};
const intraday_meta = {};
if (bars5m.length) {
  intraday_history["5m"] = bars5m;
  intraday_meta["5m"] = { interval: "5m", period: "5d", bars: bars5m.length,
    first: bars5m[0].date, last: bars5m[bars5m.length - 1].date };
}
if (bars60m.length) {
  intraday_history["60m"] = bars60m;
  intraday_meta["60m"] = { interval: "60m", period: "1mo", bars: bars60m.length,
    first: bars60m[0].date, last: bars60m[bars60m.length - 1].date };
}

process.stdout.write(JSON.stringify({
  ticker, cik: "0000000000", company_name: `${ticker} Stub Industries`,
  today: "2026-08-27", sec_available: true, sec_diagnostics: [],
  finnhub_configured: true, finnhub_available: true, fmp_available: false,
  data_sources: { quote: "Stub", history: "Yahoo", news: "Finnhub",
    company_profile: "Finnhub + Yahoo", sec: "SEC EDGAR", fmp: "Unavailable" },
  raw_data: {
    valuation: { pe_trailing: 31.4, pe_forward: 26.1, peg_ratio: 2.1, price_to_book: 8.3,
      price_to_sales: 6.9, ev_ebitda: 21.7, fcf_yield: 0.034 },
    profitability: { gross_margin: 0.46, operating_margin: 0.301, net_margin: 0.248,
      roe: 0.412, roa: 0.194, fcf_margin: 0.271 },
    financial_health: { current_ratio: 1.62, debt_to_equity: 141.2, earnings_quality: 1.18 },
    sec_fundamentals: { revenue: 3.94e11, net_income: 9.7e10, assets: 3.5e11,
      liabilities: 2.9e11, equity: 6.2e10, ocf: 1.1e11, rev_cagr_3y: 0.081 },
    technicals: { current_price: last, daily_change: 0.0124, high_52w: last * 1.18,
      low_52w: last * 0.74, pct_from_52_high: -0.061, ma_50: last * 0.97, ma_200: last * 0.91,
      rsi_14: 61.3, volume_ratio: 1.31, macd: 1.84, macd_signal: 1.52,
      bb_upper: last * 1.05, bb_lower: last * 0.94 },
    risk_return: { cagr: 0.192, max_drawdown: -0.312, sharpe: 0.81,
      annual_volatility: 0.284, beta: 1.18 },
    sentiment: { target_mean: last * 1.11, target_high: last * 1.3, target_low: last * 0.82,
      rec_key: "buy", inst_ownership: 0.612, short_percent: 0.021 },
    earnings_surprises: [
      { date: "2026-07-31", estimate: 1.42, reported: 1.51, surprise_pct: 0.0634 },
      { date: "2026-05-01", estimate: 1.51, reported: 1.44, surprise_pct: -0.0464 },
    ],
    key_levels: { resistance: [last * 1.04, last * 1.09], support: [last * 0.96, last * 0.91],
      bb_upper: last * 1.05, bb_lower: last * 0.94, bb_width_pct: 0.108,
      macd: 1.84, macd_signal: 1.52, macd_hist: 0.32, trend_slope_daily_pct: 0.07 }
  },
  chart_patterns: ["GOLDEN CROSS: 50MA crossed above 200MA recently.",
                   "BB EXPANSION: Very wide bands — high volatility regime."],
  algorithmic_signals: ["BULLISH: Price above both moving averages.",
                        "WARNING: Volume ratio elevated into resistance."],
  filing_activity: { "8k_events": ["Results of Operations"], insider_buys: 2,
    insider_sells: 6, activist_13d: false, window_days: 90, truncated: false },
  options_data: {
    available_expirations: ["2026-09-18", "2026-10-16"],
    chains: [{ expiration: "2026-09-18", days_to_exp: 22, atm_strike: Math.round(last),
      calls: [{ strike: Math.round(last) + 5, bid: 3.1, ask: 3.3, last: 3.2, iv: 0.31,
        open_interest: 4210, volume: 880, in_the_money: false }],
      puts: [{ strike: Math.round(last) - 5, bid: 2.7, ask: 2.9, last: 2.8, iv: 0.33,
        open_interest: 3110, volume: 640, in_the_money: false }] }],
    iv_summary: { "2026-09-18": 0.318 }
  },
  mda_excerpt: "Revenue grew across every reportable segment, led by services…",
  live_quote: { fetched_at: "2026-08-27 14:31:00Z", source: "Stub", last_price: last,
    open: last * 0.995, day_high: last * 1.012, day_low: last * 0.988,
    previous_close: last * 0.988, bid: last - 0.02, ask: last + 0.02,
    bid_size: 300, ask_size: 400, market_state: "REGULAR", currency: "USD",
    exchange: "NASDAQ", market_cap: 2.9e12, year_high: last * 1.18, year_low: last * 0.74,
    last_volume: 51_200_000 },
  company_news: [{ published_at: "2026-08-26T12:00:00Z", source: "Stub Wire",
    headline: "Stub Industries raises full-year guidance",
    summary: "The company lifted its outlook after a stronger-than-expected quarter.",
    url: "https://example.com/stub" }],
  company_profile: { sector: "Technology", industry: "Consumer Electronics" },
  market_regime: { label: "TRENDING", confidence: 72,
    summary: "Price is extending on expanding volume.",
    evidence: ["Higher highs over 25 sessions", "Up-volume 61% of the last 20 days"] },
  price_action: { trend: "UPTREND", trend_basis: "higher highs and higher lows since March",
    recent_swing_high: last * 1.06, recent_swing_low: last * 0.93,
    events: ["BREAK OF STRUCTURE: prior swing high taken out"],
    fib: { "38.2%": last * 0.98, "50%": last * 0.96, "61.8%": last * 0.94 } },
  institutional: { obv_trend: "RISING", up_vol_ratio: 0.61, accumulation_days: 5,
    distribution_days: 2, net_bias: "ACCUMULATION",
    signals: ["ACCUMULATION: OBV rising with price."] },
  intraday_history, intraday_meta,
  price_history,
  price_history_1y: price_history.slice(-252),
  ai_prompt: `### 6b. RECENT PRICE BARS\nReturns: 1D 1.24% | 1W -0.41%\nStub prompt for ${ticker}.`
}));
