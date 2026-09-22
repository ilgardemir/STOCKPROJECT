"use strict";
// Explicit, bounded production smoke checks. Each selected engine makes one request.
const assert = require("node:assert/strict");
const {simulateReplay} = require("../replay-engine");
const base = process.env.SQUALL_VERIFY_URL || "https://squall.up.railway.app";
async function stream(path) {
  const response = await fetch(base+path,{signal:AbortSignal.timeout(300000)});
  assert.equal(response.status,200);
  const events = {};
  let buf="";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk,{stream:true});
    let cut;
    while ((cut=buf.indexOf("\n\n"))>=0) {
      const frame=buf.slice(0,cut);buf=buf.slice(cut+2);
      const event=/^event: (.+)$/m.exec(frame)?.[1], data=/^data: (.+)$/m.exec(frame)?.[1];
      if (event && data) {
        const value=JSON.parse(data);
        if (!event.endsWith("_delta") && !event.endsWith("_thinking")) events[event]=value;
        if (event.includes("error")) console.log(JSON.stringify({event,...value}));
      }
    }
  }
  return events;
}
async function main() {
  for (const file of ["/server.js","/CLAUDE.md","/financial_rules.py","/replay-engine.js"]) {
    const response=await fetch(base+file,{signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,404,file);await response.arrayBuffer();
  }
  console.log("Internal files: 404");
  if (process.argv.includes("--finance")) {
    const events=await stream("/analyze-stream?ticker=JPM");
    const d=events.result;
    assert.ok(d,"Analyzer returned no payload");
    assert.equal(d.financial_model,"financial");
    assert.ok(!Object.hasOwn(d.market_regime,"confidence"));
    assert.equal(d.raw_data.financial_health.current_ratio,null);
    assert.equal(d.raw_data.valuation.fcf_yield,null);
    assert.ok(d.live_quote.bid === null || d.live_quote.bid > 0);
    assert.ok(events.ai_done,"Written analysis did not finish");
    console.log(JSON.stringify({analyzer:"passed",model:d.financial_model,quote:d.live_quote.quote_time,
      separation:d.market_regime.separation,answer_chars:events.ai_done.aiSummary?.length,reasoning_chars:events.ai_done.aiReasoning?.length}));
    const screen=await stream("/screen-stream?universe=dow30&q="+encodeURIComponent("High quality companies"));
    assert.ok(screen.screen_result,"Screener returned no result");
    assert.ok(screen.screen_result.coverage);
    console.log(JSON.stringify({screener:screen.screen_result.universe_scored > 0 ? "populated_response" : "market_data_unavailable",
      universe_scored:screen.screen_result.universe_scored,universe_requested:screen.screen_result.universe_requested,
      throttled:screen.screen_result.throttled,coverage:screen.screen_result.coverage,matches:screen.screen_result.results.length}));
  }
  if (process.argv.includes("--replay")) {
    const events=await stream("/backtest-stream?ticker=JPM&as_of=2024-06-03&horizon=1m");
    assert.ok(events.backtest_done);
    const result=events.backtest_outcomes;
    assert.equal(result.audit.policy.version,"replay-v2");
    assert.ok(result.audit.decision,"Live model did not supply a valid structured decision");
    assert.deepEqual(simulateReplay(result.audit.decision,result.audit.bars,result.audit.policy),result.simulation);
    assert.equal(result.simulation.status,"complete");
    console.log(JSON.stringify({replay:"passed",decision:result.audit.decision.direction,stats:result.simulation.stats,
      answer_chars:result.audit.answer?.length,reasoning_chars:events.backtest_ai_done?.aiReasoning?.length,
      run_id:result.audit.run_id,reproduced:true}));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
