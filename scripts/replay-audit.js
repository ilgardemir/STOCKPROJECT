"use strict";
// Offline accounting reproduction; never regenerates or replaces the AI decision.
const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const {replayPolicy,parseReplayDecision,simulateReplay} = require("../replay-engine");
if (!process.argv[2]) throw new Error("Usage: node scripts/replay-audit.js exported-run.json");
const audit = JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const sha = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
assert.equal(sha(audit.snapshot),audit.snapshot_sha256,"Snapshot hash mismatch");
assert.equal(sha(audit.messages),audit.input_sha256,"Prompt hash mismatch");
assert.deepEqual(audit.policy,replayPolicy(audit.policy.horizon),"Unknown or modified policy");
const decision = parseReplayDecision(audit.answer,audit.policy);
assert.deepEqual(decision,audit.decision,"Decision differs from recorded answer");
const simulation = simulateReplay(decision,audit.bars,audit.policy);
assert.deepEqual(simulation,audit.simulation,"Simulation does not reproduce");
console.log(JSON.stringify({run_id:audit.run_id,reproduced:true,status:simulation.status,stats:simulation.stats},null,2));
