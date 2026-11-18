---
description: Answer your Mnemio chats on this computer in the background with your Claude (on, off or status)
argument-hint: "[on|off|status]"
allowed-tools: Bash(node:*)
---
Run with the Bash tool, depending on what the user asked ($ARGUMENTS; no argument means on):
- on: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" install`
- off: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" uninstall`
- status: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" status`

Tell the user the result in one or two lines. When it's on: their chats in Mnemio (web, Slack, Discord, WhatsApp, colleague requests) are answered by their own Claude on this computer, in the background, whenever it's on, with no Claude Code window needed; for answers while it's off, there's cloud mode in Mnemio → Settings → Claude. If it says the user isn't connected, tell them to run /mnemio:connect first.
