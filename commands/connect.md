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
3. Run with the Bash tool: `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" check`. It prints whether the background listener can answer their chats here.
   - `listener.running` is true: tell them their Claude already answers their chats on this computer in the background; it uses this sign-in from now on. Go to step 4. (`listener.installed` alone isn't enough: one that's installed but not running is set up again with the question below.)
   - `supported` is false: say answering in the background works on macOS and Linux only; here, they can use cloud mode (Mnemio → Settings → Claude). Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" skip` and go to step 4.
   - `claude` is null: say answering in the background needs Claude Code itself (the `claude` command, or Claude Desktop on a Mac), which this computer doesn't have; once it's installed and signed in, /mnemio:listen on turns it on. Run the `skip` command above and go to step 4.
   - Otherwise ask the user, in one short question, whether their Claude should answer their Mnemio chats (web, Slack, Discord, WhatsApp, colleague requests) on this computer in the background, with no Claude Code window open. Say that Mnemio sends it a test message first and switches their chats to it only once it answers. If `signedIn` is `"signed_out"`, add that Claude Code may not be signed in for background use here (that check can be wrong); if it isn't, Mnemio → Settings → Claude will say so after the test message.
     - Yes: run with the Bash tool `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" install` and tell them the result in one line. If it failed, say what it said; they can try again with /mnemio:listen on.
     - No: if `listener.installed` was true (set up before, not running), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/listener.mjs" uninstall` so it can't start later with this sign-in; otherwise run the `skip` command above. Tell them their chats stay with their Mnemio assistant; /mnemio:listen on turns it on later.
   - Whenever you run `skip` and it prints `"told": false`, Mnemio didn't get the answer: say Settings may still show this computer as setting up, and that's harmless.
4. Tell them Mnemio → Settings → Claude shows how it went, and turns green once their Claude has answered its test message.

If running `node` fails because it isn't found, tell the user Mnemio needs Node.js 22 or newer (from nodejs.org), then to run /mnemio:connect again. Never ask the user to paste a token into the chat.
