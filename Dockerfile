FROM node:22-bookworm-slim AS dependencies
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ripgrep bubblewrap socat && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY domains/soc ./domains/soc
COPY scripts ./scripts
RUN mkdir -p /app/.nunchi && chown node:node /app/.nunchi
ENV NODE_ENV=production PORT=3001
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/gateway/server.ts"]
