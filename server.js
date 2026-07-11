const http = require("http");
const { exec, spawn } = require("child_process");
const fs   = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY     = process.env.OPENROUTER_API_KEY || "YOUR_OPENROUTER_KEY_HERE";
const SCRAPER_PATH = "./scraperFinal.py";
const PORT        = process.env.PORT || 3000;
const AI_MODEL    = "deepseek/deepseek-v4-flash";         // main analysis — live search is now a separate focused step (below), NOT bolted onto this prompt
const SEARCH_MODEL = "deepseek/deepseek-v4-flash";       // cheap model for the web-research pass; used with an explicit web plugin, one clean query per topic
const RESEARCH_ON  = false; // DISABLED for now — live web search is unfunctional and stalls the AI stream. Re-enable when fixed (set to: process.env.WEB_RESEARCH !== "off").
const PYTHON      = process.env.PYTHON_BIN || "python3";
const STAGE_TOTAL = 7;  // scraper now emits 7 stages

// Reasoning config (OpenRouter → DeepSeek reasoning).
// `effort` accepts "low" | "medium" | "high" | "xhigh" — higher = deeper thinking but much slower to first token.
// ANALYSIS_MAX caps total output (thinking + answer share it).
const REASON_EFFORT = "medium"; // was "high" — dropped to cut how long the model spends before writing
const ANALYSIS_MAX  = 6000;     // total output cap

// ──────────────────────────────────────────────────────────────────────────────

/**
 * System prompt: authoritative, terse — keeps the model focused without
 * burning tokens on roleplay preamble.  The user-side prompt carries all data.
 */
function buildAiMessages(prompt, research) {
  let userContent = prompt;
  if (research && research.trim()) {
    userContent +=
      "\n\n---\n### REAL-TIME WEB INTELLIGENCE (live search — recent product launches, congressional/politician trades, geopolitical events)\n" +
      "Gathered just now via live web search. Weave the relevant items into the Sentiment & Positioning and Catalysts & Risks sections and always cite their dates. " +
      "This is qualitative context only — never let it override the audited financial figures above, and skip items that don't bear on the thesis.\n\n" +
      research;
  }
  return [
    {
      role: "system",
      content: [
        "You are a quantitative financial analyst writing a thorough, multi-section read for an investor who can already see all the underlying data.",
        "Reason carefully before answering, then interpret — connect valuation, fundamentals, technicals, and institutional positioning into judgments. Never restate figures, rebuild tables, or list metrics for their own sake; cite a number only when it anchors a specific conclusion.",
        "Be specific to this company, not generic. Use only the data and live-search intelligence supplied; never invent figures, strikes, expirations, or news events.",
      ].join(" ")
    },
    { role: "user", content: userContent }
  ];
}

// ─── LIVE WEB RESEARCH ──────────────────────────────────────────────────────
// The old `:online` bolted a single auto-generated query onto the giant financial
// prompt → a diluted query that surfaced nothing usable. Instead we run one clean,
// single-topic search per category so Exa gets a focused query each time, then feed
// the findings into the analysis prompt above.
const RESEARCH_TOPICS = [
  { label: "Product launches & announcements",
    q: (n, t) => `Recent product launches, product announcements, major partnerships, or notable business developments for ${n} (${t}) in the last 90 days. List each as a bullet with its date and source.` },
  { label: "Congressional / politician trades",
    q: (n, t) => `US congressional, senator, or representative stock trades (buys or sells) of ${n} (${t}) disclosed in the last 6 months — per trackers like Capitol Trades, Quiver Quantitative, Unusual Whales, or the news. List politician, buy or sell, amount range, and date.` },
  { label: "Geopolitical & political events",
    q: (n, t) => `Geopolitical or political events in the last 90 days that materially affect ${n} (${t}) — wars, sanctions, tariffs, export controls, regulation, antitrust, or government contracts. List each with its date and source.` },
];

async function webSearch(query) {
  // Hard timeout: a slow or hanging web-plugin call must NEVER stall the analysis.
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "HTTP-Referer":  "http://localhost",
        "X-Title":       "Squall Research"
      },
      body: JSON.stringify({
        model:       SEARCH_MODEL,
        temperature: 0.1,
        max_tokens:  600,
        plugins:     [{ id: "web", max_results: 6 }],   // explicit web plugin → we control results count; query stays this focused topic
        messages: [
          { role: "system", content: "You are a financial news researcher. Using ONLY the live web results attached to this request, extract concrete, recent, dated facts. Reply as terse bullet points, each ending with '(date — source)'. If nothing relevant is found, reply with exactly: None found." },
          { role: "user", content: query }
        ]
      })
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const txt = j?.choices?.[0]?.message?.content?.trim();
    return (txt && !/^none found\.?$/i.test(txt)) ? txt : null;
  } catch {
    return null;   // aborted / network error → just no research for this topic
  } finally {
    clearTimeout(timer);
  }
}

// Runs the topic searches in parallel; returns a markdown block (or "" if nothing surfaced).
async function gatherResearch(ticker, companyName) {
  const name = companyName || ticker;
  const settled = await Promise.all(
    RESEARCH_TOPICS.map(topic =>
      webSearch(topic.q(name, ticker))
        .then(txt => (txt ? { label: topic.label, txt } : null))
        .catch(() => null))
  );
  return settled.filter(Boolean).map(r => `**${r.label}**\n${r.txt}`).join("\n\n");
}

/**
 * Fast format gate — runs BEFORE spawning Python or calling AI.
 * Only rejects obvious garbage; the scraper does the authoritative validation.
 */
function validateTickerFormat(t) {
  if (!t) return { ok: false, reason: "Enter a ticker symbol." };
  if (t.length > 8) return { ok: false, reason: `"${t}" is too long to be a ticker symbol.` };
  if (!/^\^?[A-Z][A-Z0-9]{0,5}([.\-][A-Z0-9]{1,4})?$/.test(t))
    return { ok: false, reason: `"${t}" isn't a valid ticker format.` };
  return { ok: true };
}

/**
 * Accepts a ticker OR a company name. Ticker-shaped input is normalized and format-checked
 * here (fast reject); a name is sanitized to a shell-safe charset and passed through for the
 * Python scraper to resolve. Returns { ok, query } or { ok:false, reason, invalid_ticker }.
 */
function sanitizeQuery(raw) {
  const q = (raw || "").trim();
  if (!q) return { ok: false, reason: "Enter a ticker symbol or company name." };

  if (!/\s/.test(q) && /^\^?[A-Za-z][A-Za-z0-9]{0,5}([.\-][A-Za-z0-9]{1,4})?$/.test(q)) {
    const t = q.toUpperCase().replace(/[^A-Z0-9.^-]/g, "");
    const fmt = validateTickerFormat(t);
    return fmt.ok ? { ok: true, query: t } : { ok: false, reason: fmt.reason, invalid_ticker: true };
  }
  // Name query: keep letters/digits/space + a few name chars; drop shell-unsafe chars.
  const name = q.replace(/[^A-Za-z0-9 .,&'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (name.replace(/[^A-Za-z0-9]/g, "").length < 2)
    return { ok: false, reason: `"${q}" isn't a valid ticker or company name.`, invalid_ticker: true };
  return { ok: true, query: name };
}

// Static file serving
const PUBLIC_DIR = __dirname;
const MIME = {
  ".html":"text/html",".js":"text/javascript",".css":"text/css",
  ".json":"application/json",".png":"image/png",".jpg":"image/jpeg",
  ".svg":"image/svg+xml",".ico":"image/x-icon"
};

function serveStatic(req, res) {
  let p = req.url === "/" ? "/index.html" : req.url;
  p = p.split("?")[0].replace(/\.\./g, "");
  const filePath = path.join(PUBLIC_DIR, p);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, {"Content-Type":"text/plain"}); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {"Content-Type": MIME[ext] || "application/octet-stream"});
    res.end(data);
  });
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.end(); return; }

  // Health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ status: "ok", model: AI_MODEL }));
    return;
  }

  // ── STREAMING ANALYSIS (Server-Sent Events) ─────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/analyze-stream")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const raw = url.searchParams.get("ticker") || "";

    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const s = sanitizeQuery(raw);
    if (!s.ok) { send("error", { error: s.reason, invalid_ticker: s.invalid_ticker }); res.end(); return; }
    const query = s.query;

    send("progress", { stage: 0, total: STAGE_TOTAL, label: "Starting data pipeline" });

    // spawn() with an args array runs without a shell, so a multi-word name is one safe argv.
    const py = spawn(PYTHON, [SCRAPER_PATH, query], { env: process.env });
    let stdout = "", stderrTail = "", buf = "";

    py.stderr.on("data", chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("STAGE|")) {
          const [, k, n, label] = line.split("|");
          send("progress", { stage: Number(k), total: Number(n), label });
        } else if (line) {
          stderrTail = (stderrTail + "\n" + line).slice(-2000);
        }
      }
    });
    py.stdout.on("data", chunk => (stdout += chunk));
    req.on("close", () => { try { py.kill(); } catch (_) {} });

    py.on("close", async () => {
      if (!stdout.trim()) {
        send("error", { error: "Script produced no output.", detail: stderrTail });
        return res.end();
      }
      let payload;
      try { payload = JSON.parse(stdout.trim()); }
      catch { send("error", { error: "Failed to parse Python output.", detail: stdout.slice(0,500) }); return res.end(); }
      if (payload.error) { send("error", { error: payload.error }); return res.end(); }

      // Scraper done — ship the dashboard payload immediately, then stream the AI on top.
      send("result", { ...payload, model: AI_MODEL });

      // Focused live-web research (clean per-topic queries) → injected into the analysis.
      // Runs while the AI pane still shows its loading skeleton; adds a few seconds.
      let research = "";
      if (RESEARCH_ON) {
        try { research = await gatherResearch(payload.ticker, payload.company_name); } catch (_) {}
      }

      send("ai_start", { model: AI_MODEL });

      // Request body is fixed across retries. `allow_fallbacks` lets OpenRouter reroute
      // to another provider instead of hard-failing when one drops the connection.
      const aiReqBody = JSON.stringify({
        model:       AI_MODEL,
        temperature: 0.3,
        max_tokens:  ANALYSIS_MAX,
        reasoning:   { effort: REASON_EFFORT },
        stream:      true,
        provider:    { allow_fallbacks: true },
        messages:    buildAiMessages(payload.ai_prompt, research)
      });

      const MAX_ATTEMPTS = 3;
      let aiSummary = "", aiReasoning = "", emitted = false, lastErr = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        aiSummary = ""; aiReasoning = "";   // only ever retried when nothing was emitted yet, so this is safe
        try {
          const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type":  "application/json",
              "Authorization": `Bearer ${API_KEY}`,
              "HTTP-Referer":  "http://localhost",
              "X-Title":       "Squall"
            },
            body: aiReqBody
          });
          if (!aiRes.ok || !aiRes.body) {
            const errText = await aiRes.text().catch(() => "");
            const e = new Error(`OpenRouter ${aiRes.status}: ${errText.slice(0, 300)}`);
            e.httpStatus = aiRes.status;
            throw e;
          }

          let sseBuf = "";
          const decoder = new TextDecoder();
          for await (const chunk of aiRes.body) {
            sseBuf += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = sseBuf.indexOf("\n")) >= 0) {
              const line = sseBuf.slice(0, nl).trim();
              sseBuf = sseBuf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;      // skips ": OPENROUTER PROCESSING" keep-alives
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let j; try { j = JSON.parse(data); } catch { continue; }
              if (j.error) throw new Error(j.error.message || "OpenRouter stream error");
              const d = j.choices?.[0]?.delta || {};
              if (d.reasoning) { aiReasoning += d.reasoning; emitted = true; send("ai_thinking", { t: d.reasoning }); }
              if (d.content)   { aiSummary   += d.content;   emitted = true; send("ai_delta",   { t: d.content }); }
            }
          }
          send("ai_done", { aiSummary, aiReasoning, model: AI_MODEL });
          lastErr = null;
          break;
        } catch (aiErr) {
          lastErr = aiErr;
          const transient = /terminated|idle timeout|ECONNRESET|ETIMEDOUT|EPIPE|socket|network|fetch failed/i.test(aiErr.message || "")
                            || aiErr.httpStatus >= 500 || aiErr.httpStatus === 429;
          // Only safe to retry before any token reached the client — re-streaming
          // after that would duplicate text in the browser.
          if (transient && !emitted && attempt < MAX_ATTEMPTS) {
            console.warn(`AI stream ${aiErr.message} — retry ${attempt + 1}/${MAX_ATTEMPTS}`);
            await new Promise(r => setTimeout(r, 600 * attempt));
            continue;
          }
          break;   // can't safely retry mid-stream — surface it below
        }
      }
      // Failure surfaces as ai_error (never ai_done) so an interrupted stream is never
      // mistaken for a finished answer. The client keeps whatever partial text streamed
      // and shows a Retry button — the dashboard is untouched either way.
      if (lastErr) {
        const msg = emitted
          ? `Response was interrupted before finishing (${lastErr.message}). Hit Retry to regenerate the full analysis.`
          : `AI call failed: ${lastErr.message}`;
        send("ai_error", { error: msg });
      }
      res.end();
    });

    py.on("error", err => {
      send("error", { error: "Could not launch Python: " + err.message });
      res.end();
    });
    return;
  }

  if (req.method === "GET") { serveStatic(req, res); return; }

  // ── BATCH ANALYZE (non-streaming) ───────────────────────────────────────────
  if (req.method === "POST" && req.url === "/analyze") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const { ticker } = JSON.parse(body);
        const s = sanitizeQuery(ticker);
        if (!s.ok) {
          res.writeHead(400, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ error: s.reason, invalid_ticker: s.invalid_ticker })); return;
        }
        // Quoted so a multi-word name stays one argument; sanitizeQuery already stripped
        // shell-unsafe characters (no quotes/backticks/$), so this cannot break out.
        exec(
          `${PYTHON} "${SCRAPER_PATH}" "${s.query}"`,
          { timeout: 150000, maxBuffer: 1024 * 1024 * 10 },
          async (err, stdout, stderr) => {
            if (!stdout || !stdout.trim()) {
              res.writeHead(500, {"Content-Type":"application/json"});
              res.end(JSON.stringify({ error: "Script produced no output.",
                detail: stderr || (err && err.message) || "Unknown error" }));
              return;
            }
            let payload;
            try { payload = JSON.parse(stdout.trim()); }
            catch {
              res.writeHead(500, {"Content-Type":"application/json"});
              res.end(JSON.stringify({ error: "Failed to parse Python output.", detail: stdout.slice(0,500) }));
              return;
            }
            if (payload.error) {
              res.writeHead(500, {"Content-Type":"application/json"});
              res.end(JSON.stringify({ error: payload.error })); return;
            }
            try {
              let research = "";
              if (RESEARCH_ON) {
                try { research = await gatherResearch(payload.ticker, payload.company_name); } catch (_) {}
              }
              const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type":  "application/json",
                  "Authorization": `Bearer ${API_KEY}`,
                  "HTTP-Referer":  "http://localhost",
                  "X-Title":       "Squall"
                },
                body: JSON.stringify({
                  model:       AI_MODEL,
                  temperature: 0.3,
                  max_tokens:  ANALYSIS_MAX,
                  reasoning:   { effort: REASON_EFFORT },
                  messages:    buildAiMessages(payload.ai_prompt, research)
                })
              });
              const aiData   = await aiRes.json();
              if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");
              const aiMsg     = aiData.choices[0].message;
              const aiSummary = aiMsg.content;
              const aiReasoning = aiMsg.reasoning || "";
              res.writeHead(200, {"Content-Type":"application/json"});
              res.end(JSON.stringify({ ...payload, aiSummary, aiReasoning, model: AI_MODEL }));
            } catch (aiErr) {
              res.writeHead(500, {"Content-Type":"application/json"});
              res.end(JSON.stringify({ error: "AI call failed: " + aiErr.message }));
            }
          }
        );
      } catch (e) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── FOLLOW-UP CHAT (SSE streaming over POST) ─────────────────────────────────
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "X-Accel-Buffering": "no"
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      let parsed;
      try { parsed = JSON.parse(body); }
      catch { send("error", { error: "Malformed request." }); return res.end(); }
      const { messages, context, analysis, think } = parsed;   // analysis: the initial AI write-up so follow-ups have continuity; think: request model reasoning

      // Abort the upstream ONLY if the client actually drops the response.
      // NOTE: do NOT listen on `req` here — in Node 16+ the POST request stream auto-destroys
      // and emits 'close' the instant its body is consumed, which would abort us before a single
      // token streams back (→ silent blank replies). `res` 'close' fires on real disconnect.
      const ctrl = new AbortController();
      res.on("close", () => { if (!res.writableEnded) { try { ctrl.abort(); } catch (_) {} } });

      const reqBody = {
        model:       AI_MODEL,
        temperature: 0.3,
        max_tokens:  think ? 4000 : 2048,   // reasoning shares the output budget → give it more room
        stream:      true,
        provider:    { allow_fallbacks: true },   // reroute instead of hard-failing when a provider drops
        messages: [
          {
            role: "system",
            content: `You are a quantitative financial analyst answering follow-up questions.\n`
                   + `Reference the stock data below when relevant. Be concise and precise.\n`
                   + `The user has already read your initial analysis (included below) — build on it, stay consistent with it, and don't repeat it wholesale.\n\n`
                   + `--- STOCK DATA ---\n${context}`
                   + (analysis && analysis.trim() ? `\n\n--- YOUR INITIAL ANALYSIS (already shown to the user) ---\n${analysis}` : "")
          },
          ...(Array.isArray(messages) ? messages : [])
        ]
      };
      if (think) reqBody.reasoning = { effort: REASON_EFFORT };

      try {
        const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${API_KEY}`,
            "HTTP-Referer":  "http://localhost",
            "X-Title":       "Squall Chat"
          },
          body: JSON.stringify(reqBody)
        });
        // Non-2xx (or non-JSON "upstream error" bodies) surface as a clean message instead of crashing a JSON.parse.
        if (!aiRes.ok || !aiRes.body) {
          const errText = await aiRes.text().catch(() => "");
          send("error", { error: `The model provider returned an error (HTTP ${aiRes.status}). ${errText.slice(0, 200)}`.trim() });
          return res.end();
        }

        let sseBuf = "", reply = "", reasoning = "";
        const decoder = new TextDecoder();
        for await (const chunk of aiRes.body) {
          sseBuf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = sseBuf.indexOf("\n")) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;      // skips ": OPENROUTER PROCESSING" keep-alives
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let j; try { j = JSON.parse(data); } catch { continue; }   // ignore any non-JSON noise mid-stream
            if (j.error) { send("error", { error: j.error.message || "The model stream errored." }); return res.end(); }
            const d = j.choices?.[0]?.delta || {};
            if (d.reasoning) { reasoning += d.reasoning; send("think", { t: d.reasoning }); }
            if (d.content)   { reply     += d.content;   send("delta", { t: d.content }); }
          }
        }
        if (!reply.trim()) { send("error", { error: "The model returned an empty response — please try again." }); return res.end(); }
        send("done", { reply, reasoning });
        res.end();
      } catch (e) {
        if (e.name !== "AbortError") send("error", { error: "Chat request failed: " + e.message });
        try { res.end(); } catch (_) {}
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");

}).listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Squall server running → http://0.0.0.0:${PORT}`);
  console.log(`   Model    : ${AI_MODEL}`);
  console.log(`   Scraper  : ${path.resolve(SCRAPER_PATH)}`);
  console.log(`   FMP key  : ${process.env.FMP_API_KEY ? "set ✓" : "not set (optional)"}\n`);
});
