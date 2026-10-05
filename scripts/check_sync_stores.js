#!/usr/bin/env node
"use strict";
/*
 * Contract check: the synced-store list is written twice, in auth-sync.js (what the server
 * accepts) and in app.js (what the browser sends). A store present on one side only fails
 * silently: the browser's writes are rejected with a 400, or the server never hears of it.
 * app.js's copy is also checked against SYNC_KEYS, so every store has a localStorage key.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { SYNC_STORES: server } = require(path.join(ROOT, "auth-sync.js"));
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

const listMatch = app.match(/const SYNC_STORES = \[([^\]]*)\]/);
const keysMatch = app.match(/const SYNC_KEYS = \{([\s\S]*?)\};/);
const fail = msg => { console.error(`check_sync_stores: ${msg}`); process.exit(1); };
if (!listMatch) fail("SYNC_STORES not found in app.js");
if (!keysMatch) fail("SYNC_KEYS not found in app.js");

const client = [...listMatch[1].matchAll(/"([a-z]+)"/g)].map(m => m[1]);
const keyed = [...keysMatch[1].matchAll(/([a-z]+)\s*:/g)].map(m => m[1]);

if (JSON.stringify(client) !== JSON.stringify(server))
  fail(`app.js SYNC_STORES ${JSON.stringify(client)} != auth-sync.js ${JSON.stringify(server)}`);
const unkeyed = client.filter(s => !keyed.includes(s));
if (unkeyed.length) fail(`no SYNC_KEYS entry in app.js for: ${unkeyed.join(", ")}`);
console.log(`check_sync_stores: ok (${client.length} stores)`);
