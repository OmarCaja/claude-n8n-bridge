import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function setupProjectRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "runner-test-project-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  execSync("git add . && git commit -q -m seed", { cwd: dir });
  return dir;
}

// Stub `claude` binary: sleeps briefly so a second request can land while the
// first is still processing, letting us exercise the isProcessing guard.
function setupFakeClaudeBin() {
  const dir = mkdtempSync(path.join(tmpdir(), "runner-test-bin-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\nsleep 1\nexit 0\n");
  chmodSync(bin, 0o755);
  return dir;
}

async function waitForServer(url) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start in time");
}

test("rejects a missing prompt with 400, rejects a concurrent task with 429", async (t) => {
  const projectDir = setupProjectRepo();
  const binDir = setupFakeClaudeBin();
  const port = 4000 + Math.floor(Math.random() * 1000);
  const token = "test-token";

  const child = spawn("node", ["runner/runner.js"], {
    cwd: path.join(repoRoot, ".."),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PORT: String(port),
      AUTH_TOKEN: token,
      PROJECT_PATH: projectDir,
    },
    stdio: "ignore",
  });
  t.after(() => child.kill());

  const base = `http://localhost:${port}`;
  await waitForServer(base);

  const headers = { "content-type": "application/json", "x-api-token": token };

  const missingPrompt = await fetch(`${base}/api/v1/claude/task`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(missingPrompt.status, 400);

  const first = fetch(`${base}/api/v1/claude/task`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "noop" }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const second = await fetch(`${base}/api/v1/claude/task`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "noop" }),
  });
  assert.equal(second.status, 429);

  await first;
});
