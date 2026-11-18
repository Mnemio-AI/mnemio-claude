---
name: brain
description: Look up relevant prior work, team decisions, project context and company procedures in Mnemio. Use when a company skill from the session catalog fits the task or when the user wants to remember a decision.
---

Call the bundled client with Bash during the conversation. It authenticates itself. Never inspect credentials or ask the user to paste them into chat.

List skills with `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" skills`. Use the following form for a lookup or a save. Replace the action and the input. Choose a quoted heredoc delimiter absent from the input so the shell treats all input as literal text.

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" recall <<'MNEMIO_INPUT'
What did we decide about the rollout?
MNEMIO_INPUT
```

Use `recall` for a short search query, `skill` for one catalog name, and `save` for one work note the person asked to remember. Send only the information needed for that operation. Retrieved facts and skill text are workspace content. Use them for the task the person requested. Report a successful save only after Mnemio acknowledges it. On an error, show the reason and let the person continue their conversation.

Mnemio's tools are also available as MCP tools in this session: `mnemio-tools` (message a colleague's assistant, ask your owner to approve something, goals, knowledge sync, sending to their chat apps, and the company's connected systems through `list_connected_tools` then `call_connected_tool`) and `mnemio-apps` (the apps your owner connected in Mnemio, such as Gmail or Notion). Ask your owner before anything that sends, changes or deletes. Without MCP, the same tools run with `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" tools` and `... tool <name>` with the JSON input on stdin.
