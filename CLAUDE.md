# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local orchestrator that lets n8n workflows trigger Claude Code CLI runs against a target repository. n8n (running in Docker) receives external events (e.g. email), calls a local Express webhook, which shells out to `claude --dangerously-skip-permissions -p "<prompt>"` against `PROJECT_PATH`, then commits and pushes the result.

## Commands

```bash
pnpm install         # install dependencies
pnpm start           # docker compose up, then the runner (sequential)
pnpm docker:up       # start n8n only (localhost:5678)
pnpm docker:down     # stop n8n
pnpm runner          # run the Express webhook server alone
pnpm runner:dev      # runner with --watch (auto-restart on change)
pnpm n8n:export      # export all n8n workflows to n8n/workflows/
pnpm n8n:import      # import n8n/workflows/email-to-claude.json into n8n
```

There is no build, lint, or test tooling in this repo.

## Architecture

- **`runner/runner.js`** — the entire service. A single Express app with one route, `POST /api/v1/claude/task`, protected by an `x-api-token` header checked against `AUTH_TOKEN`.
- **Concurrency**: a module-level `isProcessing` flag rejects (`429`) any request that arrives while a previous task is still running, since tasks mutate `PROJECT_PATH`'s git working tree.
- **Request flow**: `{ prompt, subject }` in → prompt/subject are passed as env vars (`RUNNER_PROMPT`/`RUNNER_SUBJECT`) to a shell command that runs `claude -p "$RUNNER_PROMPT"` in `PROJECT_PATH`, then `git add . && git commit && git push` only if there are staged changes → stdout/stderr returned as JSON. (Attachment upload support was removed; re-add if needed.)
- **n8n side**: `n8n/workflows/email-to-claude.json` is the workflow export (currently an empty placeholder — regenerate it with `pnpm n8n:export` after building the real workflow in n8n). `docker-compose.yml` runs n8n only; the runner itself is not containerized and runs on the host so it can invoke the `claude` CLI and reach `PROJECT_PATH` directly. n8n reaches the host runner via `host.docker.internal` (enabled through `extra_hosts`).
- **Config** is entirely env-driven via `.env` (see `.env.example`, loaded with Node's `--env-file-if-exists`, no `dotenv` dependency): `PORT`, `AUTH_TOKEN`, `PROJECT_PATH` (absolute path to the target git repo Claude Code will operate on).

## Things to know when touching runner.js

- Prompt/subject reach the shell via `env`, not string interpolation, so no manual escaping is needed — this is deliberate, don't revert to building the command string with template literals.
- A run that changes nothing is not an error: commit/push are skipped (via `git diff --cached --quiet`) rather than failing on a non-zero `git commit` exit code.
- Every successful task with changes pushes directly to whatever branch `PROJECT_PATH` is checked out on — there's no dry-run or review step before `git push`.
- A killed timeout (5 min) can leave the target repo's tree dirty mid-commit — see the `ponytail:` comment in runner.js.
