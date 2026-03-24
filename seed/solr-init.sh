#!/bin/bash
# Post-startup Solr initialization.
# Recreates cores with explicit schema, then indexes seed data.
# Run manually:  docker compose exec solr bash /opt/seed/solr-init.sh
set -e

SOLR=http://localhost:8983/solr
SEED=/opt/seed

echo "Waiting for Solr to be ready..."
until curl -sf "$SOLR/admin/cores?action=STATUS" > /dev/null 2>&1; do
  sleep 1
done

# --- genes core ---
# Unload and recreate so we start with a clean schema (no stale auto-created fields).
# The {!graph} query parser requires string fields for exact-match traversal,
# but Solr's data-driven schema auto-creates string values as text_general (tokenized),
# which breaks graph traversal. We define the schema explicitly before indexing.
echo "Recreating genes core with explicit schema..."
curl -sf "$SOLR/admin/cores?action=UNLOAD&core=genes&deleteIndex=true&deleteDataDir=true&deleteInstanceDir=true" > /dev/null
curl -sf "$SOLR/admin/cores?action=CREATE&name=genes&configSet=_default" > /dev/null

echo "Applying genes schema..."
curl -sf -X POST "$SOLR/genes/schema" \
  -H "Content-Type: application/json" \
  -d @"$SEED/genes-schema.json" > /dev/null

echo "Indexing gene documents..."
curl -sf -X POST "$SOLR/genes/update/json/docs?commit=true" \
  -H "Content-Type: application/json" \
  -d @"$SEED/genes.json"

# --- suggestions core ---
echo "Recreating suggestions core with explicit schema..."
curl -sf "$SOLR/admin/cores?action=UNLOAD&core=suggestions&deleteIndex=true&deleteDataDir=true&deleteInstanceDir=true" > /dev/null || true
curl -sf "$SOLR/admin/cores?action=CREATE&name=suggestions&configSet=_default" > /dev/null

echo "Applying suggestions schema..."
curl -sf -X POST "$SOLR/suggestions/schema" \
  -H "Content-Type: application/json" \
  -d @"$SEED/suggestions-schema.json" > /dev/null

echo "Indexing suggestions..."
curl -sf -X POST "$SOLR/suggestions/update/json/docs?commit=true" \
  -H "Content-Type: application/json" \
  -d @"$SEED/suggestions.json"

echo "Solr seed data loaded."
