# Multi-stage: compile the C++ engine, build the TypeScript service, then ship a
# runtime image that contains the binary and the compiled JS and nothing else.
#
# The engine binary is the only artifact that carries the algorithm. It never
# reaches a browser from here — this image is a private backend.

# ── stage 1: the engine ──────────────────────────────────────────────────────
FROM debian:bookworm-slim AS engine

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Makefile ./
COPY src ./src
# `cli` builds the same translation units the tests and benchmarks use, so the
# binary the service runs is the binary the golden tests validated.
RUN make cli CXX=g++ && test -x build/amath_cli

# ── stage 2: the service ─────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS service

WORKDIR /app

COPY service/package.json service/package-lock.json ./

# Install all dependencies, including TypeScript build tools.
RUN npm ci --ignore-scripts

COPY service/tsconfig.json ./
COPY service/src ./src

# Compile TypeScript.
RUN npx tsc -b

# Keep only dependencies required at runtime.
RUN npm prune --omit=dev

# ── stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# libstdc++ comes with the base image; the engine needs nothing else.
RUN groupadd --system amath && useradd --system --gid amath --home /app amath

WORKDIR /app
COPY --from=engine /build/build/amath_cli /usr/local/bin/amath_cli
COPY --from=service /app/dist ./dist
COPY --from=service /app/node_modules ./node_modules
COPY service/package.json ./

# Unprivileged: the service spawns processes, so the blast radius of an engine
# bug is worth keeping small.
USER amath

ENV NODE_ENV=production \
    ENGINE_BINARY_PATH=/usr/local/bin/amath_cli \
    PORT=8787

EXPOSE 8787

# The engine is CPU-bound and the queue sizes itself from the visible core
# count, so give the container a real CPU limit rather than letting it see the
# whole host.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
