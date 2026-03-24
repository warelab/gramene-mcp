#!/usr/bin/env bash
# One-shot script to bring up the test environment and seed data.
#
# Usage:
#   ./seed/setup-test-env.sh        # start containers + seed
#   ./seed/setup-test-env.sh --down # tear down
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--down" ]]; then
  echo "Tearing down..."
  docker compose down -v
  exit 0
fi

MAX_WAIT=60  # seconds

wait_for() {
  local label="$1" cmd="$2" elapsed=0
  echo "==> Waiting for $label..."
  until eval "$cmd" 2>/dev/null; do
    sleep 2
    elapsed=$((elapsed + 2))
    if (( elapsed >= MAX_WAIT )); then
      echo "    ERROR: $label did not become ready within ${MAX_WAIT}s."
      echo "    Check container logs:  docker compose logs $label"
      exit 1
    fi
  done
  echo "    $label ready. (${elapsed}s)"
}

echo "==> Starting Mongo + Solr containers..."
docker compose up -d

# Show container status immediately so user can see if something failed
echo ""
docker compose ps
echo ""

wait_for "MongoDB" "docker compose exec -T mongo mongosh --eval 'db.runCommand({ping:1})' --quiet"
wait_for "Solr"    "curl -sf http://localhost:8983/solr/admin/cores?action=STATUS"

echo "==> Seeding Solr (creating suggestions core + indexing sample data)..."
docker compose exec -T solr bash /opt/seed/solr-init.sh

echo ""
echo "============================================"
echo "  Test environment is ready!"
echo ""
echo "  MongoDB:  mongodb://localhost:27017/gramene"
echo "  Solr:     http://localhost:8983/solr"
echo "    Cores:  genes, suggestions"
echo ""
echo "  Start the MCP server:"
echo "    MONGO_DB=gramene npm start"
echo ""
echo "  Run the tests (server must be running):"
echo "    npm test"
echo ""
echo "  Tear down:"
echo "    ./seed/setup-test-env.sh --down"
echo "============================================"
