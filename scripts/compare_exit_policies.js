#!/usr/bin/env node
"use strict";
/*
 * Does an AI re-review at the exit beat the free deterministic rule?
 *
 * Runs the SHIPPED ensureBacktestPosition / simulateTrade / simulateTradeReviewed over
 * real post-cutoff bars and reports four policies side by side. Nothing here
 * re-implements the exit rules, so what it prints is what /ilgar does.
 *
 *   node scripts/compare_exit_policies.js cases.json
 *
 * The AI column needs OPENROUTER_API_KEY. Without it, the run still prints the three
 * deterministic columns and says the AI one was skipped — that is the expected result
 * on a box with no key, not a failure.
 *
 * Build a cases file with scripts/fetch_backtest_cases.py.
 *
 * Predicted, from a 36-trade sample at risk 3:
 *   exit on first breach          3.9%
 *   tolerate one breach (shipped) 6.3%
 *   oracle (unreachable ceiling)  7.5%
 * A modelled reviewer at p=0.7 scored 5.4% and at p=0.9 scored 6.1% — i.e. the model
 * says even a very good reviewer does not clear the free rule. This script exists to
 * check that claim against a real one.
 */
const path = require("path");
const fs = require("fs");
const S = require(path.join(__dirname, "..", "server.js"));

const HOR = { "1m": 21, "3m": 63, "6m": 126 };
const file = process.argv[2] || "cases.json";
if (!fs.existsSync(file)) {
  console.error(`No cases file at ${file}. Build one with scripts/fetch_backtest_cases.py.`);
  process.exit(1);
}
const cases = JSON.parse(fs.readFileSync(file, "utf8"));
const RISK = Number(process.env.COMPARE_RISK) || 3;
const profile = { risk: RISK, horizon: 3, style: "balanced" };
const pct = x => x == null ? "  n/a" : `${(x * 100).toFixed(1)}%`;

function decisionFor(c, dir) {
  const snap = { technical: { metrics: { atr_pct: c.atr_pct, return_20d: c.return_20d,
    return_60d: c.return_60d }, scores: {} } };
  // The model obeying the prompt: a stop sized off the daily atr_pct.
  return S.ensureBacktestPosition({ direction: dir, conviction: 3, horizon: "3m",
    stop_pct: Math.max(0.01, 2 * c.atr_pct), target_pct: 4 * c.atr_pct,
    thesis: "Pre-cutoff trend and volume evidence favoured this side." }, snap, profile);
}
const ret = (sim, dir) => dir === "long"
  ? sim.exit.price / sim.entry.price - 1 : 1 - sim.exit.price / sim.entry.price;

function summarise(label, rows, calls) {
  const avg = rows.reduce((s, r) => s + r, 0) / rows.length;
  const worst = Math.min(...rows);
  const wins = rows.filter(r => r > 0).length;
  console.log(`${label.padEnd(32)} ret=${pct(avg).padStart(7)}  win=${String(wins).padStart(2)}/${rows.length}  worst=${pct(worst).padStart(8)}  AI calls=${calls}`);
}

(async () => {
  const strict = [], shipped = [], oracle = [], reviewed = [];
  let reviewCalls = 0, holds = 0, exits = 0;
  const hasKey = !!process.env.OPENROUTER_API_KEY;

  for (const c of cases) {
    for (const dir of ["long", "short"]) {
      const dec = decisionFor(c, dir);

      strict.push(ret(S.simulateTrade({ ...dec, breach_tolerance: 0 }, c.bars), dir));
      shipped.push(ret(S.simulateTrade(dec, c.bars), dir));

      // Ceiling: at each breach an oracle takes whichever of {exit, hold to horizon}
      // ends better. Uses future bars BY DESIGN and is not a policy anyone can run.
      const hN = Math.min(HOR[dec.horizon], c.bars.close.length) - 1;
      const holdRet = dir === "long"
        ? c.bars.close[hN] / c.bars.open[0] - 1 : 1 - c.bars.close[hN] / c.bars.open[0];
      const base = S.simulateTrade({ ...dec, breach_tolerance: 0 }, c.bars);
      oracle.push(Math.max(ret(base, dir), holdRet));

      if (hasKey) {
        const sim = await S.simulateTradeReviewed(dec, c.bars, async (prompt) => {
          reviewCalls++;
          const v = await S.requestBacktestReview(prompt, undefined);
          if (v && v.action === "hold") holds++; else exits++;
          return v;
        });
        reviewed.push(ret(sim, dir));
      }
    }
    process.stderr.write(`.`);
  }
  process.stderr.write("\n\n");

  console.log(`${cases.length} cases x long+short at risk ${RISK}\n`);
  summarise("exit on first breach", strict, 0);
  summarise("tolerate one breach (shipped)", shipped, 0);
  if (hasKey) {
    summarise("AI re-review at each breach", reviewed, reviewCalls);
    console.log(`\nreviewer said hold ${holds} times, exit ${exits} times`);
  } else {
    console.log("AI re-review at each breach     skipped - set OPENROUTER_API_KEY to run it");
  }
  summarise("oracle (unreachable ceiling)", oracle, 0);

  if (hasKey) {
    const a = shipped.reduce((s, r) => s + r, 0) / shipped.length;
    const b = reviewed.reduce((s, r) => s + r, 0) / reviewed.length;
    console.log(`\nVERDICT: the AI re-review is ${b > a ? "AHEAD OF" : "BEHIND"} the free rule by ${pct(Math.abs(b - a))}, at a cost of ${reviewCalls} extra LLM calls.`);
    console.log("Note the sample is small and one-sided; a difference under ~1pp is noise here.");
  }
})();
