FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.service.json ./
COPY src ./src
COPY domains ./domains
COPY scripts ./scripts
COPY service/package.json ./service/package.json
RUN pnpm build:service

FROM node:22-bookworm-slim AS dependencies
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY service/package.json service/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ripgrep bubblewrap socat && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=build /build/service/dist ./dist
RUN mkdir -p /app/.nunchi && chown node:node /app/.nunchi
ENV NODE_ENV=production
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/src/gateway/server.js"]
