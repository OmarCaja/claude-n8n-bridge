import express from "express";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PROJECT_PATH = process.env.PROJECT_PATH;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE || "20mb";
const SKIP_GIT = process.env.SKIP_GIT === "true";

// Validate required environment variables
for (const [name, value] of Object.entries({ PROJECT_PATH, AUTH_TOKEN })) {
  if (!value) {
    console.error(
      `[-] Critical error: ${name} is not defined in the .env file`,
    );
    process.exit(1);
  }
}

if (!fs.statSync(PROJECT_PATH, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(
    `[-] Critical error: PROJECT_PATH does not point to an existing directory: ${PROJECT_PATH}`,
  );
  process.exit(1);
}

const AUTH_TOKEN_BUFFER = Buffer.from(AUTH_TOKEN);

// Auth runs before body parsing
const authenticate = (req, res, next) => {
  const clientToken = req.headers["x-api-token"];
  const clientBuffer = Buffer.from(clientToken || "");
  const valid =
    clientBuffer.length === AUTH_TOKEN_BUFFER.length &&
    crypto.timingSafeEqual(clientBuffer, AUTH_TOKEN_BUFFER);
  if (!valid) {
    return res
      .status(401)
      .json({ error: "Unauthorized: invalid or missing token" });
  }
  next();
};

app.use(authenticate);

// ponytail: base64 inflates payload size ~33%, so MAX_FILE_SIZE should be set
// higher than the largest raw attachment expected.
app.use(express.json({ limit: MAX_FILE_SIZE }));

// Concurrency guard to avoid simultaneous runs against the same repository
let isProcessing = false;

// Runs `claude -p <prompt>` against PROJECT_PATH, then commits and pushes any
// resulting changes. Shared by both routes; the media route just writes the
// attachment to disk first so `git add .` and the prompt can see it.
function runClaudeTask(res, prompt, subject) {
  isProcessing = true;
  console.log(
    `\n[+] [${new Date().toLocaleTimeString()}] New task received: ${subject}${SKIP_GIT ? " (SKIP_GIT: commit/push will be skipped)" : ""}`,
  );

  // Prompt/subject travel via env vars (not string-interpolated into the shell command)
  // so no manual escaping is needed and shell metacharacters in them can't inject commands.
  // Skip the commit+push when Claude made no changes, so a no-op run isn't reported as a failure.
  const command = SKIP_GIT
    ? 'claude --dangerously-skip-permissions -p "$RUNNER_PROMPT"'
    : 'claude --dangerously-skip-permissions -p "$RUNNER_PROMPT" && ' +
      "git add . && " +
      '(git diff --cached --quiet || (git commit -m "$RUNNER_SUBJECT" && git push))';

  // ponytail: a timeout kill can land mid-git-commit, leaving the tree dirty for the next
  // request. Fine for a single-operator local tool; add a `git status --porcelain` check
  // before starting a task if this ever needs to be robust to that.
  exec(
    command,
    {
      cwd: PROJECT_PATH,
      env: {
        ...process.env,
        RUNNER_PROMPT: prompt,
        RUNNER_SUBJECT: `auto(claude): ${subject}`,
      },
      maxBuffer: 1024 * 1024 * 10,
      timeout: 300000,
    },
    (error, stdout, stderr) => {
      isProcessing = false;

      if (error) {
        console.error(`[-] Execution error: ${error.message}`);
        return res.status(500).json({
          status: "error",
          message: "Failed to run Claude Code or complete the Git operations",
          detail: error.message,
          stdout,
          stderr,
        });
      }

      console.log(
        SKIP_GIT
          ? "[+] Task completed. SKIP_GIT is set, so no commit/push was made."
          : "[+] Task completed and changes pushed to Git successfully.",
      );
      return res.status(200).json({
        status: "success",
        message: "Code and assets processed successfully",
        output: stdout,
      });
    },
  );
}

// Creates/edits an offer: no attachment, just a prompt for Claude to act on.
app.post("/api/v1/claude/offer", (req, res) => {
  const { prompt, subject } = req.body;

  for (const [name, value] of Object.entries({ prompt, subject })) {
    if (!value) {
      return res.status(400).json({ error: `The "${name}" field is required` });
    }
  }

  if (isProcessing) {
    return res.status(429).json({
      error: "Busy",
      message:
        "Another task is already running against the target repository. Retry shortly.",
    });
  }

  runClaudeTask(res, prompt, subject);
});

const BLOGS_DIR = path.join(PROJECT_PATH, "public", "blogs");

// Creates a blog post: writes its image (at public/blogs/<blogName>/<filename>)
// before invoking Claude, then runs the same pipeline as /offer.
app.post("/api/v1/claude/blog", (req, res) => {
  const { prompt, subject, blogName, filename, media } = req.body;

  for (const [name, value] of Object.entries({
    prompt,
    subject,
    blogName,
    filename,
    media,
  })) {
    if (!value) {
      return res.status(400).json({ error: `The "${name}" field is required` });
    }
  }

  // path.basename strips any directory components, so blogName/filename can only
  // ever be a single folder/file name each. Still confirm the result lands inside
  // BLOGS_DIR: basename(".") and basename("..") pass through unchanged.
  const destination = path.join(
    BLOGS_DIR,
    path.basename(blogName),
    path.basename(filename),
  );
  if (!destination.startsWith(BLOGS_DIR + path.sep)) {
    return res
      .status(400)
      .json({ error: '"blogName" must be a valid folder name' });
  }

  if (isProcessing) {
    return res.status(429).json({
      error: "Busy",
      message:
        "Another task is already running against the target repository. Retry shortly.",
    });
  }

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(media, "base64"));
  } catch (err) {
    console.error(`[-] Failed to write attachment: ${err.message}`);
    return res.status(500).json({
      status: "error",
      message: "Failed to write the attachment to the project",
      detail: err.message,
    });
  }

  runClaudeTask(res, prompt, subject);
});

app.listen(PORT, HOST, () => {
  console.log(`[+] Runner listening on http://${HOST}:${PORT}`);
  console.log(`[+] Target repository configured: ${PROJECT_PATH}`);
  console.log(
    SKIP_GIT
      ? "[+] SKIP_GIT is enabled: tasks will run Claude only, no commit/push."
      : "[+] SKIP_GIT is disabled: tasks will commit and push changes.",
  );
});
