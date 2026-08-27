#!/usr/bin/env bash
# Bring up local dev dependencies (Postgres dev + test, Redis).
set -euo pipefail

docker compose up -d

echo "Waiting for services to be healthy..."
until [ "$(docker inspect -f '{{.State.Health.Status}}' rentals-postgres-dev)" = "healthy" ] && \
      [ "$(docker inspect -f '{{.State.Health.Status}}' rentals-postgres-test)" = "healthy" ] && \
      [ "$(docker inspect -f '{{.State.Health.Status}}' rentals-redis-dev)" = "healthy" ]; do
  sleep 1
done

echo "Dev services ready:"
echo "  Postgres (dev):  postgresql://rentals:rentals@localhost:5434/rentals_dev"
echo "  Postgres (test): postgresql://rentals:rentals@localhost:5433/rentals_test"
echo "  Redis:           redis://localhost:6380"
