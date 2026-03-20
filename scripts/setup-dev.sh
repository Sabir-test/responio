#!/usr/bin/env bash
# Responio — Local Development Setup Script
# Run this once to set up your dev environment.
# Usage: ./scripts/setup-dev.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[responio]${NC} $1"; }
ok() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; exit 1; }

log "Setting up Responio development environment..."

# ── Check prerequisites ────────────────────────────────────────────────────────
log "Checking prerequisites..."

command -v docker &>/dev/null || err "Docker is required. Install from https://docs.docker.com/get-docker/"
command -v node &>/dev/null || err "Node.js >= 20 is required. Use nvm: nvm install 20"
command -v pnpm &>/dev/null || err "pnpm is required. Run: npm install -g pnpm"
command -v git &>/dev/null || err "git is required."

NODE_VERSION=$(node --version | cut -d. -f1 | tr -d 'v')
if [[ $NODE_VERSION -lt 20 ]]; then
  err "Node.js >= 20 required (found v${NODE_VERSION})"
fi

ok "Prerequisites check passed"

# ── Check disk space ───────────────────────────────────────────────────────────
AVAILABLE_GB=$(df -BG . | awk 'NR==2{print $4}' | tr -d 'G')
if [[ $AVAILABLE_GB -lt 3 ]]; then
  warn "Low disk space: ${AVAILABLE_GB}GB available. Minimum 3GB recommended."
  warn "Run: docker system prune -f to free space"
  read -rp "Continue anyway? [y/N] " confirm
  [[ $confirm == "y" || $confirm == "Y" ]] || exit 1
fi

# ── Environment file ───────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  log "Creating .env from .env.example..."
  cp .env.example .env
  warn "Review .env and fill in API keys before running services"
  ok ".env created"
else
  ok ".env already exists"
fi

# ── Start infrastructure ───────────────────────────────────────────────────────
log "Starting infrastructure services (PostgreSQL, Redis, NATS, MinIO, Traefik, Grafana)..."

docker compose -f infrastructure/docker/docker-compose.infra.yml up -d

log "Waiting for services to be healthy..."
sleep 5

# Wait for PostgreSQL
for i in {1..30}; do
  if docker exec responio-postgres pg_isready -U responio &>/dev/null; then
    ok "PostgreSQL is ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    err "PostgreSQL failed to start after 30 seconds"
  fi
  sleep 1
done

# Wait for Redis
for i in {1..15}; do
  if docker exec responio-redis redis-cli -a dev_redis_password ping &>/dev/null; then
    ok "Redis is ready"
    break
  fi
  if [[ $i -eq 15 ]]; then
    err "Redis failed to start"
  fi
  sleep 1
done

# Wait for NATS
for i in {1..15}; do
  if curl -sf http://localhost:8222/healthz &>/dev/null; then
    ok "NATS is ready"
    break
  fi
  if [[ $i -eq 15 ]]; then
    err "NATS failed to start"
  fi
  sleep 1
done

ok "All infrastructure services healthy"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Responio Dev Environment Ready!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "  Services:"
echo "  • PostgreSQL:  localhost:5432"
echo "  • Redis:       localhost:6379"
echo "  • NATS:        localhost:4222 (monitor: http://localhost:8222)"
echo "  • MinIO:       http://localhost:9001 (console)"
echo "  • Grafana:     http://localhost:3030"
echo "  • Traefik:     http://localhost:8080 (dashboard)"
echo ""
echo -e "${YELLOW}  ⚠  Next steps:${NC}"
echo "  1. Review .env and fill in Stripe API keys"
echo "  2. Apply for WhatsApp BSP (360dialog + Twilio) — STARTS WEEK 1"
echo "  3. Fork Chatwoot: git subtree add --prefix=services/inbox ..."
echo "  4. Run: pnpm install (after checking disk space)"
echo ""
echo "  Docs:"
echo "  • Phase 1 backlog: docs/stories/phase-1-backlog.md"
echo "  • Architecture: docs/architecture/"
echo "  • BMAD agents: .bmad-core/agents/"
echo ""
