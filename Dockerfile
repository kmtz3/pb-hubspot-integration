# ── Build: client ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS client-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src/client ./src/client
COPY src/types ./src/types
COPY src/sync/mapper.ts ./src/sync/mapper.ts
COPY public ./public

RUN npm run build:client

# ── Build: server ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS server-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.server.json ./
COPY src ./src

RUN npm run build:server

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=server-build /app/dist/server ./dist/server
COPY --from=client-build /app/dist/client ./dist/client

# Cloud Run injects PORT=8080; server.ts reads process.env.PORT
EXPOSE 8080

CMD ["node", "dist/server/server.js"]
