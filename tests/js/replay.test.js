"use strict";
const assert = require("node:assert/strict");
const {replayPolicy,parseReplayDecision,replayMessages,simulateReplay} = require("../../replay-engine");
const policy = replayPolicy("1m");
const decision = direction => parseReplayDecision(`<replay_decision>${JSON.stringify({direction,thesis:"Fixture decision"})}</replay_decision>`,policy);
function bars(n=22) {
  return {basis:"split_adjusted_price",dates:Array.from({length:n},(_,i)=>new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10)),
    open:Array(n).fill(100),close:Array(n).fill(100),spyOpen:Array(n).fill(200),spyClose:Array(n).fill(200)};
}
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-10, `${a} != ${b}`);

test("replay v2 accepts abstention but never invents a missing or ambiguous decision", () => {
  assert.equal(decision("flat").position_pct,0);
  assert.equal(parseReplayDecision("Buy perhaps",policy),null);
  assert.equal(parseReplayDecision('<replay_decision>{"direction":"buy","thesis":"x"}</replay_decision>',policy),null);
  assert.equal(parseReplayDecision('<replay_decision>{"direction":"long","thesis":"x"}</replay_decision>'.repeat(2),policy),null);
  assert.equal(decision("short").position_pct,.25);
  assert.throws(()=>replayPolicy("tomorrow"));
});
test("replay policy uses fixed costs and matches benchmark exposure", () => {
  const b=bars(); b.open[21]=110; b.spyOpen[21]=220;
  const result=simulateReplay(decision("long"),b,policy);
  near(result.stats.trade_return,.25*.1-.25*.001-.25*1.1*.001);
  near(result.stats.trade_return,result.stats.stock_return);
  near(result.stats.excess_vs_spy,0);
  assert.equal(result.exit.date,b.dates[21]);
  assert.equal(result.exit.reason,"horizon");
});
test("close-based stop fills at the next open even through a gap", () => {
  const b=bars(); b.close[1]=90; b.open[2]=70;
  const r=simulateReplay(decision("long"),b,policy);
  assert.equal(r.exit.price,70);
  assert.equal(r.exit.reason,"stop");
  near(r.stats.trade_return,.25*(-.30)-.25*.001-.25*.7*.001);
  assert.ok(r.stats.trade_return < -.25*policy.stop_pct);
});
test("a target exits rather than activating a tuned trailing rule", () => {
  const b=bars(); b.close[0]=117; b.open[1]=114;
  const r=simulateReplay(decision("long"),b,policy);
  assert.equal(r.exit.reason,"target"); assert.equal(r.exit.price,114);
});
test("an incomplete replay never fabricates a last-close exit or full-period return", () => {
  const b=bars(2);b.close[1]=90;
  const r=simulateReplay(decision("long"),b,policy);
  assert.equal(r.status,"incomplete");assert.equal(r.exit,null);
  assert.equal(r.pending_exit,"stop");assert.equal(r.stats.trade_return,null);
  assert.equal(r.stats.spy_return,null);assert.ok(r.stats.marked_return<0);
});
test("missing opens and incorrect price basis fail closed", () => {
  const b=bars();b.open[2]=null;
  assert.equal(simulateReplay(decision("long"),b,policy).status,"unavailable");
  assert.equal(simulateReplay(decision("long"),{...bars(),basis:"total_return"},policy).status,"unavailable");
});
test("short borrowing is charged by elapsed calendar days on initial notional", () => {
  const r=simulateReplay(decision("short"),bars(),policy);
  near(r.stats.trade_return,-.25*.001*2-.25*.03*21/365);
});
test("flat is cash and a failed response is unavailable, not cash", () => {
  const flat=simulateReplay(decision("flat"),bars(),policy);
  near(flat.stats.trade_return,0);assert.equal(flat.decision_status,"abstained");
  const failed=simulateReplay(null,bars(),policy);
  assert.equal(failed.stats.trade_return,null);assert.equal(failed.curve[0].trade,null);
  assert.equal(failed.decision_status,"unavailable");
});
test("post-horizon bars cannot change a simulation", () => {
  const b=bars(30);const first=simulateReplay(decision("long"),b,policy);
  b.open[25]=9999;b.close[25]=1;
  assert.deepEqual(simulateReplay(decision("long"),b,policy),first);
});
test("replay messages contain only the supplied snapshot and locked policy", () => {
  const messages=replayMessages("snapshot fixture",policy);
  assert.match(messages[0].content,/flat is valid/);
  assert.doesNotMatch(JSON.stringify(messages),/forced-choice|conviction scales|direction_guardrails/);
});
