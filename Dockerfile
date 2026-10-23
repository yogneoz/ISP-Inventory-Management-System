# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build Vite frontend and bundled Node server (dist/server.cjs)
RUN npm run build

# Production runtime stage
FROM node:24-alpine AS runner

WORKDIR /app

# Production refuses to start without a usable AUTH_TOKEN_SECRET (32+ chars,
# not the .env.example placeholder) — supply it at run time, e.g.
# `docker run --env-file .env` with a real value in that file.
ENV NODE_ENV=production
ENV PORT=3000

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built dist directory and database scripts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts

EXPOSE 3000

CMD ["node", "dist/server.cjs"]
