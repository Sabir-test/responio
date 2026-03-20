FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Build stage
FROM base AS builder
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/events/package.json ./packages/events/
COPY packages/types/package.json ./packages/types/
COPY services/billing/package.json ./services/billing/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY packages/events/ ./packages/events/
COPY packages/types/ ./packages/types/
COPY services/billing/ ./services/billing/

RUN pnpm --filter @responio/events build
RUN pnpm --filter @responio/types build
RUN pnpm --filter @responio/billing build

# Production stage
FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/events/dist ./packages/events/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/services/billing/dist ./services/billing/dist
COPY --from=builder /app/services/billing/package.json ./services/billing/

USER node
WORKDIR /app/services/billing
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
