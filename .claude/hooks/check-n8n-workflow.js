#!/usr/bin/env node
// PostToolUse: after editing an n8n workflow export, re-run the options
// validator so a silently-wrong `options: {}` gets caught immediately
// instead of surfacing later as a live workflow bug (see CLAUDE.md).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(
  here,
  "..",
  "skills",
  "validate-n8n-workflow",
  "validate.js",
);

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const { tool_input } = JSON.parse(input || "{}");
  const filePath = tool_input?.file_path;
  if (!filePath || !filePath.includes("n8n/workflows/") || !filePath.endsWith(".json")) {
    process.exit(0);
  }
  try {
    execFileSync("node", [validator, filePath], { stdio: "inherit" });
  } catch {
    process.exit(2); // surfaces the validator's stderr to Claude so it can fix it
  }
  process.exit(0);
});
