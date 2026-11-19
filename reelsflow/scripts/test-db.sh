#!/usr/bin/env bash
# Aplica o shim do Supabase + todas as migrations num banco limpo e roda os
# testes de RLS.
#
# - Com DATABASE_ADMIN_URL definido (CI), usa esse servidor.
# - Sem ele, sobe um cluster Postgres efêmero local (requer binários do
#   Postgres instalados) e o remove ao final.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="reelsflow_test"
CLEANUP=""

if [[ -z "${DATABASE_ADMIN_URL:-}" ]]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [[ -x "$PG_BIN/initdb" ]] || { echo "Postgres não encontrado. Defina DATABASE_ADMIN_URL." >&2; exit 1; }
  TMP="$(mktemp -d)"
  PORT="${PGTEST_PORT:-54329}"
  RUN=()
  if [[ "$(id -u)" == "0" ]]; then
    chown postgres "$TMP"
    RUN=(runuser -u postgres --)
  fi
  "${RUN[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
  "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
  CLEANUP="$TMP"
  trap '"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$CLEANUP/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "$CLEANUP"' EXIT
  DATABASE_ADMIN_URL="postgresql://postgres@/postgres?host=$TMP&port=$PORT"
  TEST_URL="postgresql://postgres@/$DB_NAME?host=$TMP&port=$PORT"
else
  TEST_URL="${DATABASE_ADMIN_URL%/*}/$DB_NAME"
fi

psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB_NAME" -c "create database $DB_NAME encoding 'UTF8' template template0"
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/supabase-shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ migration $(basename "$f")"
  psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

export DATABASE_URL="$TEST_URL"
echo "→ testes de RLS"
(cd "$ROOT/supabase/tests" && pnpm exec vitest run "$@")
echo "→ testes de integração do worker"
(cd "$ROOT/apps/worker" && pnpm exec vitest run "$@")
