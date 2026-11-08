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
 && apt-get install -y --no-install-recommends python3-venv python3-pip ca-certificates tini \
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
# the demo circuits run once here, so opening a demo copies a stored netlist (demo_cache.ts)
RUN ./node_modules/.bin/tsx build_demo_cache.ts
# kicad-cli's footprint library table, pointing at the vendored libraries the boards are made from: with none, DRC
# warned on every board that each footprint's library "is not in the current configuration" (15 warnings in the
# board checks of the 555 demo, 2026-11-03). In a folder of the image that KICAD_CONFIG_HOME below names (kicad-cli adds
# 10.0/): written to $HOME/.config under /tmp, it was not there on Render, which gives the container another /tmp or
# HOME, and every demo board warned 9-15 times again (2026-11-08; an empty /tmp or another HOME does the same here)
RUN mkdir -p /app/kicad-config/10.0 \
 && { echo '(fp_lib_table'; echo '  (version 7)'; \
      for d in /app/server/pcb/footprints/*.pretty; do \
        echo "  (lib (name \"$(basename "$d" .pretty)\")(type \"KiCad\")(uri \"$d\")(options \"\")(descr \"\"))"; done; \
      echo ')'; } > /app/kicad-config/10.0/fp-lib-table
# the KiCad image has no 3D model library: the 3D view and assembly need the part bodies,
# so kicad-cli reads the models the vendored footprints point at (server/pcb/3dmodels)
ENV NODE_ENV=production \
    PORT=8002 \
    SF_OUTPUTS_SWEEP=1 \
    KICAD_CLI_PATH=/usr/bin/kicad-cli \
    KICAD10_3DMODEL_DIR=/app/server/pcb/3dmodels \
    KICAD_CONFIG_HOME=/app/kicad-config \
    HOME=/tmp
EXPOSE 8002

# tini as the first process: node does not reap the children the skidl code leaves, and their zombies piled up under
# the container's process limit (ten from one run that did not wait for its children, 2026-11-03)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "index.ts"]
