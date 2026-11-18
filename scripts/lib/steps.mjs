import { basename } from "node:path";

/**
 * What the listener's Claude is doing, in words, for the person's chat: each tool it uses becomes a step that Mnemio
 * shows live ("Searching memory", "Using mnemio-release-checklist", "Checking goals"), the way the hosted assistant's
 * steps are shown. Only a short label leaves this computer, and a preview only where it can't carry private text: a
 * memory search's query and a file's name. Steps can show in a shared thread, so never a message being sent, an
 * approval's details or any other tool input.
 */

const MNEMIO_TOOL = /^mcp__plugin_mnemio_mnemio__(.+)$/;
const PREVIEW_CHARS = 120;

/** Mnemio's own tools (the server's krut-mcp.ts), by what the person would call them. */
const MNEMIO_WORDS = {
  list_colleagues: "Looking up colleagues",
  message_colleague: "Asking a colleague",
  reply_to_colleague: "Answering a colleague",
  decline_colleague_request: "Declining a colleague's request",
  request_approval: "Asking you to approve",
  send_to_my_chat_app: "Sending to your chat app",
  list_goals: "Checking goals",
  add_goal: "Adding a goal",
  update_goal: "Updating a goal",
  record_finished_task: "Recording time saved",
  create_sync_job: "Setting up a knowledge sync",
  list_sync_jobs: "Checking knowledge syncs",
  run_sync_job: "Running a knowledge sync",
  list_connected_tools: "Checking connected tools"
};

const clip = s => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
};
/** "GMAIL_FETCH_EMAILS" / "fetch_emails" → "gmail fetch emails". */
const words = name => String(name).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/[_-]+/g, " ").trim().toLowerCase();

/** Claude Code's own plumbing (loading a tool's definition), not a step the person would care about. */
const HIDDEN = new Set(["ToolSearch"]);

/** { tool, preview } for one tool use from Claude's stream (name and input as Claude Code reports them); null to leave it out. */
export function describeStep(name, input = {}) {
  if (HIDDEN.has(name)) return null;
  const mnemio = MNEMIO_TOOL.exec(name)?.[1];
  if (mnemio) {
    if (/recall|memor/i.test(mnemio)) return { tool: "Searching memory", preview: clip(typeof input.query === "string" ? input.query : "") };
    if (mnemio === "call_connected_tool") return { tool: `Using ${words(input.tool || input.name || "a connected tool")}`, preview: "" };
    return { tool: MNEMIO_WORDS[mnemio] || `Using ${words(mnemio)}`, preview: "" };
  }
  // The apps the person connected in Mnemio (Gmail, Notion, …), through the plugin's MCP server too.
  if (/^mcp__/.test(name)) return { tool: `Using ${words(name)}`, preview: "" };
  if (name === "Skill") return { tool: `Using ${String(input.skill || input.command || "a skill").replace(/^\//, "")}`, preview: "" };
  if (name === "Read") return { tool: "Reading a file", preview: input.file_path ? basename(String(input.file_path)) : "" };
  if (name === "Write" || name === "Edit") return { tool: "Making a file", preview: input.file_path ? basename(String(input.file_path)) : "" };
  if (name === "Glob" || name === "Grep") return { tool: "Looking through files", preview: "" };
  if (name === "TodoWrite") return { tool: "Planning", preview: "" };
  // Not allowed in the listener (it is refused), but Claude may still try.
  if (name === "Bash") return { tool: "Running a command", preview: "" };
  if (name === "WebFetch" || name === "WebSearch") return { tool: "Looking on the web", preview: "" };
  return { tool: words(name).replace(/^./, c => c.toUpperCase()) || "Working", preview: "" };
}
