# Mnemio for Claude

Connects Claude to your Mnemio company brain. Everything runs on **your own Claude plan**: Mnemio's servers store and route, they never answer with their own models.

- **Company skills and memory in Claude Code:** relevant memories are recalled before each prompt, company skills can be read on demand, and Claude can save notes.
- **Sync back to Mnemio** (in the project you opt in): your memory files, your project's `.claude/skills`, and each answer go to your Mnemio memory, where the workspace's sharing rules apply.
- **Your Slack, Discord and WhatsApp messages answered by your own Claude**, either by a Claude Code session on your computer (channel mode) or by a Claude cloud session that Mnemio starts for you (cloud mode, no computer needed).
- **Mnemio's tools in your Claude:** colleague requests, approvals, goals, knowledge sync, messaging your chat apps, the company's connected MCP servers, and the apps you connected in Mnemio (Gmail, Notion, …) — the same tools the hosted Mnemio assistant has.
- **Chat with your Claude from the Mnemio web app** (**My Claude** in the sidebar): your Claude collects those messages the same way, through the channel or a cloud run.

Requires Node.js 22+. The plugin talks to Mnemio over HTTPS with a personal token; it never sees or sends a Claude login.

## Set up

1. In Mnemio, open **Settings → Claude**, create a plugin token, and copy it.
2. In the terminal you launch Claude from (zsh on macOS):

   ```sh
   export MNEMIO_URL=https://your-workspace.mnemio.ai   # http://localhost:8787 for local development
   read -rs 'MNEMIO_TOKEN?Mnemio plugin token: '; echo
   export MNEMIO_TOKEN
   export MNEMIO_SYNC_PROJECTS="$HOME/work/app:$HOME/work/docs"   # optional: projects that sync automatically
   ```

   Sync is off unless you list a project: a session started in a listed folder, or anywhere inside it, syncs as that project. `MNEMIO_SYNC_PROJECTS="*"` syncs every project. Recall, skills and saving notes work everywhere either way.

3. Install the plugin in Claude Code:

   ```
   /plugin marketplace add Mnemio-AI/mnemio-claude
   /plugin install mnemio@mnemio
   ```

   For development, `claude --plugin-dir /path/to/mnemio-claude` loads a local clone without installing.

4. Try `/mnemio:brain list our company skills`, or ask "what do we know about <client>?".

Set `MNEMIO_LOAD_SKILLS=1` to put the company skill catalog into every session's context at startup.

## Answer chat apps with your own Claude

In **Mnemio → Settings → Claude**, set **Who answers your chat apps** to **My own Claude**. From then on Mnemio never answers your Slack, Discord or WhatsApp messages itself: it queues each message and your Claude answers it in the same thread or chat. If no Claude is connected, the message waits for up to a day and you're told so.

### Channel mode (Claude Code on your computer)

Start a session that listens for your messages and leave it running:

```sh
MNEMIO_CHANNEL=1 claude --dangerously-load-development-channels plugin:mnemio@mnemio
```

Set `MNEMIO_CHANNEL=1` only on this command, not in your shell profile: a session that wasn't started as a channel can't show the messages it collects, so they would sit unanswered for 15 minutes before going back in the queue.

Claude Code channels are a research preview. Until this plugin is on Anthropic's approved channel list it loads with the development flag above, which only works in an interactive session. On Team and Enterprise plans an Owner must turn channels on, and can approve this plugin for everyone with `allowedChannelPlugins` in managed settings.

### Cloud mode (no computer needed)

Mnemio starts a Claude cloud session on your plan whenever a message arrives, using a scheduled task you create. Mnemio keeps only that task's trigger token, which can start that one task and nothing else.

1. **Cloud environment** (claude.ai/code → environment settings): create one for Mnemio.
   - **Network access:** Limited, and add your Mnemio host (e.g. `your-workspace.mnemio.ai`) under **Allowed domains**.
   - **Environment variables:** `MNEMIO_URL=https://your-workspace.mnemio.ai`.
   - **Network secrets:** add a secret of type **Bearer** for your Mnemio host, with your plugin token as the value. Anthropic's proxy adds it to requests for that host, so the token never enters the session.
2. **Scheduled task** (claude.ai → Scheduled tasks → New):
   - **Repository:** your fork of [Mnemio-AI/mnemio-claude](https://github.com/Mnemio-AI/mnemio-claude) (or any repository of yours that contains this plugin, at its root or in a `mnemio-claude` folder).
   - **Environment:** the one from step 1.
   - **Prompt:** the contents of [`cloud/scheduled-task-prompt.md`](cloud/scheduled-task-prompt.md).
   - **Trigger:** add an **API** trigger and **Generate token**. Copy the URL and the token (it's shown once). A schedule is optional: an hourly one works as a safety net.
3. In **Mnemio → Settings → Claude → Cloud mode**, paste the URL and token and press **Test**. You should see a run start in Claude.

A burst of messages starts one run, which answers all of them. Anthropic allows 100 API-started runs an hour per account, and each run counts toward your Claude plan's usage.

## How it fits together

| Piece | What it does |
| --- | --- |
| `hooks/hooks.json` | SessionStart: catalog and retry of anything unsent. UserPromptSubmit: recall. PostToolUse: sync memory files and project skills. Stop: save the answer. |
| `scripts/brain.mjs` | The client Claude runs: `skills`, `skill <name>`, `recall`, `save`, `inbox`, `reply <id> [--file path]`, `tools`, `tool <name>`. |
| `scripts/channel.mjs` | The channel (an MCP server on stdio): long-polls Mnemio for your messages and gives Claude a `reply` tool. |
| `.mcp.json` | The channel, plus `mnemio-tools` (Mnemio's tools and connected MCP servers) and `mnemio-apps` (your connected apps), both over HTTPS with your token. |
| `cloud/scheduled-task-prompt.md` | What a cloud run does: collect, answer, repeat until the inbox is empty. |

The HTTP API is under `/api/claude/` on your Mnemio workspace, always with your personal token: `GET skills`, `GET skills/:name`, `POST skills`, `POST recall`, `POST memory`, `GET inbox/next`, `POST inbox/claim`, `GET inbox/:id/files/:fileId`, `POST inbox/:id/reply`, and the MCP endpoints `mcp` (Mnemio's tools) and `apps/mcp` (connected apps). Revoke the token in Mnemio → Settings → Claude.

## Development

```sh
node --test test/*.test.mjs
claude plugin validate .
```

This folder has no imports from the Mnemio server code, so it can move to its own repository as it is.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). "Mnemio" is a trademark of Mnemio AI; forks must not present themselves as the official Mnemio plugin.
