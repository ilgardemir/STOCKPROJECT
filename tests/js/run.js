"use strict";

const tests = [];

global.test = (name, fn) => tests.push({ name, fn });

require("./server.test");
require("./backtester.test");
require("./app.test");
require("./replay.test");

/*
 * The loop AWAITS fn(). It used to call it bare, which meant an async test could only
 * ever print "ok": the assertion rejected a promise nobody held, so the failure surfaced
 * as an unhandled rejection after the summary line had already claimed a pass. A test
 * that cannot fail is worse than no test, and stream-failsafe.test.js grew its own
 * runner to work around exactly this.
 */
(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} JavaScript tests passed`);
  if (failed) process.exitCode = 1;
})();
