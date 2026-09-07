import express from "express";
import { exec } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const PROJECT_PATH = process.env.PROJECT_PATH;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

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

app.use(express.json());

// Concurrency guard to avoid simultaneous runs against the same repository
let isProcessing = false;

app.post("/api/v1/claude/task", (req, res) => {
  const { prompt, subject } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'The "prompt" field is required' });
  }

  if (isProcessing) {
    return res.status(429).json({
      error: "Busy",
      message:
        "Another task is already running against the target repository. Retry shortly.",
    });
  }

  isProcessing = true;
  console.log(
    `\n[+] [${new Date().toLocaleTimeString()}] New task received: ${subject || "No subject"}`,
  );

  const commitSubject = subject || "Code update";

  // Prompt/subject travel via env vars (not string-interpolated into the shell command)
  // so no manual escaping is needed and shell metacharacters in them can't inject commands.
  // Skip the commit+push when Claude made no changes, so a no-op run isn't reported as a failure.
  const command =
    'claude --dangerously-skip-permissions -p "$RUNNER_PROMPT" && ' +
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
        RUNNER_SUBJECT: `auto(claude): ${commitSubject}`,
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

      console.log("[+] Task completed and changes pushed to Git successfully.");
      return res.status(200).json({
        status: "success",
        message: "Code and assets processed successfully",
        output: stdout,
      });
    },
  );
});

app.listen(PORT, () => {
  console.log(`[+] Runner listening on http://localhost:${PORT}`);
  console.log(`[+] Target repository configured: ${PROJECT_PATH}`);
});
