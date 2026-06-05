# Stage 1 — builder
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Prune dev dependencies so we can copy a lean node_modules
RUN npm prune --production

# Stage 2 — runtime
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY --from=builder /app/lib ./lib
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3600/health || exit 1

CMD ["node", "lib/index.js"]
