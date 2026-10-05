"use strict";

/*
 * Accounts and sync, exercised offline: the module takes db.query and fetch by injection,
 * so Postgres is replaced by an in-memory fake that dispatches on each statement's leading
 * tag comment, and Google's token endpoint by a function that returns a crafted id_token.
 */

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
  SYNC_STORES, loadConfig, signValue, verifySigned, hashToken, safeReturnPath, checkIdClaims,
  validateItem, parseCookies, createAccounts
} = require("../../auth-sync");

const ENV = {
  DATABASE_URL: "postgres://x", GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "csecret", SQUALL_SESSION_SECRET: "s".repeat(64),
  SQUALL_PUBLIC_URL: "https://squall.test"
};
const ORIGIN = "https://squall.test";

function fakeDb() {
  const st = { users: [], sessions: new Map(), items: new Map(), nextId: 1, calls: [] };
  const key = (u, s, i) => `${u}|${s}|${i}`;
  st.query = async (sql, p = []) => {
    const tag = (String(sql).match(/^\/\*([a-z.]+)\*\//) || [])[1];
    st.calls.push(tag);
    switch (tag) {
      case "schema": return { rows: [] };
      case "users.upsert": {
        let u = st.users.find(x => x.google_sub === p[0]);
        if (!u) { u = { id: String(st.nextId++), google_sub: p[0] }; st.users.push(u); }
        Object.assign(u, { email: p[1], name: p[2], picture: p[3] });
        return { rows: [{ id: u.id }] };
      }
      case "users.delete": {
        const id = String(p[0]);
        st.users = st.users.filter(u => u.id !== id);
        for (const [h, s] of st.sessions) if (s.user_id === id) st.sessions.delete(h);
        for (const [k, it] of st.items) if (it.user_id === id) st.items.delete(k);
        return { rows: [] };
      }
      case "sessions.insert": st.sessions.set(p[0], { user_id: String(p[1]), expires: p[2] }); return { rows: [] };
      case "sessions.sweep": for (const [h, s] of st.sessions) if (s.expires < p[0]) st.sessions.delete(h); return { rows: [] };
      case "sessions.lookup": {
        const s = st.sessions.get(p[0]);
        if (!s || s.expires <= p[1]) return { rows: [] };
        const u = st.users.find(x => x.id === s.user_id);
        return { rows: [{ user_id: s.user_id, expires_ms: String(s.expires), email: u.email, name: u.name, picture: u.picture }] };
      }
      case "sessions.renew": { const s = st.sessions.get(p[0]); if (s) s.expires = p[1]; return { rows: [] }; }
      case "sessions.delete": st.sessions.delete(p[0]); return { rows: [] };
      case "items.all": return { rows: [...st.items.values()].filter(i => i.user_id === String(p[0]))
        .map(i => ({ store: i.store, item_id: i.item_id, data: JSON.parse(i.data), modified_at: String(i.modified_at) })) };
      case "items.usage": {
        let total = 0;
        for (const i of st.items.values()) if (i.user_id === String(p[0]) && !(i.store === p[1] && i.item_id === p[2])) total += i.bytes;
        return { rows: [{ total: String(total) }] };
      }
      case "items.upsert": st.items.set(key(p[0], p[1], p[2]),
        { user_id: String(p[0]), store: p[1], item_id: p[2], data: p[3], modified_at: p[4], bytes: p[5] }); return { rows: [] };
      case "items.delete": st.items.delete(key(p[0], p[1], p[2])); return { rows: [] };
      default: throw new Error("fake db: unknown statement " + tag);
    }
  };
  return st;
}

const jwt = claims => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

function harness({ env = ENV, claims = {}, tokenStatus = 200, clock } = {}) {
  const config = loadConfig(env);
  const db = fakeDb();
  let t = clock || 1_800_000_000_000;
  const lastToken = {};
  const fetchImpl = async (url, opts) => {
    lastToken.url = url; lastToken.body = new URLSearchParams(opts.body);
    return { ok: tokenStatus === 200, status: tokenStatus, json: async () => ({ id_token: jwt({
      iss: "https://accounts.google.com", aud: config.clientId, exp: Math.floor(t / 1000) + 3600,
      sub: "google-123", email: "a@b.c", email_verified: true, name: "Ada", nonce: lastToken.nonce, ...claims
    }) }) };
  };
  const log = { log() {}, warn() {} };
  const accounts = createAccounts({ config, db, fetchImpl, now: () => t, log });
  const jar = {};

  async function request(method, url, { body, headers = {}, cookies = true } = {}) {
    // A real Readable, like IncomingMessage: the body waits until the handler reads it.
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
    req.method = method; req.url = url;
    const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    req.headers = { ...(cookies && cookieHeader ? { cookie: cookieHeader } : {}), ...headers };
    const res = {
      status: 0, headers: {}, body: "", headersSent: false, removed: [],
      removeHeader(h) { this.removed.push(h); },
      writeHead(code, h) { this.status = code; this.headers = h || {}; this.headersSent = true; },
      end(b) { this.body = b ? String(b) : ""; }
    };
    const handled = await accounts.handle(req, res, "1.2.3.4");
    for (const c of [].concat(res.headers["Set-Cookie"] || [])) {
      const [pair, ...attrs] = c.split("; ");
      const [k, v] = pair.split("=");
      if (attrs.includes("Max-Age=0")) delete jar[k]; else jar[k] = v;
    }
    let json = null;
    try { json = JSON.parse(res.body); } catch (_) {}
    return { handled, status: res.status, headers: res.headers, json, res };
  }

  async function signIn(ret = "/screener?id=1") {
    const start = await request("GET", "/auth/google?return=" + encodeURIComponent(ret));
    const loc = new URL(start.headers.Location);
    lastToken.nonce = loc.searchParams.get("nonce");
    const cb = await request("GET", `/auth/google/callback?state=${loc.searchParams.get("state")}&code=abc`);
    return { start, loc, cb };
  }
  const write = (method, path, body, extra = {}) => request(method, path, {
    body, headers: { origin: ORIGIN, "x-squall-sync": "1", ...extra } });

  return { config, db, accounts, request, signIn, write, jar, lastToken,
    tick: ms => { t += ms; }, now: () => t };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

test("accounts: config needs all four secrets, honours the off switch, and never reads Host", () => {
  assert.equal(loadConfig(ENV).enabled, true);
  assert.equal(loadConfig(ENV).redirectUri, "https://squall.test/auth/google/callback");
  assert.equal(loadConfig({ ...ENV, SQUALL_ACCOUNTS: "off" }).enabled, false);
  for (const k of ["DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SQUALL_SESSION_SECRET"]) {
    const env = { ...ENV }; delete env[k];
    assert.equal(loadConfig(env).enabled, false, k);
  }
  const local = { ...ENV }; delete local.SQUALL_PUBLIC_URL;
  assert.equal(loadConfig({ ...local, PORT: "3271" }).publicUrl, "http://localhost:3271");
  assert.equal(loadConfig({ ...local, RAILWAY_ENVIRONMENT_NAME: "production" }).publicUrl, "https://squall.up.railway.app");
  assert.equal(loadConfig({ ...ENV, SQUALL_SYNC_ITEM_MAX_BYTES: "nonsense" }).limits.itemMaxBytes, 2097152);
});

test("accounts: signed cookies verify, and tampering or age breaks them", () => {
  const secret = "k".repeat(40);
  const v = signValue(secret, { s: "state" }, 1000);
  assert.equal(verifySigned(secret, v, 600000, 2000).s, "state");
  assert.equal(verifySigned("other".repeat(10), v, 600000, 2000), null);
  assert.equal(verifySigned(secret, v, 600000, 1000 + 600001), null);
  const [body, mac] = v.split(".");
  const forged = Buffer.from(JSON.stringify({ s: "evil", iat: 1000 })).toString("base64url");
  assert.equal(verifySigned(secret, forged + "." + mac, 600000, 2000), null);
  assert.equal(verifySigned(secret, body + "." + mac.slice(1), 600000, 2000), null);
  assert.equal(verifySigned(secret, undefined, 600000, 2000), null);
});

test("accounts: return paths stay on this site", () => {
  assert.equal(safeReturnPath("/screener?id=x"), "/screener?id=x");
  assert.equal(safeReturnPath("/?t=AAPL#frag"), "/?t=AAPL");
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil", "", null, "/a\nb", "/auth/google"])
    assert.equal(safeReturnPath(bad), "/", String(bad));
});

test("accounts: id_token claims are checked one by one", () => {
  const now = 1_800_000_000_000;
  const good = { iss: "https://accounts.google.com", aud: "cid", exp: now / 1000 + 60, nonce: "n",
                 email_verified: true, sub: "1" };
  const opts = { clientId: "cid", nonce: "n", now };
  assert.equal(checkIdClaims(good, opts), null);
  assert.equal(checkIdClaims({ ...good, iss: "https://evil" }, opts), "iss");
  assert.equal(checkIdClaims({ ...good, aud: "other" }, opts), "aud");
  assert.equal(checkIdClaims({ ...good, exp: now / 1000 - 1 }, opts), "exp");
  assert.equal(checkIdClaims({ ...good, nonce: "x" }, opts), "nonce");
  assert.equal(checkIdClaims({ ...good, email_verified: false }, opts), "email_verified");
  assert.equal(checkIdClaims({ ...good, sub: "" }, opts), "sub");
  assert.equal(checkIdClaims(null, opts), "claims");
});

test("accounts: items are validated by store, id and data kind", () => {
  assert.equal(validateItem("analyses", "BRK.B", {}), null);
  assert.equal(validateItem("analyses", "^GSPC", {}), null);
  assert.equal(validateItem("screens", "screen-abc", {}), null);
  assert.equal(validateItem("theme", "_", "noir"), null);
  assert.equal(validateItem("watchlist", "_", []), null);
  assert.equal(validateItem("profile", "_", {}), null);
  assert.equal(validateItem("nope", "_", {}), "store");
  assert.equal(validateItem("analyses", "_", {}), "id");
  assert.equal(validateItem("theme", "x", "noir"), "id");
  assert.equal(validateItem("analyses", "a/b", {}), "id");
  assert.equal(validateItem("watchlist", "_", {}), "data");
  assert.equal(validateItem("profile", "_", []), "data");
  assert.equal(validateItem("theme", "_", 5), "data");
  assert.deepEqual(parseCookies("a=1; b = 2;c=x=y"), { a: "1", b: "2", c: "x=y" });
});

// ── Routes ────────────────────────────────────────────────────────────────────

test("accounts: disabled or unready reports enabled:false and owns only /auth and /api", async () => {
  const off = harness({ env: { ...ENV, SQUALL_ACCOUNTS: "off" } });
  await off.accounts.ensureSchema();
  assert.deepEqual((await off.request("GET", "/api/me")).json, { enabled: false, user: null });
  assert.equal((await off.request("GET", "/auth/google")).status, 404);
  assert.equal((await off.request("GET", "/screener")).handled, false);
  const me = await off.request("GET", "/api/me");
  assert.ok(me.res.removed.includes("Access-Control-Allow-Origin"));
});

test("accounts: full Google sign-in sets a hashed session and returns to the page", async () => {
  const h = harness();
  await h.accounts.ensureSchema();
  assert.deepEqual((await h.request("GET", "/api/me")).json, { enabled: true, user: null });
  const { start, loc, cb } = await h.signIn("/screener?id=1");
  assert.equal(start.status, 302);
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("scope"), "openid email profile");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://squall.test/auth/google/callback");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.Location, "/screener?id=1#signed-in");
  assert.ok(h.jar.squall_sid && !h.jar.squall_oauth);
  // Only the hash is stored, never the cookie value.
  assert.ok(h.db.sessions.has(hashToken(h.jar.squall_sid)));
  assert.ok(![...h.db.sessions.keys()].includes(h.jar.squall_sid));
  assert.ok([].concat(cb.headers["Set-Cookie"]).some(c => /squall_sid=.*HttpOnly; SameSite=Lax; Secure/.test(c)));
  assert.equal(h.lastToken.body.get("code_verifier").length > 40, true);
  const me = (await h.request("GET", "/api/me")).json;
  assert.equal(me.user.email, "a@b.c");
});

test("accounts: a forged state, a bad claim or a failed token call never signs anyone in", async () => {
  const h = harness();
  await h.accounts.ensureSchema();
  // Everything else is valid (nonce included), so only the state check can stop this one.
  const start = await h.request("GET", "/auth/google?return=/");
  h.lastToken.nonce = new URL(start.headers.Location).searchParams.get("nonce");
  const cb = await h.request("GET", "/auth/google/callback?state=wrong&code=abc");
  assert.equal(cb.headers.Location, "/#signin-error");
  assert.ok(!h.jar.squall_sid);
  assert.equal(h.db.users.length, 0);

  const bad = harness({ claims: { aud: "someone-else" } });
  await bad.accounts.ensureSchema();
  assert.equal((await bad.signIn("/")).cb.headers.Location, "/#signin-error");
  assert.ok(!bad.jar.squall_sid);

  const unverified = harness({ claims: { email_verified: false } });
  await unverified.accounts.ensureSchema();
  assert.equal((await unverified.signIn("/")).cb.headers.Location, "/#signin-error");

  const down = harness({ tokenStatus: 500 });
  await down.accounts.ensureSchema();
  assert.equal((await down.signIn("/")).cb.headers.Location, "/#signin-error");
  assert.equal(down.db.users.length, 0);
});

test("accounts: sign-in starts are rate limited per IP", async () => {
  const h = harness({ env: { ...ENV, SQUALL_AUTH_IP_HOURLY: "2" } });
  await h.accounts.ensureSchema();
  await h.request("GET", "/auth/google?return=/");
  await h.request("GET", "/auth/google?return=/");
  assert.equal((await h.request("GET", "/auth/google?return=/")).headers.Location, "/#signin-limited");
});

test("accounts: sync round trip, and writes require same origin plus the custom header", async () => {
  const h = harness();
  await h.accounts.ensureSchema();
  assert.equal((await h.request("GET", "/api/sync")).status, 401);
  await h.signIn();
  assert.equal((await h.write("PUT", "/api/sync/analyses/AAPL", { data: { x: 1 }, modifiedAt: 5 })).status, 200);
  assert.equal((await h.write("PUT", "/api/sync/theme/_", { data: "paper", modifiedAt: 6 })).status, 200);
  const all = (await h.request("GET", "/api/sync")).json;
  assert.deepEqual(all.items.sort((a, b) => a.store.localeCompare(b.store)), [
    { store: "analyses", id: "AAPL", data: { x: 1 }, modifiedAt: 5 },
    { store: "theme", id: "_", data: "paper", modifiedAt: 6 }]);
  assert.equal((await h.write("DELETE", "/api/sync/analyses/AAPL")).status, 200);
  assert.equal((await h.request("GET", "/api/sync")).json.items.length, 1);

  // Cross-site attempts: wrong origin, missing header, no origin at all.
  assert.equal((await h.write("PUT", "/api/sync/theme/_", { data: "noir", modifiedAt: 7 }, { origin: "https://evil.com" })).status, 403);
  assert.equal((await h.request("PUT", "/api/sync/theme/_", { body: { data: "noir", modifiedAt: 7 }, headers: { origin: ORIGIN } })).status, 403);
  assert.equal((await h.request("DELETE", "/api/account", { headers: { "x-squall-sync": "1" } })).status, 403);
  assert.equal((await h.request("POST", "/auth/logout", {})).status, 403);
  // Bad store, id or data shape.
  assert.equal((await h.write("PUT", "/api/sync/bogus/_", { data: {}, modifiedAt: 1 })).status, 400);
  assert.equal((await h.write("PUT", "/api/sync/watchlist/_", { data: {}, modifiedAt: 1 })).status, 400);
  assert.equal((await h.write("PUT", "/api/sync/watchlist/_", "not json")).status, 400);
});

test("accounts: item size, account quota and write rate are capped", async () => {
  const h = harness({ env: { ...ENV, SQUALL_SYNC_ITEM_MAX_BYTES: "200", SQUALL_SYNC_USER_MAX_BYTES: "300",
                              SQUALL_SYNC_WRITES_PER_MIN: "6" } });
  await h.accounts.ensureSchema();
  await h.signIn();
  const big = await h.write("PUT", "/api/sync/analyses/AAPL", { data: { s: "x".repeat(500) }, modifiedAt: 1 });
  assert.equal(big.status, 413); assert.equal(big.json.code, "too_large");
  assert.equal((await h.write("PUT", "/api/sync/analyses/A", { data: { s: "x".repeat(150) }, modifiedAt: 1 })).status, 200);
  // Rewriting the same item doesn't count its old size against the quota.
  assert.equal((await h.write("PUT", "/api/sync/analyses/A", { data: { s: "y".repeat(150) }, modifiedAt: 2 })).status, 200);
  const full = await h.write("PUT", "/api/sync/analyses/B", { data: { s: "x".repeat(150) }, modifiedAt: 1 });
  assert.equal(full.status, 413); assert.equal(full.json.code, "quota");
  await h.write("DELETE", "/api/sync/analyses/B");
  await h.write("DELETE", "/api/sync/analyses/C");
  assert.equal((await h.write("DELETE", "/api/sync/analyses/D")).status, 429);
  h.tick(60000);
  assert.equal((await h.write("DELETE", "/api/sync/analyses/D")).status, 200);
});

test("accounts: sessions renew near expiry and expire after 30 days", async () => {
  const h = harness();
  await h.accounts.ensureSchema();
  await h.signIn();
  const first = h.jar.squall_sid;
  const me1 = await h.request("GET", "/api/me");
  assert.equal(me1.headers["Set-Cookie"], undefined);
  h.tick(16 * 86400000);
  const me2 = await h.request("GET", "/api/me");
  assert.ok([].concat(me2.headers["Set-Cookie"]).some(c => c.startsWith("squall_sid=" + first)));
  h.tick(29 * 86400000);
  assert.ok((await h.request("GET", "/api/me")).json.user);
  h.tick(31 * 86400000);
  assert.equal((await h.request("GET", "/api/me")).json.user, null);
});

test("accounts: sign-out kills the session; account deletion removes every row", async () => {
  const h = harness();
  await h.accounts.ensureSchema();
  await h.signIn();
  const sid = h.jar.squall_sid;
  assert.equal((await h.write("POST", "/auth/logout")).status, 200);
  assert.ok(!h.jar.squall_sid);
  assert.equal(h.db.sessions.size, 0);
  h.jar.squall_sid = sid;
  assert.equal((await h.request("GET", "/api/sync")).status, 401);

  await h.signIn();
  await h.write("PUT", "/api/sync/analyses/AAPL", { data: { x: 1 }, modifiedAt: 5 });
  await h.write("PUT", "/api/sync/portfolio/_", { data: [], modifiedAt: 5 });
  assert.equal((await h.write("DELETE", "/api/account")).status, 200);
  assert.equal(h.db.users.length, 0);
  assert.equal(h.db.items.size, 0);
  assert.equal(h.db.sessions.size, 0);
  assert.ok(!h.jar.squall_sid);
});

test("accounts: a database failure answers 503 and never throws out of the handler", async () => {
  const h = harness();
  await h.accounts.ensureSchema();
  await h.signIn();
  h.db.query = async () => { throw new Error("connection refused"); };
  assert.equal((await h.request("GET", "/api/sync")).status, 503);
  assert.deepEqual((await h.request("GET", "/api/me")).json, { enabled: false, user: null });
});

test("accounts: SYNC_STORES is the six synced stores", () => {
  assert.deepEqual(SYNC_STORES, ["analyses", "screens", "profile", "theme", "watchlist", "portfolio"]);
});
