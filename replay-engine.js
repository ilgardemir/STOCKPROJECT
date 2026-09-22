"use strict";

// Versioned research policy. These constants are assumptions, never tuned on the replay.
const VERSION = "replay-v2";
const SESSIONS = Object.freeze({"1m":21, "3m":63, "6m":126});
function replayPolicy(horizon = "3m") {
  if (!Object.hasOwn(SESSIONS, horizon)) throw new Error("Choose a 1m, 3m or 6m replay horizon.");
  return Object.freeze({version:VERSION, horizon, sessions:SESSIONS[horizon],
    position_pct:.25, stop_pct:.08, target_pct:.16, cost_bps:10, borrow_apr:.03,
    entry_rule:"next_open", exit_mode:"fixed_close_next_open", breach_tolerance:0,
    price_basis:"split-adjusted price returns; dividends excluded on both stock and SPY",
    benchmark_basis:"same initial exposure and observation window; residual cash earns zero",
    execution:"Signals at daily close, fills at following open; not intraday stop orders. Horizon exit at open after the selected number of held sessions.",
    limitations:["Historical model knowledge cannot be removed by withholding future bars; this is not a blind forecast test.",
      "User-selected surviving symbols and dates are not a representative or untouched evaluation sample.",
      "10 bps each way and 3% annual borrow on initial short notional are scenario assumptions, not observed execution costs.",
      "Dividends, cash interest, taxes, margin calls, borrow availability and recalls are not modeled. Short trades are hypothetical.",
      "Current-vintage provider data may contain revisions. Split-adjusted prices need not equal historically traded prices."]});
}

// Extract a commitment from THIS response only. No second model, inferred direction,
// substituted trade, or confidence-to-size mapping. Failures are not abstentions.
function parseReplayDecision(prose, policy) {
  const matches = [...String(prose || "").matchAll(/<replay_decision>\s*([\s\S]*?)\s*<\/replay_decision>/g)];
  if (matches.length !== 1) return null;
  let raw;
  try { raw = JSON.parse(matches[0][1]); } catch (_) { return null; }
  if (!raw || !["long", "short", "flat"].includes(raw.direction) || typeof raw.thesis !== "string" || !raw.thesis.trim()) return null;
  return {...policy, direction:raw.direction, thesis:raw.thesis.trim().slice(0,1000),
    decision_source:"recorded_ai_response", position_pct:raw.direction === "flat" ? 0 : policy.position_pct};
}

function replayMessages(prompt, policy) {
  return [
    {role:"system", content:"Analyze only the supplied historical snapshot. Do not use remembered later events. This is a retrospective research replay, not a blind forecast test. State uncertainties and unavailable evidence. Regime and chart labels summarize the same bars and are not independent evidence. Choose long, short, or flat; flat is valid when evidence is insufficient. Use the fixed policy supplied below; do not change size, horizon, stops or targets. Finish with exactly one <replay_decision>{\"direction\":\"long\"|\"short\"|\"flat\",\"thesis\":\"one sentence\"}</replay_decision> block containing valid JSON. Do not supply conviction or personal risk advice."},
    {role:"user", content:prompt + "\n\nPolicy locked before this response:\n" + JSON.stringify(policy)}
  ];
}

const price = x => typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
const daysBetween = (a,b) => (Date.parse(b) - Date.parse(a)) / 86400000;

function simulateReplay(decision, bars, policy) {
  const base = 10000;
  const empty = (status, reason) => ({base, policy, status, reason, curve:[], entry:null, exit:null, stats:{}});
  if (!bars || bars.basis !== "split_adjusted_price") return empty("unavailable", "The required price-return basis is unavailable; no substitute series was used.");
  const n = Math.min(bars.dates?.length || 0, policy.sessions + 1);
  if (!n) return empty("incomplete", "No post-cutoff sessions are available.");
  for (let i=0;i<n;i++) {
    const date = bars.dates[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      (i && date <= bars.dates[i-1]) || !price(bars.open?.[i]) || !price(bars.close?.[i]))
      return empty("unavailable", "Missing or invalid session prices; no last-close fill or interpolation was invented.");
  }
  const entry = bars.open[0], spyEntry = price(bars.spyOpen?.[0]);
  const direction = decision?.direction;
  const trading = direction === "long" || direction === "short";
  const flat = direction === "flat";
  const sign = direction === "short" ? -1 : 1;
  const exposure = policy.position_pct, cost = policy.cost_bps/10000;
  const complete = n === policy.sessions + 1;
  let exitIndex = null, reason = null, pendingExit = null;
  if (trading) {
    for (let i=0;i<Math.min(n,policy.sessions);i++) {
      const move = sign * (bars.close[i]/entry - 1);
      const signal = move <= -policy.stop_pct ? "stop" : move >= policy.target_pct ? "target" : i === policy.sessions-1 ? "horizon" : null;
      if (!signal) continue;
      if (i+1 < n) { exitIndex = i+1; reason = signal; }
      else pendingExit = signal;
      break;
    }
  }
  const borrow = i => direction === "short" ? exposure * policy.borrow_apr * daysBetween(bars.dates[0],bars.dates[i])/365 : 0;
  const net = (p,i,closed) => exposure * sign * (p/entry-1) - exposure*cost - (closed ? exposure*(p/entry)*cost : 0) - borrow(i);
  const curve = [];
  let peak=base, drawdown=0;
  for (let i=0;i<n;i++) {
    const endpoint = complete && i === policy.sessions;
    const stockMark = endpoint ? bars.open[i] : bars.close[i];
    const spyMark = price(endpoint ? bars.spyOpen?.[i] : bars.spyClose?.[i]);
    const closed = exitIndex !== null && i >= exitIndex;
    const trade = trading ? base*(1+net(closed ? bars.open[exitIndex] : stockMark, closed ? exitIndex : i,closed)) : flat ? base : null;
    const benchmark = (p,start) => p && start ? base*(1+exposure*(p/start-1)-exposure*cost-(endpoint ? exposure*(p/start)*cost : 0)) : null;
    curve.push({d:bars.dates[i], trade, stock:benchmark(stockMark,entry), spy:benchmark(spyMark,spyEntry)});
    if (trade !== null) { peak=Math.max(peak,trade); drawdown=Math.min(drawdown,trade/peak-1); }
  }
  const last=curve[curve.length-1];
  const tradeReturn=trading && exitIndex !== null ? net(bars.open[exitIndex],exitIndex,true) : flat && complete ? 0 : null;
  const stockReturn=complete ? last.stock/base-1 : null;
  const spyReturn=complete && last.spy !== null ? last.spy/base-1 : null;
  return {base, policy, status:complete ? "complete" : "incomplete",
    decision_status:decision ? flat ? "abstained" : "recorded" : "unavailable",
    reason:complete ? null : "The selected observation horizon has not completed; open positions are marked, not treated as closed trades.",
    entry:{date:bars.dates[0],price:entry},
    exit:exitIndex === null ? null : {date:bars.dates[exitIndex],price:bars.open[exitIndex],reason},
    pending_exit:pendingExit, curve,
    stats:{trade_return:tradeReturn, stock_return:stockReturn, spy_return:spyReturn,
      excess_vs_spy:complete && tradeReturn !== null && spyReturn !== null ? tradeReturn-spyReturn : null,
      max_dd:trading || flat ? drawdown : null,
      marked_return:last.trade === null ? null : last.trade/base-1,
      costs_return:trading ? exposure*cost+(exitIndex === null ? 0 : exposure*(bars.open[exitIndex]/entry)*cost)+borrow(exitIndex ?? n-1) : 0},
    observation_end:bars.dates[n-1]};
}

module.exports = {replayPolicy, parseReplayDecision, replayMessages, simulateReplay};
