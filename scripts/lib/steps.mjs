import { basename } from "node:path";

/**
 * What the listener's Claude is doing, in words, for the person's chat: each tool it uses becomes a step that Mnemio
 * shows live ("Searching memory", "Using mnemio-release-checklist", "Checking goals"), the way the hosted assistant's
 * steps are shown. Only a short label and a one-line preview leave this computer, never a tool's full input or output.
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
/** A tool input's first short text field: what a step is about ("the rollout plan"), never the whole input. */
const firstText = input => {
  for (const key of ["query", "question", "message", "title", "skill", "name"]) if (typeof input?.[key] === "string") return input[key];
  const any = Object.values(input ?? {}).find(v => typeof v === "string");
  return any ?? "";
};

/** Claude Code's own plumbing (loading a tool's definition), not a step the person would care about. */
const HIDDEN = new Set(["ToolSearch"]);

/** { tool, preview } for one tool use from Claude's stream (name and input as Claude Code reports them); null to leave it out. */
export function describeStep(name, input = {}) {
  if (HIDDEN.has(name)) return null;
  const mnemio = MNEMIO_TOOL.exec(name)?.[1];
  if (mnemio) {
    if (/recall|memor/i.test(mnemio)) return { tool: "Searching memory", preview: clip(firstText(input)) };
    if (mnemio === "call_connected_tool") return { tool: `Using ${words(input.tool || input.name || "a connected tool")}`, preview: "" };
    return { tool: MNEMIO_WORDS[mnemio] || `Using ${words(mnemio)}`, preview: clip(firstText(input)) };
  }
  // The apps the person connected in Mnemio (Gmail, Notion, …), through the plugin's MCP server too.
  if (/^mcp__/.test(name)) return { tool: `Using ${words(name)}`, preview: "" };
  if (name === "Skill") return { tool: `Using ${String(input.skill || input.command || "a skill").replace(/^\//, "")}`, preview: "" };
  if (name === "Read") return { tool: "Reading a file", preview: input.file_path ? basename(String(input.file_path)) : "" };
  if (name === "Write" || name === "Edit") return { tool: "Making a file", preview: input.file_path ? basename(String(input.file_path)) : "" };
  if (name === "Glob" || name === "Grep") return { tool: "Looking through files", preview: clip(input.pattern) };
  if (name === "TodoWrite") return { tool: "Planning", preview: "" };
  // Not allowed in the listener (it is refused), but Claude may still try.
  if (name === "Bash") return { tool: "Running a command", preview: "" };
  if (name === "WebFetch" || name === "WebSearch") return { tool: "Looking on the web", preview: "" };
  return { tool: words(name).replace(/^./, c => c.toUpperCase()) || "Working", preview: "" };
}
