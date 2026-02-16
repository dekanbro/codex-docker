# Railway Codex Docker Template

This template is optimized for Railway using one Docker image with mode-based startup.

## Why this setup

- Uses Railway SSH instead of running an SSH daemon in the container.
- Uses Railway Cron Jobs instead of in-container `cron`.
- Uses Playwright base image for browser automation support.

## Files

- `Dockerfile`: Playwright + Codex CLI image.
- `docker/entrypoint.sh`: supports `shell`, `cron`, and optional `api` modes.
- `.dockerignore`: keeps build context lean.

## Railway service pattern

Create two services from this same repo/image:

1. `codex-shell`
- Start command: `/usr/local/bin/entrypoint.sh shell`
- Purpose: always-on service for interactive sessions via `railway ssh`.

2. `codex-cron`
- Start command: `/usr/local/bin/entrypoint.sh cron`
- Purpose: scheduled task runner.
- Required env var: `CODEX_TASK` (prompt/instruction for the run).
- Configure schedule in Railway Cron settings.

Optional later:

3. `codex-api`
- Start command: `/usr/local/bin/entrypoint.sh api`
- Your server must listen on `0.0.0.0:$PORT`.

## SSH usage

Railway-managed shell into the running `codex-shell` container:

```bash
railway ssh --service codex-shell
```

Then run Codex commands interactively inside `/workspace`.

## Notes

- Persist workspace/state with a Railway volume mounted at `/workspace` if needed.
- Keep secrets in Railway environment variables.
