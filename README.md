# Mnemio for Claude

Connects Claude to your Mnemio company brain. Everything runs on **your own Claude plan**: Mnemio's servers store and route, they never answer with their own models.

- **Company skills and memory in Claude Code:** relevant memories are recalled before each prompt, company skills can be read on demand, and Claude can save notes.
- **Sync back to Mnemio** (in the project you opt in): your memory files, your project's `.claude/skills`, and each answer go to your Mnemio memory, where the workspace's sharing rules apply.
- **Your Slack, Discord and WhatsApp messages answered by your own Claude**, either by a Claude Code session on your computer (channel mode) or by a Claude cloud session that Mnemio starts for you (cloud mode, no computer needed).
- **Mnemio's tools in your Claude:** colleague requests, approvals, goals, knowledge sync, messaging your chat apps, the company's connected MCP servers, and the apps you connected in Mnemio (Gmail, Notion, …) — the same tools the hosted Mnemio assistant has.
- **Chat with your Claude from the Mnemio web app** (**My Claude** in the sidebar): your Claude collects those messages the same way, through the channel or a cloud run.

The plugin talks to Mnemio over HTTPS with its own sign-in; it never sees or sends a Claude login.

## Set up

You need a Mac or Linux computer with Node.js 22 or newer, and Claude Desktop or Claude Code, signed in. Then, in Claude (Claude Desktop's **Code** tab, in a session in any folder, or `claude` in a terminal), send these one at a time; **Mnemio → Settings → Claude** has them ready to copy:

```
/plugin marketplace add Mnemio-AI/mnemio-claude
/plugin install mnemio@mnemio
/mnemio:connect your-workspace.mnemio.ai
```

(If Claude doesn't know `/mnemio:connect` yet, send `/reload-plugins` first.) The last one opens your workspace in the browser: check the code and press **Approve**. Your Claude then checks this computer and asks whether it should **answer your chats here in the background**. Mnemio sends it a test message; once it answers, your Mnemio chats switch to your Claude and the Settings page turns green. If the listener couldn't start, or you said no, Settings says so, and your chats stay with your Mnemio assistant. The sign-in is this computer's own, saved privately in `~/.config/mnemio/`.

Answering in the background needs Claude Code's `claude` command; on a Mac with only Claude Desktop, the listener uses the Claude Code inside Claude Desktop (and finds it again after Desktop updates).

Prefer a terminal? Settings → Claude also gives you one command that does all of it (it needs the `claude` command):

```sh
curl -fsSL https://your-workspace.mnemio.ai/api/claude/install/<one-time code> | sh
```

The code works once, for 10 minutes; fetching the link alone (a chat app's link preview, say) never uses it.

**Mnemio → Settings → Claude** lists every Claude you connected (sign any one out) and what the plugin does:

- **What syncs back:** every project, or the ones you add by running `/mnemio:sync-here` inside them.
- **Company skills installed in Claude Code:** on by default. Every skill you receive in Mnemio (official, shared with you, your assistant's) becomes a Claude Code skill in `~/.claude/skills/mnemio-<name>/`, kept up to date at each session start. Turning it off, or `/mnemio:disconnect`, removes them; the plugin never touches other skill folders.

| Command | What it does |
| --- | --- |
| `/mnemio:connect <workspace>` | Connect this computer (approve in the browser) |
| `/mnemio:listen on\|off\|status` | Answer your chats on this computer in the background |
| `/mnemio:status` | Which workspace and account, what syncs |
| `/mnemio:sync-here` | Sync this project (`/mnemio:sync-here off` to stop) |
| `/mnemio:disconnect` | Sign this computer out |
| `/mnemio:brain …` | Ask about company skills and memory |

Requires Claude Code and Node.js 22+.

### For companies: nothing for staff to do

On Claude Team or Enterprise, an Owner can install it for everyone in managed settings: add the marketplace with `extraKnownMarketplaces` (`Mnemio-AI/mnemio-claude`), turn the plugin on with `enabledPlugins` (`"mnemio@mnemio": true`), and set `MNEMIO_URL` to your workspace under `env`. Each person's first Claude Code session then opens the approval page by itself (at most once a day until they approve): they press Approve. Their Claude then asks, once, whether it should answer their chats on that computer in the background, the same question `/mnemio:connect` asks (again the next day if they ignore it, never once they've answered).

### Scripts and CI

`MNEMIO_URL` and `MNEMIO_TOKEN` in the environment take precedence over the saved sign-in (a token made by hand in Settings → Claude). A saved sign-in is only ever sent to the workspace it came from.

## Your chats, answered by your own Claude

Once connected, your Mnemio chats — the web chat, Slack, Discord, WhatsApp, colleague requests — go to your own Claude instead of Mnemio's assistant (switch back in Settings → Claude). Mnemio never answers them itself. Something has to collect them:

### On your computer: the background listener (recommended)

Turned on by the install command, or with `/mnemio:listen on`. A small background service (a macOS launch agent or a Linux user service, started at login) collects each message and answers it with `claude -p` — your own Claude Code, signed in with your own plan — keeping one Claude session per conversation. No Claude Code window needs to be open. Messages can come from shared threads, so Claude only gets what answering needs: Mnemio's tools and company skills, reading the files that came with the message, and writing files to send you into that message's outbox. Each message's files are in a folder of their own, outside the folder Claude works in, granted to Claude for that message alone and removed once it's answered; no shell, no writing anywhere else, no web, and none of your other MCP servers or connectors — whatever your own Claude Code settings allow. While it works, each step it takes ("Searching memory", "Using mnemio-release-checklist") shows live in your chat, as with Mnemio's own assistant. Steps show only a label, plus a memory search's query or a file's name: never what's being sent or approved.

Besides collecting messages, it sends Mnemio a heartbeat every 30 seconds, so Settings → Claude shows each computer as **Answering** (even in the middle of a long answer), **Offline** (asleep, or not running), or **Sign in to Claude again** (Claude Code was signed out there: the listener takes no messages until you sign in, and they wait for it). `/mnemio:listen status` shows the same here; its log is in `~/.config/mnemio/listener/listener.log`.

### In a Claude Code session: channel mode

To answer in an open session instead (research preview; until this plugin is on Anthropic's approved list it needs the development flag, which only works interactively):

```sh
MNEMIO_CHANNEL=1 claude --dangerously-load-development-channels plugin:mnemio@mnemio
```

### Cloud mode (no computer needed)

Mnemio starts a Claude cloud session on your plan whenever a message arrives, using a scheduled task you create. Mnemio keeps only that task's trigger token, which can start that one task and nothing else.

**Mnemio → Settings → Claude → Cloud mode** walks you through it with every value ready to copy, and ticks each step off:

1. Fork this repository (the cloud run works in it).
2. Create a token for the cloud run.
3. In claude.ai/code, create a cloud environment: network access **Limited** with your Mnemio host allowed, `MNEMIO_URL` as an environment variable, and the token as a **Bearer** network secret for that host (Anthropic's proxy adds it to requests for that host only; it never enters the session).
4. Create a scheduled task on your fork in that environment, with the prompt *"Follow the instructions in cloud/scheduled-task-prompt.md in this repository."*, and add an **API** trigger (Generate token).
5. Paste the trigger's URL and token into Mnemio.
6. Press **Test**: Mnemio sends your cloud Claude a short message and shows when it answers.

A burst of messages starts one run, which answers all of them. Anthropic allows 100 API-started runs an hour per account, and each run counts toward your Claude plan's usage.

## How it fits together

| Piece | What it does |
| --- | --- |
| `hooks/hooks.json` | SessionStart: settings from Mnemio, company skills installed, retry of anything unsent. UserPromptSubmit: recall. PostToolUse: sync memory files and project skills. Stop: save the answer. |
| `scripts/brain.mjs` | The client Claude runs: `skills`, `skill <name>`, `recall`, `save`, `inbox`, `reply <id> [--file path]`, `tools`, `tool <name>`. |
| `scripts/channel.mjs` | That server: Mnemio's tools, and in channel mode, your messages with a `reply` tool. |
| `scripts/listener.mjs` | The background listener: collects your messages and answers each with `claude -p`. |
| `commands/` | `/mnemio:connect`, `listen`, `status`, `sync-here`, `disconnect`. |
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
