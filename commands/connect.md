---
description: Connect Claude to your Mnemio workspace — you approve it in the browser, no token to copy
argument-hint: <workspace address, e.g. acme.mnemio.ai>
allowed-tools: Bash(node:*)
---
Connect this computer's Claude to the user's Mnemio workspace.

1. Run with the Bash tool: `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" connect $ARGUMENTS`
   It prints `{"approve": <link>, "code": <code>, ...}` and opens the link in the browser. Tell the user right away, in one short message: open the link (if it didn't open), check the code matches, and press **Approve**. If it says which workspace is missing, ask the user for their Mnemio address and run it again with it.
2. Then run with the Bash tool, with a timeout of 300000 ms: `node "${CLAUDE_PLUGIN_ROOT}/scripts/brain.mjs" connect --wait`
   - `{"connected": true, ...}`: tell them they're connected to that workspace. Mnemio's memory, company skills and tools work from now on (the tools appear in this session within a few seconds); settings are in Mnemio → Settings → Claude, and `/mnemio:status` shows them. Then go to step 3.
   - `{"waiting": true, ...}`: they haven't approved yet; remind them of the link, then run step 2 again.
   - An error (denied, expired): say so; they can run /mnemio:connect again.
3. Ask the user, in one short question, whether their Claude should answer their Mnemio chats (web, Slack, Discord, WhatsApp, colleague requests) on this computer in the background, with no Claude Code window open. Say that Mnemio sends it a test message first and switches their chats to it only once it answers.
   - Yes: run with the Bash tool `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" install` and tell them the result in one line. If it failed, say what it said; they can try again with /mnemio:listen on.
   - No: tell them their chats stay with their Mnemio assistant, and /mnemio:listen on turns it on later.

Never ask the user to paste a token into the chat.
