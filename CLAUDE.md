# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local orchestrator that lets n8n workflows trigger Claude Code CLI runs against a target repository. n8n (running in Docker) receives external events (e.g. email), calls a local Express webhook, which shells out to `claude --dangerously-skip-permissions -p "<prompt>"` against `PROJECT_PATH`, then commits and pushes the result. A second route accepts an email with an image attachment and writes it into `PROJECT_PATH` before invoking Claude.

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

There is no build or lint tooling in this repo. Tests: `pnpm test` (`node --test` on `runner/runner.test.js`).

## Architecture

- **`runner/runner.js`** — the entire service. A single Express app with two routes, both protected by an `x-api-token` header checked against `AUTH_TOKEN`:
  - `POST /api/v1/claude/offer` — `{ prompt, subject }` in.
  - `POST /api/v1/claude/blog` — `{ prompt, subject, blogName, filename, media }` in, where `media` is base64 and the file is written to `PROJECT_PATH/public/blogs/<blogName>/<filename>` (`blogName`/`filename` are sanitized to single path segments via `path.basename`, then double-checked to resolve inside `public/blogs`). Writes the file first, then runs the same task pipeline as `/offer` so the prompt and commit can see it.
- **Concurrency**: a module-level `isProcessing` flag rejects (`429`) any request that arrives while a previous task is still running, since tasks mutate `PROJECT_PATH`'s git working tree.
- **Request flow** (shared by both routes via `runClaudeTask`): prompt/subject are passed as env vars (`RUNNER_PROMPT`/`RUNNER_SUBJECT`) to a shell command that runs `claude -p "$RUNNER_PROMPT"` in `PROJECT_PATH`, then `git add . && git commit && git push` only if there are staged changes → stdout/stderr returned as JSON.
- **n8n side**: `n8n/workflows/email-to-claude.json` is the "Email to Claude - Offers" workflow export — IMAP trigger → Filter (sender must contain `farmaciaalbinyana@gmail.com`) → HTTP Request to `/api/v1/claude/offer`. The raw email subject/body is forwarded as-is inside the prompt; n8n does no structured parsing of the offer rows (email formatting varies, so Claude interprets it directly rather than a regex/Code node). `docker-compose.yml` runs n8n only; the runner itself is not containerized and runs on the host so it can invoke the `claude` CLI and reach `PROJECT_PATH` directly. n8n reaches the host runner via `host.docker.internal` (enabled through `extra_hosts`).
- **Config** is entirely env-driven via `.env` (see `.env.example`, loaded with Node's `--env-file-if-exists`, no `dotenv` dependency): `PORT`, `AUTH_TOKEN`, `PROJECT_PATH` (absolute path to the target git repo Claude Code will operate on), `MAX_FILE_SIZE` (express body-size limit, e.g. `20mb`; caps the base64 `media` payload on `/blog`).

## Things to know when touching runner.js

- Prompt/subject reach the shell via `env`, not string interpolation, so no manual escaping is needed — this is deliberate, don't revert to building the command string with template literals.
- A run that changes nothing is not an error: commit/push are skipped (via `git diff --cached --quiet`) rather than failing on a non-zero `git commit` exit code.
- Every successful task with changes pushes directly to whatever branch `PROJECT_PATH` is checked out on — there's no dry-run or review step before `git push`.
- A killed timeout (5 min) can leave the target repo's tree dirty mid-commit — see the `ponytail:` comment in runner.js.
