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
