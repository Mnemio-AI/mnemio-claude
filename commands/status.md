---
description: Show which Mnemio workspace this Claude is connected to and what it syncs
allowed-tools: Bash(node:*)
---
Run with the Bash tool: `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" status`

Summarise it for the user in a few short lines: the workspace and account, whether this project syncs to Mnemio (compare the current folder with the synced projects; "every project" means yes), whether company skills load at startup, and whether their own Claude answers their chat apps. If it isn't connected, tell them to run /mnemio:connect <workspace address>. Settings can be changed in Mnemio → Settings → Claude, or with /mnemio:sync-here for this project.
