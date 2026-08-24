# ===========================================
# Vachana Sanchaya - Docker Build
# ===========================================

# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (caching layer)
COPY server/package.json server/package-lock.json* ./server/
COPY package.json package-lock.json* ./

# Install ALL dependencies (including dev for build)
RUN npm install
RUN cd server && npm install

# Copy source files
COPY . .

# Build the frontend
RUN npm run build

# ---- Production Stage ----
FROM node:20-alpine

WORKDIR /app

# Copy server source code first (so it's available)
COPY server/ ./server/

# Copy frontend build and shared assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Copy root package.json (for workspace context if needed)
COPY --from=builder /app/package.json ./

# Install production dependencies for the server
# IMPORTANT: must run AFTER copying server/ code,
# so that previously installed node_modules is not overwritten
RUN cd server && npm install --production

# Environment variables (override as needed)
ENV PORT=3001
ENV NODE_ENV=production
ENV RAG_WARM_INDEX=0
ENV EMBEDDING_MODE=local

EXPOSE 3001

CMD ["node", "--max-old-space-size=4096", "server/server.js"]

