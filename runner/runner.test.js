import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function setupProjectRepo() {
  const remote = mkdtempSync(path.join(tmpdir(), "runner-test-remote-"));
  execSync("git init -q --bare", { cwd: remote });

  const dir = mkdtempSync(path.join(tmpdir(), "runner-test-project-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  execSync("git add . && git commit -q -m seed", { cwd: dir });
  execSync(`git remote add origin ${remote}`, { cwd: dir });
  execSync("git push -q -u origin HEAD", { cwd: dir });
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

// Spins up the runner against a throwaway project repo and a stubbed `claude`
// binary. Returns the request base URL, auth headers, and the project dir.
async function startRunner(t) {
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

  return {
    base,
    projectDir,
    headers: { "content-type": "application/json", "x-api-token": token },
  };
}

test("offer", async (t) => {
  const { base, headers } = await startRunner(t);

  await t.test("rejects a missing prompt with 400", async () => {
    const res = await fetch(`${base}/api/v1/claude/offer`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(res.status, 400);
  });

  await t.test("rejects a concurrent task with 429", async () => {
    const first = fetch(`${base}/api/v1/claude/offer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "noop", subject: "Test" }),
    });
    await new Promise((r) => setTimeout(r, 200));
    const second = await fetch(`${base}/api/v1/claude/offer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "noop", subject: "Test" }),
    });
    assert.equal(second.status, 429);

    await first;
  });
});

test("blog writes the attachment into the project and rejects a blogName of \"..\"", async (t) => {
  const { base, headers, projectDir } = await startRunner(t);
  const media = Buffer.from("fake-image-bytes").toString("base64");

  const traversal = await fetch(`${base}/api/v1/claude/blog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "noop",
      subject: "Test",
      blogName: "..",
      filename: "cover.png",
      media,
    }),
  });
  assert.equal(traversal.status, 400);

  const ok = await fetch(`${base}/api/v1/claude/blog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "noop",
      subject: "Test",
      blogName: "my-first-post",
      filename: "cover.png",
      media,
    }),
  });
  assert.equal(ok.status, 200);

  const written = readFileSync(
    path.join(projectDir, "public/blogs/my-first-post/cover.png"),
  );
  assert.equal(written.toString(), "fake-image-bytes");
});
