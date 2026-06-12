# ── Stock Analyzer: Node (server) + Python (scraper) in one image ──────────
FROM node:20-bookworm-slim

# Install Python 3 + pip (the scraper's runtime)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Node dependencies ---
COPY package*.json ./
RUN npm install --omit=dev

# --- Python dependencies ---
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# --- App source ---
COPY . .

# Railway injects PORT at runtime; server.js reads process.env.PORT
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
