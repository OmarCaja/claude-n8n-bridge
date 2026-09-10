---
name: validate-n8n-workflow
description: Check n8n/workflows/*.json for Filter/Switch/Extract From File nodes whose options object is missing a key n8n silently treats as off instead of falling back to its documented default. Use after hand-editing an n8n workflow export, or before pnpm n8n:import.
---

Run the validator against the workflow file:

```bash
node .claude/skills/validate-n8n-workflow/validate.js n8n/workflows/email-to-claude.json
```

Exits non-zero and lists every node/key with a missing option. Fix by adding
the key explicitly to that node's `parameters.options` — see CLAUDE.md's
"Things to know when touching the n8n workflow" for why `{}` isn't safe here
(it already caused case-sensitive matching and a dropped `subject` field).

Known risky node types and the keys they need:
- `n8n-nodes-base.filter` / `n8n-nodes-base.switch` — `ignoreCase`
- `n8n-nodes-base.extractFromFile` — `keepSource`
