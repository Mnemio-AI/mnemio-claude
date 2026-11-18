---
description: Sync this project's memory, skills and answers to Mnemio (or stop, with "off")
argument-hint: "[off]"
allowed-tools: Bash(node:*)
---
If the user passed `off`, run with the Bash tool: `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" stop-sync-here`
Otherwise run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" sync-here`

Tell the user in one line which folder now syncs (or stopped syncing). Syncing means: what Claude remembers in this project, the project's `.claude/skills`, and Claude's answers here go to their Mnemio memory, where the workspace's sharing rules apply. They can review it in Mnemio → Settings → Claude.
