FROM oven/bun:1-slim

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first (cache layer)
COPY chat/package.json chat/bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY chat/src ./src
COPY chat/tsconfig.json ./

EXPOSE 8765

CMD ["bun", "run", "src/server.ts"]
