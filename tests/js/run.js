"use strict";

const tests = [];

global.test = (name, fn) => tests.push({ name, fn });

require("./server.test");
require("./backtester.test");
require("./app.test");

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} JavaScript tests passed`);
if (failed) process.exitCode = 1;

module.exports = { total: tests.length, passed: tests.length - failed, failed };
