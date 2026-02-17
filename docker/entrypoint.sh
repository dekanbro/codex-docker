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
      # Helpful validation for the common pattern: CODEX_CRON_COMMAND="node /workspace/scripts/cron/<file>.mjs"
      if [[ "$CODEX_CRON_COMMAND" =~ ^node[[:space:]]+([^[:space:]]+) ]]; then
        script_path="${BASH_REMATCH[1]}"
        if [[ ! -f "$script_path" ]]; then
          echo "ERROR: CODEX_CRON_COMMAND points to missing script: $script_path" >&2
          echo "Current CODEX_CRON_COMMAND: $CODEX_CRON_COMMAND" >&2
          echo "Available files in /workspace/scripts/cron:" >&2
          ls -1 /workspace/scripts/cron >&2 || true
          exit 1
        fi
      fi
      exec /bin/bash -lc "$CODEX_CRON_COMMAND"
    fi
    : "${CODEX_TASK:?CODEX_TASK is required for cron mode unless CODEX_CRON_COMMAND is set}"
    exec codex exec --skip-git-repo-check "$CODEX_TASK"
    ;;
  api)
    # Optional future API/webhook entrypoint.
    exec node api/server.js
    ;;
  *)
    exec "$@"
    ;;
esac
