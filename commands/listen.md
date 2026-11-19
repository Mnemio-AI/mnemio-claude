---
description: Answer your Mnemio chats on this computer in the background with your Claude (on, off or status)
argument-hint: "[on|off|status|skip]"
allowed-tools: Bash(node:*)
---
Run with the Bash tool, depending on what the user asked ($ARGUMENTS; no argument means on):
- on: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" install`
- off: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" uninstall`
- status: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" status`
- skip (the user said no when asked whether their Claude should answer here): `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" skip`. Tell them their chats stay with their Mnemio assistant, and /mnemio:listen on turns it on later.

Tell the user the result in one or two lines. When it's on: their chats in Mnemio (web, Slack, Discord, WhatsApp, colleague requests) are answered by their own Claude on this computer, in the background, whenever it's on, with no Claude Code window needed; for answers while it's off, there's cloud mode in Mnemio → Settings → Claude. If it says the user isn't connected, tell them to run /mnemio:connect first. For status: `running` comes from its heartbeat, so it stays true while it works on a long answer; if `claude` is `"signed_out"`, tell them to sign in to Claude Code again (it answers nothing until then, and their messages wait).
