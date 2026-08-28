# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Fail closed: container must have reachable Postgres
ENV REQUIRE_POSTGRES=true
ENV REQUIRE_MIGRATIONS=true
ENV SEED_DUMMY_DATA=false
ENV LOG_LEVEL=info

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
# Bundled server may still resolve some runtime paths
COPY --from=builder /app/server ./server
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/src/types ./src/types

EXPOSE 3000

# Simple Docker HEALTHCHECK against readiness (Postgres must be up)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
