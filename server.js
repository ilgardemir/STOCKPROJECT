const http = require("http");
const { exec, spawn } = require("child_process");
const fs   = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY     = process.env.OPENROUTER_API_KEY || "YOUR_OPENROUTER_KEY_HERE";
const SCRAPER_PATH = "./scraperFinal.py";
const PORT        = process.env.PORT || 3000;
const AI_MODEL    = "anthropic/claude-haiku-4.5";   // reasoning-capable Haiku; ~1/3 the output cost of Sonnet
const PYTHON      = process.env.PYTHON_BIN || "python3";
const STAGE_TOTAL = 7;  // scraper now emits 7 stages

// Reasoning config (OpenRouter → Anthropic extended thinking).
// REASON_BUDGET is the thinking allowance; ANALYSIS_MAX must exceed it (thinking + answer share the budget).
const REASON_BUDGET = 2000;   // tokens the model may spend thinking
const ANALYSIS_MAX  = 6000;   // total cap: ~2k thinking + ~4k answer
// ──────────────────────────────────────────────────────────────────────────────

/**
 * System prompt: authoritative, terse — keeps the model focused without
 * burning tokens on roleplay preamble.  The user-side prompt carries all data.
 */
function buildAiMessages(prompt) {
  return [
    {
      role: "system",
      content: [
        "You are a quantitative financial analyst writing a thorough, multi-section read for an investor who can already see all the underlying data.",
        "Reason carefully before answering, then interpret — connect valuation, fundamentals, technicals, and institutional positioning into judgments. Never restate figures, rebuild tables, or list metrics for their own sake; cite a number only when it anchors a specific conclusion.",
        "Be specific to this company, not generic. Use only the data supplied; never invent figures, strikes, or expirations.",
      ].join(" ")
    },
    { role: "user", content: prompt }
  ];
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
    const url    = new URL(req.url, `http://${req.headers.host}`);
    const raw    = url.searchParams.get("ticker") || "";
    const ticker = raw.toUpperCase().trim().replace(/[^A-Z0-9.^-]/g, "");

    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!ticker) { send("error", { error: "ticker is required." }); res.end(); return; }
    const fmt = validateTickerFormat(ticker);
    if (!fmt.ok) { send("error", { error: fmt.reason, invalid_ticker: true }); res.end(); return; }

    send("progress", { stage: 0, total: STAGE_TOTAL, label: "Starting data pipeline" });

    const py = spawn(PYTHON, [SCRAPER_PATH, ticker], { env: process.env });
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

      send("progress", { stage: STAGE_TOTAL, total: STAGE_TOTAL, label: "Running AI analysis" });
      try {
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
            temperature: 1,            // extended thinking requires temperature 1
            max_tokens:  ANALYSIS_MAX, // covers thinking + answer
            reasoning:   { max_tokens: REASON_BUDGET },
            messages:    buildAiMessages(payload.ai_prompt)
          })
        });
        const aiData = await aiRes.json();
        if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");
        const aiMsg     = aiData.choices[0].message;
        const aiSummary = aiMsg.content;
        const aiReasoning = aiMsg.reasoning || "";   // summarized thinking trace
        send("result", { ...payload, aiSummary, aiReasoning });
      } catch (aiErr) {
        // Deliver data even if AI fails — user keeps the dashboard
        send("result", { ...payload, aiSummary: "", aiError: "AI call failed: " + aiErr.message });
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
        if (!ticker) {
          res.writeHead(400, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ error: "ticker is required." })); return;
        }
        const cleanTicker = ticker.toUpperCase().trim().replace(/[^A-Z0-9.^-]/g, "");
        const fmt = validateTickerFormat(cleanTicker);
        if (!fmt.ok) {
          res.writeHead(400, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ error: fmt.reason, invalid_ticker: true })); return;
        }

        exec(
          `${PYTHON} "${SCRAPER_PATH}" ${cleanTicker}`,
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
                  temperature: 1,
                  max_tokens:  ANALYSIS_MAX,
                  reasoning:   { max_tokens: REASON_BUDGET },
                  messages:    buildAiMessages(payload.ai_prompt)
                })
              });
              const aiData   = await aiRes.json();
              if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");
              const aiMsg     = aiData.choices[0].message;
              const aiSummary = aiMsg.content;
              const aiReasoning = aiMsg.reasoning || "";
              res.writeHead(200, {"Content-Type":"application/json"});
              res.end(JSON.stringify({ ...payload, aiSummary, aiReasoning }));
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

  // ── FOLLOW-UP CHAT ───────────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const { messages, context } = JSON.parse(body);
        // messages: [{role, content}, …]   context: original ai_prompt
        const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${API_KEY}`,
            "HTTP-Referer":  "http://localhost",
            "X-Title":       "Squall Chat"
          },
          body: JSON.stringify({
            model:       AI_MODEL,
            temperature: 0.3,
            max_tokens:  2048,   // follow-ups are shorter; saves tokens
            messages: [
              {
                role: "system",
                content: `You are a quantitative financial analyst answering follow-up questions.\n`
                       + `Reference the stock data below when relevant. Be concise and precise.\n\n`
                       + `--- STOCK DATA ---\n${context}`
              },
              ...messages
            ]
          })
        });
        const aiData = await aiRes.json();
        if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ reply: aiData.choices[0].message.content }));
      } catch (e) {
        res.writeHead(500, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ error: e.message }));
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
