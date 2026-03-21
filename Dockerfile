FROM node:22-alpine AS builder

# better-sqlite3 compiles native bindings — needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Build the UI
COPY ui/package*.json ./ui/
RUN cd ui && npm ci
COPY ui ./ui
RUN cd ui && npm run build

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# better-sqlite3 needs a C compiler at install time; alpine provides it via build-base
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-ui ./dist-ui

# Persistent data volume — mount here to survive container restarts
VOLUME ["/data"]

ENV AKP_DB=/data/akp.db
ENV AKP_LOG=/data/deltas.ndjson
ENV LOG_LEVEL=info
ENV PORT=3000

# Non-root user for security
RUN addgroup -S akp && adduser -S akp -G akp
RUN mkdir -p /data && chown akp:akp /data
USER akp

EXPOSE 3000
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Default: start with JSON-RPC + MCP HTTP + sync peer
# Override CMD to run stdio MCP: ["node", "dist/cli/akp.js", "start", "--mcp"]
CMD ["node", "dist/cli/akp.js", "start", \
     "--port", "3000", \
     "--governance-interval", "60000"]
