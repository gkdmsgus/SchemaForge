# SchemaForge — web app + API + PCB generator + KiCad CLI in one image.
#
# The runtime is the official KiCad 10 image, so gerber export and design rule
# checks (kicad-cli) work on the deployed server exactly as they do locally.
# Node is copied in from the official Node image; Python deps live in a venv
# built on the runtime itself (its Python differs from node:22-slim's).

# ── 1) frontend build ─────────────────────────────────────────────────
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── 2) API dependencies ───────────────────────────────────────────────
FROM node:22-slim AS api
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# ── 3) runtime ────────────────────────────────────────────────────────
FROM kicad/kicad:10.0.5

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=api /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements.txt
# the server spawns `python`; the venv provides it
ENV PATH="/venv/bin:$PATH"

COPY --from=api /app/server/node_modules ./server/node_modules
COPY --from=web /app/dist ./dist
COPY server/ ./server/

WORKDIR /app/server
RUN mkdir -p outputs
ENV NODE_ENV=production \
    KICAD_CLI_PATH=/usr/bin/kicad-cli \
    HOME=/tmp
EXPOSE 8002

CMD ["./node_modules/.bin/tsx", "index.ts"]
