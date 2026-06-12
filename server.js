const http = require("http");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.OPENROUTER_API_KEY || "YOUR_OPENROUTER_KEY_HERE";  // ← paste your OpenRouter key
const SCRAPER_PATH = "./scraperFinal.py";          // ← path to your Python script
const PORT = process.env.PORT || 3000;
// ──────────────────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.end(); return; }

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

        // Run Python script with ticker as a command-line argument
        exec(`python "${SCRAPER_PATH}" ${cleanTicker}`, { timeout: 90000 }, async (err, stdout, stderr) => {

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
                max_tokens: 1200,
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
            res.end(JSON.stringify({
              ticker: payload.ticker,
              company_name: payload.company_name,
              raw_data: payload.raw_data,
              algorithmic_signals: payload.algorithmic_signals,
              aiSummary
            }));

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
            max_tokens: 1000,
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

}).listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Stock Analyzer server running on 0.0.0.0:${PORT}`);
  console.log(`   Python script: ${path.resolve(SCRAPER_PATH)}\n`);
});
