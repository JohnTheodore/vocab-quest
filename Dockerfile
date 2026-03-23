# ── Stage 1: build the Vite frontend ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy package manifests and install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled frontend and the Express server
COPY --from=builder /app/dist ./dist
COPY server.js ./

EXPOSE 3001

CMD ["node", "server.js"]
