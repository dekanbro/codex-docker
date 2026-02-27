#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-shell}"

case "$MODE" in
  shell)
    # Keep service alive for railway ssh interactive Codex sessions.
    exec sleep infinity
    ;;
  cron)
    codex_auth_dir="${CODEX_AUTH_DIR:-${HOME:-/root}/.codex}"
    codex_auth_file="$codex_auth_dir/auth.json"
    if [[ -n "${CODEX_AUTH:-}" ]]; then
      mkdir -p "$codex_auth_dir"
      # Do not overwrite an existing auth file by default; Codex rotates refresh
      # tokens and persists them to disk. Overwriting with stale CODEX_AUTH can
      # cause refresh_token_reused failures.
      if [[ "${CODEX_AUTH_OVERWRITE:-0}" == "1" || ! -s "$codex_auth_file" ]]; then
        printf '%s' "$CODEX_AUTH" > "$codex_auth_file"
        chmod 600 "$codex_auth_file"
      fi
    fi

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
