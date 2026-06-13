const http = require("http");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.OPENROUTER_API_KEY || "YOUR_OPENROUTER_KEY_HERE";  // ← paste your OpenRouter key
const SCRAPER_PATH = "./scraperFinal.py";          // ← path to your Python script
const PORT = process.env.PORT || 3000;
const AI_MODEL = "anthropic/claude-sonnet-4-5";
const PYTHON = process.env.PYTHON_BIN || "python3";
// ──────────────────────────────────────────────────────────────────────────────

function buildAiMessages(prompt) {  return [
    { role: "system", content: "You are an expert quantitative financial analyst. You provide deep, insightful, and data-driven stock analysis based strictly on the provided metrics. Always finish every section you begin — never cut off mid-analysis." },
    { role: "user", content: prompt }
  ];
}

// Cheap, instant format gate — runs BEFORE we ever spawn Python or call the AI.
// Its job is only to reject obvious garbage (empty, symbols, absurd length); the
// scraper does the authoritative "does this security actually exist" check.
// Kept lenient on purpose so valid odd tickers (BRK.B, RY.TO, ^GSPC) pass through.
function validateTickerFormat(t) {
  if (!t) return { ok: false, reason: "Enter a ticker symbol." };
  if (t.length > 8) return { ok: false, reason: `"${t}" is too long to be a ticker symbol.` };
  if (!/^\^?[A-Z][A-Z0-9]{0,5}([.\-][A-Z0-9]{1,4})?$/.test(t))
    return { ok: false, reason: `"${t}" isn't a valid ticker format.` };
  return { ok: true };
}

// Serve the frontend (index.html and any other static files placed alongside it)
const PUBLIC_DIR = __dirname;
const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(req, res) {
  let reqPath = req.url === "/" ? "/index.html" : req.url;
  // Strip query strings and prevent directory traversal
  reqPath = reqPath.split("?")[0].replace(/\.\./g, "");
  const filePath = path.join(PUBLIC_DIR, reqPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // ── STREAMING ANALYZE (Server-Sent Events) ──────────────────────────────
  // Streams real per-stage progress from the Python script, then the final result.
  if (req.method === "GET" && req.url.startsWith("/analyze-stream")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const raw = url.searchParams.get("ticker") || "";
    const ticker = raw.toUpperCase().trim().replace(/[^A-Z0-9.^-]/g, "");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!ticker) { send("error", { error: "ticker is required." }); res.end(); return; }

    const fmt = validateTickerFormat(ticker);
    if (!fmt.ok) { send("error", { error: fmt.reason, invalid_ticker: true }); res.end(); return; }

    send("progress", { stage: 0, total: 6, label: "Starting data pipeline" });

    const py = spawn(PYTHON, [SCRAPER_PATH, ticker], { env: process.env });
    let stdout = "", stderrTail = "";

    // stderr carries STAGE|k|N|label markers — forward them as progress
    let buf = "";
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

    req.on("close", () => { try { py.kill(); } catch (e) {} });

    py.on("close", async () => {
      if (!stdout.trim()) {
        send("error", { error: "Script produced no output.", detail: stderrTail });
        return res.end();
      }
      let payload;
      try { payload = JSON.parse(stdout.trim()); }
      catch (e) { send("error", { error: "Failed to parse Python output.", detail: stdout.slice(0, 500) }); return res.end(); }
      if (payload.error) { send("error", { error: payload.error }); return res.end(); }

      send("progress", { stage: 6, total: 6, label: "Running AI analysis" });
      try {
        const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}`, "HTTP-Referer": "http://localhost", "X-Title": "Squall" },
          body: JSON.stringify({ model: AI_MODEL, temperature: 0.3, max_tokens: 8192, messages: buildAiMessages(payload.ai_prompt) })
        });
        const aiData = await aiRes.json();
        if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");
        const aiSummary = aiData.choices[0].message.content;
        send("result", { ...payload, aiSummary });
      } catch (aiErr) {
        // Still deliver the data even if the AI call fails, so the user keeps the dashboard
        send("result", { ...payload, aiSummary: "", aiError: "AI call failed: " + aiErr.message });
      }
      res.end();
    });

    py.on("error", err => { send("error", { error: "Could not launch Python: " + err.message }); res.end(); });
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/analyze") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const { ticker } = JSON.parse(body);

        if (!ticker) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "ticker is required." }));
          return;
        }

        const cleanTicker = ticker.toUpperCase().trim().replace(/[^A-Z0-9.^-]/g, "");

        const fmt = validateTickerFormat(cleanTicker);
        if (!fmt.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: fmt.reason, invalid_ticker: true }));
          return;
        }

        // Run Python script with ticker as a command-line argument
        exec(`python3 "${SCRAPER_PATH}" ${cleanTicker}`, { timeout: 150000, maxBuffer: 1024 * 1024 * 10 }, async (err, stdout, stderr) => {

          if (!stdout || !stdout.trim()) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Script produced no output.",
              detail: stderr || (err && err.message) || "Unknown error"
            }));
            return;
          }

          // Parse JSON output from Python
          let payload;
          try {
            payload = JSON.parse(stdout.trim());
          } catch (parseErr) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to parse Python output.", detail: stdout.slice(0, 500) }));
            return;
          }

          if (payload.error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: payload.error }));
            return;
          }

          // Send the pre-built AI prompt to OpenRouter
          try {
            const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`,
                "HTTP-Referer": "http://localhost",
                "X-Title": "Stock Analyzer"
              },
              body: JSON.stringify({
                model: "anthropic/claude-sonnet-4-5",
                temperature: 0.3,
                max_tokens: 8192,
                messages: [
                  {
                    role: "system",
                    content: "You are an expert quantitative financial analyst. You provide deep, insightful, and data-driven stock analysis based strictly on the provided metrics."
                  },
                  {
                    role: "user",
                    content: payload.ai_prompt
                  }
                ]
              })
            });

            const aiData = await aiRes.json();
            if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");

            const aiSummary = aiData.choices[0].message.content;

            res.writeHead(200, { "Content-Type": "application/json" });
            // Forward the COMPLETE scraper payload (raw data, chart patterns,
            // options chains, SEC filing activity, MD&A, live quote, 1Y price
            // history, and the exact prompt the AI received) plus the AI summary.
            res.end(JSON.stringify({ ...payload, aiSummary }));

          } catch (aiErr) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "AI call failed: " + aiErr.message }));
          }
        });

      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const { messages, context } = JSON.parse(body);
        // messages = [{role, content}, ...] conversation history
        // context  = the original ai_prompt so Claude always has the stock data

        const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${API_KEY}`,
            "HTTP-Referer": "http://localhost",
            "X-Title": "Stock Analyzer"
          },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-5",
            temperature: 0.3,
            max_tokens: 4096,
            messages: [
              {
                role: "system",
                content: `You are an expert quantitative financial analyst. The user has already received a full analysis. Answer follow-up questions concisely and accurately, referencing the data below when relevant.\n\n--- ORIGINAL ANALYSIS DATA ---\n${context}`
              },
              ...messages
            ]
          })
        });

        const aiData = await aiRes.json();
        if (aiData.error) throw new Error(aiData.error.message || "OpenRouter API error");

        const reply = aiData.choices[0].message.content;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ reply }));

      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }

}).listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Stock Analyzer server running at http://0.0.0.0:${PORT}`);
  console.log(`   Python script: ${path.resolve(SCRAPER_PATH)}\n`);
});
