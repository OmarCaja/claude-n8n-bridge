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
  - `POST /api/v1/claude/offer` — `{ prompt, subject }` in, both required.
  - `POST /api/v1/claude/blog` — `{ prompt, subject, blogName, filename, media }` in, all required, where `media` is base64 and the file is written to `PROJECT_PATH/public/blogs/<blogName>/<filename>` (`blogName`/`filename` are sanitized to single path segments via `path.basename`, then double-checked to resolve inside `public/blogs`). Writes the file first, then runs the same task pipeline as `/offer` so the prompt and commit can see it.
- **Concurrency**: a module-level `isProcessing` flag rejects (`429`) any request that arrives while a previous task is still running, since tasks mutate `PROJECT_PATH`'s git working tree.
- **Request flow** (shared by both routes via `runClaudeTask`): prompt/subject are passed as env vars (`RUNNER_PROMPT`/`RUNNER_SUBJECT`) to a shell command that runs `claude -p "$RUNNER_PROMPT"` in `PROJECT_PATH`, then `git add . && git commit && git push` only if there are staged changes → stdout/stderr returned as JSON. Logging (startup, per-task, and completion) reflects `SKIP_GIT` accurately — it never claims a push happened when git was skipped.
- **n8n side**: `n8n/workflows/email-to-claude.json` is the "Email to Claude - Offers & Blog" workflow export — an IMAP trigger (**New Pharmacy Email**, using `format: resolved` so it captures inline/pasted attachments via mailparser, not just `Content-Disposition: attachment` parts) → a Filter (**Is From Pharmacy Mailbox**, sender must exactly equal `farmaciaalbinyana@gmail.com` — this is the only gate before an email can trigger an unreviewed `--dangerously-skip-permissions` Claude run, so it must stay `equals`, not `contains`, which a spoofable subdomain sender could satisfy as a substring) → a Switch (**Route by Subject**) that branches on subject containing "oferta" vs "blog" (case-insensitive, anything else is dropped). The offer branch forwards straight to `/api/v1/claude/offer` with a prompt that invokes the target repo's `/add-offer` skill; the blog branch runs an Extract From File node (**Attachment to Base64**) to base64-encode `attachment_0`, then calls `/api/v1/claude/blog` with a prompt invoking `/add-blog`. n8n does no structured parsing of email content itself — Claude reads the raw subject/body via the skill. `docker-compose.yml` runs n8n only; the runner itself is not containerized and runs on the host so it can invoke the `claude` CLI and reach `PROJECT_PATH` directly. n8n reaches the host runner via `host.docker.internal` (enabled through `extra_hosts`).
- **Config** is entirely env-driven via `.env` (see `.env.example`, loaded with Node's `--env-file-if-exists`, no `dotenv` dependency): `PORT`, `HOST` (defaults to `127.0.0.1` so the webhook isn't reachable off the host; set to `0.0.0.0` only if the deployment needs it, e.g. native Linux Docker where `host.docker.internal` hits the bridge gateway, not loopback), `AUTH_TOKEN`, `PROJECT_PATH` (absolute path to the target git repo Claude Code will operate on), `MAX_FILE_SIZE` (express body-size limit, e.g. `20mb`; caps the base64 `media` payload on `/blog`), `SKIP_GIT` (testing only: run `claude` but skip `git add`/`commit`/`push`).

## Things to know when touching runner.js

- Prompt/subject reach the shell via `env`, not string interpolation, so no manual escaping is needed — this is deliberate, don't revert to building the command string with template literals.
- A run that changes nothing is not an error: commit/push are skipped (via `git diff --cached --quiet`) rather than failing on a non-zero `git commit` exit code.
- Every successful task with changes pushes directly to whatever branch `PROJECT_PATH` is checked out on — there's no dry-run or review step before `git push`.
- A killed timeout (5 min) can leave the target repo's tree dirty mid-commit — see the `ponytail:` comment in runner.js.

## Things to know when touching the n8n workflow

- **Hand-editing `email-to-claude.json` directly (not through the n8n UI) is risky for any node with an `options` collection** (Filter, Switch, Extract From File, etc.). Several of these nodes read option values like `ignoreCase` or `keepSource` straight off the raw stored object rather than falling back to their documented default when the key is simply absent — so `"options": {}` silently behaves as if that option were off/falsy, not as its schema default. Always set every option the workflow actually relies on explicitly (e.g. `{"ignoreCase": true}`, `{"keepSource": "json"}`) rather than trusting an empty `{}` to mean "use the default." This caused three separate bugs in this workflow's history (case-sensitive matching, and the blog branch silently dropping `subject`).
- The IMAP trigger uses `format: "resolved"` specifically so inline/pasted images count as attachments — the default `simple` format's `downloadAttachments` only grabs parts with `Content-Disposition: attachment`, missing anything embedded via `cid:` reference (a common result of pasting an image into a mail client).
- The IMAP trigger (n8n ≥ 2.43, `imapflow`-based) does NOT search on activation: it only searches on a new-mail `EXISTS` or after each `forceReconnect` reconnect (which calls `catchUp()`). So catch-up relies on: `customEmailConfig` `["UNSEEN", ["FROM", <pharmacy>]]` (any unread pharmacy mail, however old — scoped by sender so startup doesn't mark the rest of the inbox read; the Filter stays the exact-match gate since IMAP `FROM` is substring), `trackLastMessageId: false` (no UID/date cutoff, in case the UI upgrades the node past v2), and `forceReconnect: 1` (first search ~1 min after n8n starts, and marking an email unread re-triggers it within a minute). Don't switch to `FLAGGED`: post-process can only mark read, not unflag, so starred mail would re-run on every reconnect.
- Both HTTP nodes use `batching` `batchSize: 1, batchInterval: 360000` because n8n fires all items' requests concurrently; when several unread emails are caught up at once, the runner would `429` all but one and `retryOnFail` would re-send the whole batch (duplicate runs). The 6-min gap exceeds the runner's 5-min task timeout. ponytail: crude spacing, replace with a runner-side queue if catch-up batches get large.
- After any `n8n import:workflow`, the workflow is deactivated — it must be manually reactivated in the n8n UI for the IMAP trigger to actually poll.
- Editing the workflow live in the n8n UI and periodically re-importing this file can drift out of sync — if debugging live behavior that doesn't match the file, re-import fresh to rule out UI-side drift before looking for a logic bug.
