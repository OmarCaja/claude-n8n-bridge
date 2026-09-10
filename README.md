# claude-n8n-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6.0-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/maintained%20with-pnpm-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)

Local orchestrator that lets n8n workflows trigger [Claude Code](https://claude.com/claude-code) CLI runs against a target repository. n8n receives an external event (e.g. an email), calls a local Express webhook, which runs `claude -p "<prompt>"` against a project on disk, then commits and pushes whatever Claude changed.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API](#api)
- [n8n workflows](#n8n-workflows)
- [Development](#development)
- [License](#license)

## Requirements

- [Node.js](https://nodejs.org) >= 20.6.0
- [pnpm](https://pnpm.io)
- [Docker](https://www.docker.com) (runs n8n; the runner itself runs on the host)
- The [Claude Code](https://claude.com/claude-code) CLI, authenticated and on `PATH`

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in AUTH_TOKEN and PROJECT_PATH
pnpm start             # starts n8n (Docker) + the runner
```

Then open n8n at [http://localhost:5678](http://localhost:5678) and build (or import, see below) the workflow that calls the runner.

## Configuration

Set via `.env` (see `.env.example`), loaded with Node's `--env-file-if-exists` — no `dotenv` dependency.

| Variable        | Required | Default       | Description                                                                 |
|-----------------|----------|---------------|-------------------------------------------------------------------------------|
| `PORT`          | no       | `3000`        | Port the runner listens on.                                                   |
| `HOST`          | no       | `127.0.0.1`   | Interface the runner binds to. Loopback-only by default; set `0.0.0.0` only if your deployment needs it (e.g. native Linux Docker, where `host.docker.internal` hits the bridge gateway, not loopback). |
| `AUTH_TOKEN`    | yes      | —             | Shared secret n8n must send as `x-api-token` on every request.                |
| `PROJECT_PATH`  | yes      | —       | Absolute path to the git repo Claude Code will edit, commit, and push.        |
| `MAX_FILE_SIZE` | no       | `20mb`  | Body-size limit for requests; caps the base64 `media` payload on `/blog`.      |
| `SKIP_GIT`      | no       | `false` | Testing only: run `claude` but skip `git add`/`commit`/`push` entirely.       |

## API

Both endpoints require an `x-api-token` header matching `AUTH_TOKEN`, and reject a request with `429` while another task is still running (tasks mutate `PROJECT_PATH`'s git working tree, so they're serialized).

### `POST /api/v1/claude/offer`

Runs a prompt against the project — for creating or editing an offer, no attachment involved.

```json
{
  "prompt": "Add a 20% summer discount banner to the homepage",
  "subject": "Summer offer"
}
```

| Field    | Required | Description                                          |
|----------|----------|-------------------------------------------------------|
| `prompt` | yes      | Instruction passed to `claude -p`.                     |
| `subject`| yes      | Used as the commit message subject (`auto(claude): <subject>`). |

### `POST /api/v1/claude/blog`

Writes an image into the project, then runs the same pipeline as `/offer` — for creating a blog post from an email with an attachment.

```json
{
  "prompt": "Write a blog post about sun protection using the attached cover image",
  "subject": "New blog post",
  "blogName": "blog-about-sun-protection",
  "filename": "cover.png",
  "media": "<base64-encoded image>"
}
```

| Field       | Required | Description                                                                 |
|-------------|----------|-------------------------------------------------------------------------------|
| `prompt`    | yes      | Instruction passed to `claude -p`.                                            |
| `subject`   | yes      | Used as the commit message subject.                                          |
| `blogName`  | yes      | Slug for the blog post; the image is written to `PROJECT_PATH/public/blogs/<blogName>/<filename>`. |
| `filename`  | yes      | Name of the image file to write (e.g. `cover.png`).                          |
| `media`     | yes      | Base64-encoded image bytes.                                                   |

### Responses

- `200` — `{ "status": "success", "output": "<claude/git stdout>" }`
- `400` — missing/invalid field.
- `401` — missing or wrong `x-api-token`.
- `429` — another task is already running.
- `500` — Claude, git, or the attachment write failed (`detail`/`stdout`/`stderr` included).

## n8n workflows

```bash
pnpm n8n:export   # export all n8n workflows to n8n/workflows/
pnpm n8n:import   # import n8n/workflows/email-to-claude.json into n8n
```

n8n runs in Docker (`pnpm docker:up` / `pnpm docker:down`); the runner itself runs on the host so it can invoke the `claude` CLI and reach `PROJECT_PATH` directly. n8n reaches it via `http://host.docker.internal:<PORT>`.

### Email to Claude - Offers & Blog

`n8n/workflows/email-to-claude.json`: an IMAP trigger (**New Pharmacy Email**) → a Filter node (**Is From Pharmacy Mailbox**) that only lets through mail from `farmaciaalbinyana@gmail.com` → a Switch node (**Route by Subject**) that routes on the (case-insensitive) email subject — containing "oferta" goes to the offer branch, containing "blog" goes to the blog branch; anything else is silently dropped.

The trigger uses IMAP **resolved** format (full MIME parsing via mailparser), not the default `simple` format — `simple` only picks up attachments with `Content-Disposition: attachment`, which misses images pasted or embedded inline in the email body. `resolved` captures both, all under the same `attachment_0`-style binary keys, and it decodes MIME-encoded subjects (accented characters) for free.

- **Offer branch**: forwards the raw email body straight to `/api/v1/claude/offer`, with a prompt that invokes the target repo's `/add-offer` skill directly. Offer emails aren't parsed into structured fields in n8n — the format varies between emails, so Claude reads the raw text itself and decides how many offers it describes and how to add/update each one on the offers page.
- **Blog branch**: an Extract From File node (**Attachment to Base64**) converts the email's first attachment (`attachment_0`) into a base64 string, keeping the rest of the item's fields (`options.keepSource: "json"` — without it, this node drops everything except the new field). An HTTP Request node then calls `/api/v1/claude/blog`, with a prompt invoking the target repo's `/add-blog` skill. `blogName` is derived from the subject — an email titled `Blog - Sun Protection Tips` becomes `Sun-Protection-Tips` (everything after `Blog - `, case-insensitive, spaces replaced with hyphens). `filename` comes from the attachment's original name.

After `pnpm n8n:import`, open the workflow in n8n and set up two credentials it references but can't carry secrets for:

- An **IMAP** credential (on the "New Pharmacy Email" trigger) — your mailbox's IMAP settings.
- A **Header Auth** credential (on both "Call Runner /offer" and "Call Runner /blog" HTTP Request nodes) — Name: `x-api-token`, Value: your `AUTH_TOKEN`.

Both HTTP Request nodes retry automatically (5 tries, 60s apart) on failure — including the `429` the runner returns while another task is already running — so a busy runner doesn't drop an email.

## Development

```bash
pnpm runner:dev   # runner with --watch (auto-restart on change)
pnpm test         # node --test
```

See [CLAUDE.md](CLAUDE.md) for architecture notes and implementation details.

## License

[MIT](LICENSE) © Omar Caja
