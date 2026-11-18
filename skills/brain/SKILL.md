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
