FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/events/package.json ./packages/events/
COPY packages/types/package.json ./packages/types/
COPY packages/adapters/package.json ./packages/adapters/
COPY services/gateway/package.json ./services/gateway/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY packages/events/ ./packages/events/
COPY packages/types/ ./packages/types/
COPY packages/adapters/ ./packages/adapters/
COPY services/gateway/ ./services/gateway/

RUN pnpm --filter @responio/events build
RUN pnpm --filter @responio/types build
RUN pnpm --filter @responio/adapters build
RUN pnpm --filter @responio/gateway build

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/events/dist ./packages/events/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=builder /app/services/gateway/dist ./services/gateway/dist
COPY --from=builder /app/services/gateway/package.json ./services/gateway/

USER node
WORKDIR /app/services/gateway
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
