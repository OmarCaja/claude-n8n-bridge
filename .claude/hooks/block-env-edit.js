#!/usr/bin/env node
// PreToolUse: block Read/Edit/Write on .env — it holds AUTH_TOKEN and is
// gitignored on purpose; keep it out of transcripts and out of edits.
import path from "node:path";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const { tool_input } = JSON.parse(input || "{}");
  const filePath = tool_input?.file_path;
  if (filePath && path.basename(filePath) === ".env") {
    console.error(
      "Blocked: .env holds AUTH_TOKEN — edit it directly in your terminal, not through Claude.",
    );
    process.exit(2);
  }
  process.exit(0);
});
