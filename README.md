# Mnemio for Claude

Connects Claude to your Mnemio company brain. Everything runs on **your own Claude plan**: Mnemio's servers store and route, they never answer with their own models.

- **Company skills and memory in Claude Code:** relevant memories are recalled before each prompt, company skills can be read on demand, and Claude can save notes.
- **Sync back to Mnemio** (in the project you opt in): your memory files, your project's `.claude/skills`, and each answer go to your Mnemio memory, where the workspace's sharing rules apply.
- **Your Slack, Discord and WhatsApp messages answered by your own Claude**, either by a Claude Code session on your computer (channel mode) or by a Claude cloud session that Mnemio starts for you (cloud mode, no computer needed).
- **Mnemio's tools in your Claude:** colleague requests, approvals, goals, knowledge sync, messaging your chat apps, the company's connected MCP servers, and the apps you connected in Mnemio (Gmail, Notion, …) — the same tools the hosted Mnemio assistant has.
- **Chat with your Claude from the Mnemio web app** (**My Claude** in the sidebar): your Claude collects those messages the same way, through the channel or a cloud run.

The plugin talks to Mnemio over HTTPS with its own sign-in; it never sees or sends a Claude login.

## Set up

In Claude Code:

```
/plugin marketplace add Mnemio-AI/mnemio-claude
/plugin install mnemio@mnemio
/mnemio:connect your-workspace.mnemio.ai
```

The last one opens your Mnemio workspace in the browser with a short code. Check the code and press **Approve**: this computer gets its own sign-in, saved privately in `~/.config/mnemio/`. Nothing to copy or export. **Mnemio → Settings → Claude** shows the same three lines with copy buttons, every Claude you connected (sign any one out), and what the plugin does:

- **What syncs back:** every project, or the ones you add by running `/mnemio:sync-here` inside them.
- **Company skills at the start of each session:** on by default.

| Command | What it does |
| --- | --- |
| `/mnemio:connect <workspace>` | Connect this computer (approve in the browser) |
| `/mnemio:status` | Which workspace and account, what syncs |
| `/mnemio:sync-here` | Sync this project (`/mnemio:sync-here off` to stop) |
| `/mnemio:disconnect` | Sign this computer out |
| `/mnemio:brain …` | Ask about company skills and memory |

Requires Node.js 22+.

### For companies: nothing for staff to do

On Claude Team or Enterprise, an Owner can install it for everyone in managed settings: add the marketplace with `extraKnownMarketplaces` (`Mnemio-AI/mnemio-claude`), turn the plugin on with `enabledPlugins` (`"mnemio@mnemio": true`), set `MNEMIO_URL` to your workspace under `env` so `/mnemio:connect` needs no address, and allow the channel with `allowedChannelPlugins`. Each person then runs `/mnemio:connect` once.

### Scripts and CI

`MNEMIO_URL` and `MNEMIO_TOKEN` in the environment take precedence over the saved sign-in (a token made by hand in Settings → Claude). A saved sign-in is only ever sent to the workspace it came from.

## Answer chat apps with your own Claude

In **Mnemio → Settings → Claude**, set **Who answers your chat apps** to **My own Claude**. From then on Mnemio never answers your Slack, Discord or WhatsApp messages itself: it queues each message and your Claude answers it in the same thread or chat. If no Claude is connected, the message waits for up to a day and you're told so.

### Channel mode (Claude Code on your computer)

Start a session that listens for your messages and leave it running:

```sh
MNEMIO_CHANNEL=1 claude --dangerously-load-development-channels plugin:mnemio@mnemio
```

It uses the sign-in from `/mnemio:connect`.

Set `MNEMIO_CHANNEL=1` only on this command, not in your shell profile: a session that wasn't started as a channel can't show the messages it collects, so they would sit unanswered for 15 minutes before going back in the queue.

Claude Code channels are a research preview. Until this plugin is on Anthropic's approved channel list it loads with the development flag above, which only works in an interactive session. On Team and Enterprise plans an Owner must turn channels on, and can approve this plugin for everyone with `allowedChannelPlugins` in managed settings.

### Cloud mode (no computer needed)

Mnemio starts a Claude cloud session on your plan whenever a message arrives, using a scheduled task you create. Mnemio keeps only that task's trigger token, which can start that one task and nothing else.

1. **Cloud environment** (claude.ai/code → environment settings): create one for Mnemio.
   - **Network access:** Limited, and add your Mnemio host (e.g. `your-workspace.mnemio.ai`) under **Allowed domains**.
   - **Environment variables:** `MNEMIO_URL=https://your-workspace.mnemio.ai`.
   - **Network secrets:** add a secret of type **Bearer** for your Mnemio host. For its value, create a token in Mnemio → Settings → Claude → **Add a token by hand** (call it "Cloud mode"). Anthropic's proxy adds it to requests for that host, so the token never enters the session.
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
| `scripts/channel.mjs` | That server: Mnemio's tools, and when listening, your messages with a `reply` tool. |
| `commands/` | `/mnemio:connect`, `status`, `sync-here`, `disconnect`. |
| `.mcp.json` | One local server (`scripts/channel.mjs`): Mnemio's tools, the company's MCP servers and your connected apps, passed on from Mnemio with your sign-in, plus the channel when you listen. |
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
