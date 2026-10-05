"use strict";
/*
 * Accounts and cross-device sync: Google sign-in, sessions, and per-item storage of the
 * stores the browser already keeps in localStorage.
 *
 * Everything that touches the outside world is injected — `db.query(sql, params)` and
 * `fetchImpl` — so the whole module runs offline in tests against a fake. server.js
 * passes a pg.Pool and the global fetch. Spec: docs/superpowers/specs/2026-10-05-accounts-sync-design.md
 *
 * Accounts are optional and must never take the rest of the site down with them: when
 * they are switched off, misconfigured, or the database is unreachable, /api/me answers
 * {enabled:false} and every other route on the site behaves exactly as before.
 */
const crypto = require("crypto");

// Mirrored in app.js (ACCOUNT SYNC). scripts/check_sync_stores.js fails on drift.
const SYNC_STORES = ["analyses", "screens", "profile", "theme", "watchlist", "portfolio"];
const MULTI_STORES = new Set(["analyses", "screens"]);
const STORE_KIND = { analyses: "object", screens: "object", profile: "object",
                     theme: "string", watchlist: "array", portfolio: "array" };
// Analyses are keyed by ticker (BRK.B, ^GSPC, EURUSD=X), screens by "screen-<base36>".
// Single-row stores use the id "_".
const ITEM_ID_RE = /^[A-Za-z0-9._^=-]{1,80}$/;
const SINGLE_ID = "_";

const DAY_MS = 86400000;
const SESSION_MS = 30 * DAY_MS;
const RENEW_UNDER_MS = 15 * DAY_MS;
const OAUTH_STATE_MS = 600000;
const TOKEN_TIMEOUT_MS = 10000;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

// ── Config ────────────────────────────────────────────────────────────────────
function intEnv(env, name, def) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/**
 * The redirect URI is built from SQUALL_PUBLIC_URL and never from the request's Host
 * header, so a forged Host cannot steer Google's code to another origin.
 */
function loadConfig(rawEnv = process.env) {
  // Values pasted into a dashboard often carry a trailing newline or space, and Google
  // rejects a client id with one as "OAuth client was not found". Trim everything we read.
  const env = {};
  for (const k of Object.keys(rawEnv)) env[k] = typeof rawEnv[k] === "string" ? rawEnv[k].trim() : rawEnv[k];
  const deployed = env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT
    || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);
  const publicUrl = String(env.SQUALL_PUBLIC_URL
    || (deployed ? "https://squall.up.railway.app" : `http://localhost:${env.PORT || 3000}`)).replace(/\/+$/, "");
  let origin = null;
  try { origin = new URL(publicUrl).origin; } catch (_) {}
  const missing = ["DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SQUALL_SESSION_SECRET"]
    .filter(k => !env[k]);
  const off = String(env.SQUALL_ACCOUNTS || "").trim().toLowerCase() === "off";
  return {
    enabled: !off && !missing.length && Boolean(origin),
    reason: off ? "SQUALL_ACCOUNTS=off" : missing.length ? "missing " + missing.join(", ")
      : !origin ? "invalid SQUALL_PUBLIC_URL" : "",
    publicUrl, origin, secure: publicUrl.startsWith("https:"),
    redirectUri: publicUrl + "/auth/google/callback",
    databaseUrl: env.DATABASE_URL || "",
    clientId: env.GOOGLE_CLIENT_ID || "", clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    secret: env.SQUALL_SESSION_SECRET || "",
    limits: {
      authIpHourly: intEnv(env, "SQUALL_AUTH_IP_HOURLY", 20),
      writesPerMin: intEnv(env, "SQUALL_SYNC_WRITES_PER_MIN", 120),
      itemMaxBytes: intEnv(env, "SQUALL_SYNC_ITEM_MAX_BYTES", 2097152),
      userMaxBytes: intEnv(env, "SQUALL_SYNC_USER_MAX_BYTES", 26214400)
    }
  };
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
const b64url = buf => Buffer.from(buf).toString("base64url");
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const hashToken = token => crypto.createHash("sha256").update(String(token)).digest("hex");

/** HMAC-signed, timestamped JSON for the short-lived OAuth cookie. */
function signValue(secret, obj, now = Date.now()) {
  const body = b64url(JSON.stringify({ ...obj, iat: now }));
  const mac = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return body + "." + mac;
}
function verifySigned(secret, value, maxAgeMs, now = Date.now()) {
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const body = value.slice(0, dot), mac = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(b64url(crypto.createHmac("sha256", secret).update(body).digest()));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (_) { return null; }
  if (!obj || typeof obj !== "object" || !Number.isFinite(obj.iat)) return null;
  if (now - obj.iat > maxAgeMs || obj.iat - now > 60000) return null;
  return obj;
}

// ── Validation ────────────────────────────────────────────────────────────────
/** Only a same-site path survives; anything that could leave the site becomes "/". */
function safeReturnPath(value) {
  const s = String(value == null ? "" : value).split("#")[0];
  if (!s.startsWith("/") || s.startsWith("//") || s.length > 512) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  if (s.startsWith("/auth/")) return "/";
  return s;
}

/** null when the claims are acceptable, otherwise a short reason code for the log. */
function checkIdClaims(claims, { clientId, nonce, now = Date.now() }) {
  if (!claims || typeof claims !== "object") return "claims";
  if (!GOOGLE_ISSUERS.has(claims.iss)) return "iss";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) return "aud";
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return "exp";
  if (!nonce || claims.nonce !== nonce) return "nonce";
  if (claims.email_verified !== true && claims.email_verified !== "true") return "email_verified";
  if (typeof claims.sub !== "string" || !claims.sub) return "sub";
  return null;
}

/**
 * The id_token arrives directly from Google's token endpoint over TLS, so per OIDC Core
 * §3.1.3.7 its signature need not be re-verified; the claims still are (checkIdClaims).
 */
function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch (_) { return null; }
}

function validateItem(store, id, data) {
  if (!SYNC_STORES.includes(store)) return "store";
  if (typeof id !== "string" || !ITEM_ID_RE.test(id)) return "id";
  if (MULTI_STORES.has(store) ? id === SINGLE_ID : id !== SINGLE_ID) return "id";
  const kind = STORE_KIND[store];
  const ok = kind === "array" ? Array.isArray(data)
    : kind === "string" ? typeof data === "string" && data.length <= 64
    : data !== null && typeof data === "object" && !Array.isArray(data);
  return ok ? null : "data";
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i < 1) return;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  });
  return out;
}

// ── Schema ────────────────────────────────────────────────────────────────────
// item_id is "_" for single-row stores. modified_at is the client's modification time
// in ms, which is what merges compare; bytes backs the per-user quota.
const SCHEMA_SQL = `/*schema*/
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT, name TEXT, picture TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_items (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store TEXT NOT NULL,
  item_id TEXT NOT NULL,
  data JSONB NOT NULL,
  modified_at BIGINT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (user_id, store, item_id)
);`;

// Each statement carries a leading tag so the test fake can dispatch on it.
const SQL = {
  userUpsert: `/*users.upsert*/ INSERT INTO users (google_sub, email, name, picture) VALUES ($1, $2, $3, $4)
    ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
    RETURNING id`,
  userDelete: `/*users.delete*/ DELETE FROM users WHERE id = $1`,
  sessionInsert: `/*sessions.insert*/ INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
  sessionSweep: `/*sessions.sweep*/ DELETE FROM sessions WHERE expires_at < to_timestamp($1 / 1000.0)`,
  sessionLookup: `/*sessions.lookup*/ SELECT s.user_id, (extract(epoch FROM s.expires_at) * 1000)::bigint AS expires_ms,
    u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > to_timestamp($2 / 1000.0)`,
  sessionRenew: `/*sessions.renew*/ UPDATE sessions SET expires_at = to_timestamp($2 / 1000.0) WHERE token_hash = $1`,
  sessionDelete: `/*sessions.delete*/ DELETE FROM sessions WHERE token_hash = $1`,
  itemsAll: `/*items.all*/ SELECT store, item_id, data, modified_at FROM user_items WHERE user_id = $1`,
  itemsUsage: `/*items.usage*/ SELECT COALESCE(SUM(bytes), 0)::bigint AS total FROM user_items
    WHERE user_id = $1 AND NOT (store = $2 AND item_id = $3)`,
  itemUpsert: `/*items.upsert*/ INSERT INTO user_items (user_id, store, item_id, data, modified_at, bytes)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    ON CONFLICT (user_id, store, item_id) DO UPDATE SET data = EXCLUDED.data, modified_at = EXCLUDED.modified_at, bytes = EXCLUDED.bytes`,
  itemDelete: `/*items.delete*/ DELETE FROM user_items WHERE user_id = $1 AND store = $2 AND item_id = $3`
};

// ── Route handler ─────────────────────────────────────────────────────────────
function createAccounts({ config, db, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
  let ready = false;
  const authHits = new Map();   // ip → { hour, n }
  const writeHits = new Map();  // userId → { minute, n }

  async function ensureSchema() {
    if (!config.enabled || !db) { ready = false; return false; }
    await db.query(SCHEMA_SQL);
    ready = true;
    return true;
  }

  function hit(map, key, windowId, max) {
    if (map.size > 10000) for (const [k, v] of map) if (v.w !== windowId) map.delete(k);
    const cur = map.get(key);
    if (!cur || cur.w !== windowId) { map.set(key, { w: windowId, n: 1 }); return true; }
    if (cur.n >= max) return false;
    cur.n += 1;
    return true;
  }

  const cookieAttrs = maxAgeS => `Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`;
  const sessionCookie = (token, ms) => `squall_sid=${token}; ${cookieAttrs(Math.floor(ms / 1000))}`;
  const clearSession = `squall_sid=; ${cookieAttrs(0)}`;
  const oauthCookie = value => `squall_oauth=${value}; Path=/auth; Max-Age=${OAUTH_STATE_MS / 1000}; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`;
  const clearOauth = `squall_oauth=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`;

  function send(res, status, body, cookies) {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (cookies && cookies.length) headers["Set-Cookie"] = cookies;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
  function redirect(res, location, cookies) {
    const headers = { Location: location, "Cache-Control": "no-store" };
    if (cookies && cookies.length) headers["Set-Cookie"] = cookies;
    res.writeHead(302, headers);
    res.end();
  }

  /** Same-origin proof for every state-changing route: Origin plus a custom header. */
  const sameOrigin = req => req.headers.origin === config.origin && req.headers["x-squall-sync"] === "1";

  async function currentSession(req) {
    const token = parseCookies(req.headers.cookie).squall_sid;
    if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const hash = hashToken(token);
    const t = now();
    const { rows } = await db.query(SQL.sessionLookup, [hash, t]);
    if (!rows.length) return null;
    const row = rows[0];
    const out = { hash, userId: String(row.user_id),
                  user: { email: row.email || "", name: row.name || "", picture: row.picture || "" }, cookies: [] };
    if (Number(row.expires_ms) - t < RENEW_UNDER_MS) {
      await db.query(SQL.sessionRenew, [hash, t + SESSION_MS]);
      out.cookies.push(sessionCookie(token, SESSION_MS));
    }
    return out;
  }

  function readJson(req, maxBytes) {
    return new Promise(resolve => {
      let size = 0, done = false;
      const chunks = [];
      const finish = v => { if (!done) { done = true; resolve(v); } };
      req.on("data", c => {
        if (done) return;
        size += c.length;
        if (size > maxBytes) { finish({ tooLarge: true }); req.resume(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (done) return;
        try { finish({ value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (_) { finish({ bad: true }); }
      });
      req.on("error", () => finish({ bad: true }));
      req.on("aborted", () => finish({ bad: true }));
    });
  }

  async function startSignIn(req, res, url, ip) {
    const ret = safeReturnPath(url.searchParams.get("return"));
    if (!hit(authHits, ip, Math.floor(now() / 3600000), config.limits.authIpHourly))
      return redirect(res, ret + "#signin-limited");
    const state = randomToken(24), verifier = randomToken(48), nonce = randomToken(24);
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
      scope: "openid email profile", state, nonce, code_challenge: challenge,
      code_challenge_method: "S256", prompt: "select_account"
    });
    redirect(res, `${GOOGLE_AUTH_URL}?${params}`,
      [oauthCookie(signValue(config.secret, { s: state, v: verifier, n: nonce, r: ret }, now()))]);
  }

  async function finishSignIn(req, res, url) {
    const st = verifySigned(config.secret, parseCookies(req.headers.cookie).squall_oauth, OAUTH_STATE_MS, now());
    const ret = st ? safeReturnPath(st.r) : "/";
    const fail = reason => {
      log.warn(`AUTH|signin_failed|${reason}`);
      redirect(res, ret + "#signin-error", [clearOauth]);
    };
    const q = url.searchParams;
    if (!st || !q.get("state") || q.get("state") !== st.s) return fail("state");
    if (q.get("error")) return fail("google_" + String(q.get("error")).slice(0, 40).replace(/[^a-z_]/gi, ""));
    const code = q.get("code");
    if (!code) return fail("no_code");

    let tokenJson;
    try {
      const r = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: config.clientId, client_secret: config.clientSecret,
          redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: st.v
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
      });
      if (!r.ok) return fail("token_http_" + r.status);
      tokenJson = await r.json();
    } catch (_) { return fail("token_fetch"); }

    const claims = decodeJwtPayload(tokenJson && tokenJson.id_token);
    const bad = checkIdClaims(claims, { clientId: config.clientId, nonce: st.n, now: now() });
    if (bad) return fail("claim_" + bad);

    const t = now();
    const clip = (v, n) => typeof v === "string" ? v.slice(0, n) : null;
    const { rows } = await db.query(SQL.userUpsert,
      [claims.sub, clip(claims.email, 320), clip(claims.name, 200), clip(claims.picture, 1000)]);
    await db.query(SQL.sessionSweep, [t]);
    const token = randomToken(32);
    await db.query(SQL.sessionInsert, [hashToken(token), rows[0].id, t + SESSION_MS]);
    log.log(`AUTH|signin|user=${rows[0].id}`);
    redirect(res, ret + "#signed-in", [clearOauth, sessionCookie(token, SESSION_MS)]);
  }

  async function putItem(req, res, sess, store, id) {
    if (!hit(writeHits, sess.userId, Math.floor(now() / 60000), config.limits.writesPerMin))
      return send(res, 429, { error: "Too many sync writes, slow down.", code: "rate" });
    const body = await readJson(req, config.limits.itemMaxBytes + 1024);
    if (body.tooLarge) return send(res, 413, { error: "This item is too large to sync.", code: "too_large" });
    if (body.bad || !body.value || typeof body.value !== "object") return send(res, 400, { error: "Bad request." });
    const { data } = body.value;
    const modifiedAt = Number(body.value.modifiedAt);
    const invalid = validateItem(store, id, data);
    if (invalid || !Number.isFinite(modifiedAt) || modifiedAt <= 0)
      return send(res, 400, { error: "Bad request.", code: invalid || "modifiedAt" });
    const json = JSON.stringify(data);
    const bytes = Buffer.byteLength(json);
    if (bytes > config.limits.itemMaxBytes) return send(res, 413, { error: "This item is too large to sync.", code: "too_large" });
    const { rows } = await db.query(SQL.itemsUsage, [sess.userId, store, id]);
    if (Number(rows[0] && rows[0].total) + bytes > config.limits.userMaxBytes)
      return send(res, 413, { error: "Your account's sync storage is full.", code: "quota" });
    await db.query(SQL.itemUpsert, [sess.userId, store, id, json, Math.floor(modifiedAt), bytes]);
    send(res, 200, { ok: true }, sess.cookies);
  }

  /** Returns false for paths this module does not own, so server.js can fall through. */
  async function handle(req, res, ip) {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    if (!p.startsWith("/auth/") && !p.startsWith("/api/")) return false;
    // server.js sets a wildcard CORS header on every response; none of these routes may carry it.
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Headers");
    const m = req.method;

    if (m === "GET" && p === "/api/me") {
      if (!ready) { send(res, 200, { enabled: false, user: null }); return true; }
      try {
        const sess = await currentSession(req);
        send(res, 200, { enabled: true, user: sess ? { id: sess.userId, ...sess.user } : null }, sess && sess.cookies);
      } catch (e) {
        log.warn(`AUTH|db_error|me|${e && e.message}`);
        send(res, 200, { enabled: false, user: null });
      }
      return true;
    }

    if (!ready) { send(res, config.enabled ? 503 : 404, { error: "Accounts are not available." }); return true; }

    try {
      if (m === "GET" && p === "/auth/google") { await startSignIn(req, res, url, ip); return true; }
      if (m === "GET" && p === "/auth/google/callback") { await finishSignIn(req, res, url); return true; }

      const mutating = m !== "GET" && m !== "HEAD";
      if (mutating && !sameOrigin(req)) { send(res, 403, { error: "Forbidden." }); return true; }

      if (m === "POST" && p === "/auth/logout") {
        const token = parseCookies(req.headers.cookie).squall_sid;
        if (token) await db.query(SQL.sessionDelete, [hashToken(token)]);
        send(res, 200, { ok: true }, [clearSession]);
        return true;
      }

      const syncMatch = p.match(/^\/api\/sync(?:\/([^/]+)\/([^/]+))?$/);
      const isAccount = p === "/api/account";
      if (!syncMatch && !isAccount) { send(res, 404, { error: "Not found." }); return true; }

      const sess = await currentSession(req);
      if (!sess) { send(res, 401, { error: "Signed out." }, [clearSession]); return true; }

      if (isAccount) {
        if (m !== "DELETE") { send(res, 405, { error: "Method not allowed." }); return true; }
        await db.query(SQL.userDelete, [sess.userId]);
        log.log(`AUTH|account_deleted|user=${sess.userId}`);
        send(res, 200, { ok: true }, [clearSession]);
        return true;
      }

      const [, rawStore, rawId] = syncMatch;
      if (!rawStore) {
        if (m !== "GET") { send(res, 405, { error: "Method not allowed." }); return true; }
        const { rows } = await db.query(SQL.itemsAll, [sess.userId]);
        send(res, 200, {
          user: { id: sess.userId, ...sess.user },
          items: rows.map(r => ({ store: r.store, id: r.item_id, data: r.data, modifiedAt: Number(r.modified_at) }))
        }, sess.cookies);
        return true;
      }
      let store, id;
      try { store = decodeURIComponent(rawStore); id = decodeURIComponent(rawId); }
      catch (_) { send(res, 400, { error: "Bad request." }); return true; }
      if (m === "PUT") { await putItem(req, res, sess, store, id); return true; }
      if (m === "DELETE") {
        if (!SYNC_STORES.includes(store) || !ITEM_ID_RE.test(id)) { send(res, 400, { error: "Bad request." }); return true; }
        if (!hit(writeHits, sess.userId, Math.floor(now() / 60000), config.limits.writesPerMin)) {
          send(res, 429, { error: "Too many sync writes, slow down.", code: "rate" }); return true;
        }
        await db.query(SQL.itemDelete, [sess.userId, store, id]);
        send(res, 200, { ok: true }, sess.cookies);
        return true;
      }
      send(res, 405, { error: "Method not allowed." });
      return true;
    } catch (e) {
      log.warn(`AUTH|db_error|${m} ${p}|${e && e.message}`);
      if (!res.headersSent) send(res, 503, { error: "Accounts are temporarily unavailable." });
      else try { res.end(); } catch (_) {}
      return true;
    }
  }

  return { handle, ensureSchema, isReady: () => ready };
}

module.exports = {
  SYNC_STORES, ITEM_ID_RE, SINGLE_ID, SQL, SCHEMA_SQL,
  loadConfig, signValue, verifySigned, hashToken, safeReturnPath, checkIdClaims,
  decodeJwtPayload, validateItem, parseCookies, createAccounts
};
