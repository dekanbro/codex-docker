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
- Required env var: either `CODEX_TASK` (simple one-shot prompt) or `CODEX_CRON_COMMAND` (custom command).
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

## OpenClaw-style module-spec cron migration

A ready-made job is included at `scripts/cron/github-issue-spec-codex-cron.mjs`.

It:
- Polls GitHub issue events for a label (default `module-spec`).
- Maintains cursor state in `/workspace/.codex/cron/github-issue-spec-state.json`.
- Detects actionable issues with the checked "auto-generate PR" checkbox.
- Skips issues that already have an open PR containing `Fixes #<issue>`.
- Runs `codex run` once per actionable issue.

Set these env vars on `codex-cron`:
- `GH_TOKEN` (required)
- `GITHUB_REPO` (for example `raid-guild/cohort-portal-spike`)
- `MODULE_SPEC_LABEL` (optional, default `module-spec`)
- `GITHUB_ISSUE_SPEC_STATE_PATH` (optional)
- `CODEX_MODEL` (optional)
- `CODEX_BASE_PROMPT` (optional override for agent instructions)
- `CODEX_CRON_COMMAND=node /workspace/scripts/cron/github-issue-spec-codex-cron.mjs`

## OpenClaw-style PR review cron migration

A second job is included at `scripts/cron/github-pr-review-codex-cron.mjs`.

It:
- Monitors repo events for check/deployment failures (`urgent` output).
- Finds PRs with unresolved CodeRabbit threads (`actionable` output + Codex runs).
- Detects PRs where CodeRabbit threads are resolved and commits moved forward (`ready` output).
- Maintains state in `/workspace/.codex/cron/github-pr-review-state.json`.

Set these env vars on `codex-cron` for this mode:
- `GH_TOKEN` (required)
- `GITHUB_REPO` (for example `raid-guild/cohort-portal-spike`)
- `GITHUB_PR_REVIEW_STATE_PATH` (optional)
- `CODEX_MODEL` (optional)
- `CODEX_REVIEW_BASE_PROMPT` (optional)
- `CODEX_CRON_COMMAND=node /workspace/scripts/cron/github-pr-review-codex-cron.mjs`
