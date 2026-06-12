FROM node:22-slim AS builder

WORKDIR /app

# Install Python + pip for skidl
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && \
    ln -sf python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

# Python deps (skidl)
COPY requirements.txt ./requirements.txt
RUN python3 -m venv /venv && \
    /venv/bin/pip install --no-cache-dir -r requirements.txt

# Frontend build
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── Final image ────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 python3-venv && \
    ln -sf python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /venv /venv
ENV PATH="/venv/bin:$PATH"

# Server deps
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server/ ./server/

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 8002

CMD ["npx", "tsx", "index.ts"]
