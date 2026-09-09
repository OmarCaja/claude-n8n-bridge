# claude-n8n-bridge

Local orchestrator that lets n8n workflows trigger [Claude Code](https://claude.com/claude-code) CLI runs against a target repository. n8n receives an external event (e.g. an email), calls a local Express webhook, which runs `claude -p "<prompt>"` against a project on disk, then commits and pushes whatever Claude changed.

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in AUTH_TOKEN and PROJECT_PATH
pnpm start             # starts n8n (Docker) + the runner
```

Then open n8n at [http://localhost:5678](http://localhost:5678) and build (or import, see below) the workflow that calls the runner.

## Configuration

Set via `.env` (see `.env.example`), loaded with Node's `--env-file-if-exists` — no `dotenv` dependency.

| Variable        | Required | Default | Description                                                                 |
|-----------------|----------|---------|-------------------------------------------------------------------------------|
| `PORT`          | no       | `3000`  | Port the runner listens on.                                                   |
| `AUTH_TOKEN`    | yes      | —       | Shared secret n8n must send as `x-api-token` on every request.                |
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
| `subject`| no       | Used as the commit message subject (`auto(claude): <subject>`). |

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
| `subject`   | no       | Used as the commit message subject.                                          |
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

### Email to Claude - Offers

`n8n/workflows/email-to-claude.json` is three nodes: an IMAP trigger, a Filter node that only lets through mail from `farmaciaalbinyana@gmail.com`, and an HTTP Request node that forwards the raw email body straight to `/api/v1/claude/offer`. Offer emails aren't parsed into structured fields in n8n — the format varies between emails, so Claude reads the raw text itself (subject + body wrapped in an instruction) and decides how many offers it describes and how to add/update each one on the offers page. After `pnpm n8n:import`, open the workflow in n8n and set up two credentials it references but can't carry secrets for:

- An **IMAP** credential (on the "New Offer Email" trigger) — your mailbox's IMAP settings.
- A **Header Auth** credential (on the "Call Runner /offer" HTTP Request node) — Name: `x-api-token`, Value: your `AUTH_TOKEN`.

The blog pipeline (routing blog emails to `/api/v1/claude/blog` with an attachment) isn't built yet — this workflow only handles offers for now.

## Development

```bash
pnpm runner:dev   # runner with --watch (auto-restart on change)
pnpm test         # node --test
```

See [CLAUDE.md](CLAUDE.md) for architecture notes and implementation details.
