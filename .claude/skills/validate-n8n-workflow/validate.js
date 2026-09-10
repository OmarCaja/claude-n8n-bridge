#!/usr/bin/env node
import fs from "node:fs";

// Node types where n8n treats a missing options key as off/falsy, not its
// documented default — see CLAUDE.md's "Things to know when touching the
// n8n workflow". Each entry is the options keys this workflow relies on.
const REQUIRED_OPTIONS = {
  "n8n-nodes-base.filter": ["ignoreCase"],
  "n8n-nodes-base.switch": ["ignoreCase"],
  "n8n-nodes-base.extractFromFile": ["keepSource"],
};

function validate(workflowPath) {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  const issues = [];

  for (const node of workflow.nodes ?? []) {
    const required = REQUIRED_OPTIONS[node.type];
    if (!required) continue;

    const options = node.parameters?.options ?? {};
    for (const key of required) {
      if (!(key in options)) {
        issues.push(
          `${node.name} (${node.type}): missing "options.${key}" — n8n will silently use its off/falsy behavior, not the documented default.`,
        );
      }
    }
  }

  return issues;
}

const workflowPath = process.argv[2];
if (!workflowPath) {
  console.error("Usage: validate.js <workflow.json>");
  process.exit(1);
}

const issues = validate(workflowPath);
if (issues.length) {
  console.error(`[n8n workflow validation] ${issues.length} issue(s) in ${workflowPath}:`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log(`[n8n workflow validation] ${workflowPath}: OK`);
