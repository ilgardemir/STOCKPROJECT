# Use a Node base image, then layer Python on top
FROM node:20-bookworm-slim

# Install Python 3 + pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Install Python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy the rest of the app
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
