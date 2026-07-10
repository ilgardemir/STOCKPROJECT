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
const RESEARCH_ON  = process.env.WEB_RESEARCH !== "off"; // set WEB_RESEARCH=off to skip live news (saves ~1-2¢/analysis)
const PYTHON      = process.env.PYTHON_BIN || "python3";
const STAGE_TOTAL = 7;  // scraper now emits 7 stages

// Reasoning config (OpenRouter → DeepSeek reasoning).
// DeepSeek controls reasoning depth via `effort` ("high" | "xhigh"), not a token budget.
// ANALYSIS_MAX caps total output (thinking + answer share it).
const REASON_EFFORT = "high";   // "xhigh" = maximum reasoning depth
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

      // Scraper done — ship the dashboard payload immediately, then stream the AI on top.
      send("result", { ...payload, model: AI_MODEL });

      // Focused live-web research (clean per-topic queries) → injected into the analysis.
      // Runs while the AI pane still shows its loading skeleton; adds a few seconds.
      let research = "";
      if (RESEARCH_ON) {
        try { research = await gatherResearch(payload.ticker, payload.company_name); } catch (_) {}
      }

      send("ai_start", { model: AI_MODEL });
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
            temperature: 0.3,
            max_tokens:  ANALYSIS_MAX,
            reasoning:   { effort: REASON_EFFORT },
            stream:      true,
            messages:    buildAiMessages(payload.ai_prompt, research)
          })
        });
        if (!aiRes.ok || !aiRes.body) {
          const errText = await aiRes.text().catch(() => "");
          throw new Error(`OpenRouter ${aiRes.status}: ${errText.slice(0, 300)}`);
        }

        let aiSummary = "", aiReasoning = "", sseBuf = "";
        const decoder = new TextDecoder();
        for await (const chunk of aiRes.body) {
          sseBuf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = sseBuf.indexOf("\n")) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;        // skips ": OPENROUTER PROCESSING" keep-alives
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let j; try { j = JSON.parse(data); } catch { continue; }
            if (j.error) throw new Error(j.error.message || "OpenRouter stream error");
            const d = j.choices?.[0]?.delta || {};
            if (d.reasoning) { aiReasoning += d.reasoning; send("ai_thinking", { t: d.reasoning }); }
            if (d.content)   { aiSummary   += d.content;   send("ai_delta",   { t: d.content }); }
          }
        }
        send("ai_done", { aiSummary, aiReasoning, model: AI_MODEL });
      } catch (aiErr) {
        // Deliver the error without killing the dashboard — data pane stays usable
        send("ai_error", { error: "AI call failed: " + aiErr.message });
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
