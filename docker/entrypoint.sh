#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-shell}"

case "$MODE" in
  shell)
    # Keep service alive for railway ssh interactive Codex sessions.
    exec sleep infinity
    ;;
  cron)
    if [[ -n "${CODEX_CRON_COMMAND:-}" ]]; then
      exec /bin/bash -lc "$CODEX_CRON_COMMAND"
    fi
    : "${CODEX_TASK:?CODEX_TASK is required for cron mode unless CODEX_CRON_COMMAND is set}"
    exec codex run "$CODEX_TASK"
    ;;
  api)
    # Optional future API/webhook entrypoint.
    exec node api/server.js
    ;;
  *)
    exec "$@"
    ;;
esac
