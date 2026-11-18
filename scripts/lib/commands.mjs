import { callMnemio, mnemioConfig } from "./http.mjs";
import { downloadAttachments, replyFiles, replyRoots } from "./attachments.mjs";
import { connect, disconnect } from "./connect.mjs";
import { workspaceConfig } from "./config.mjs";
import { installedSkills } from "./skills-install.mjs";
import { realpath } from "node:fs/promises";

const ID = /^[0-9a-f-]{36}$/;

/** One JSON-RPC call to Mnemio's stateless MCP endpoint (it answers with plain JSON). */
async function mcpCall(rpc, env, request) {
  const { url, token } = mnemioConfig(env);
  const response = await request(new URL("/api/claude/mcp", url), {
    method: "POST",
    headers: { ...(token && { authorization: "Bearer " + token }), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...rpc }),
    redirect: "error",
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`Mnemio tools: ${body.error?.message || body.error || "HTTP " + response.status}`);
  return body.result;
}

export async function run(action, input, env = process.env, request = fetch, arg, files = []) {
  const startup = action === "session-start";
  if (startup && env.MNEMIO_LOAD_SKILLS !== "1") return;
  let path;
  let body;
  switch (action) {
    case "session-start":
    case "skills":
      path = "skills";
      break;
    case "skill":
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input)) throw new Error("Enter a skill name from the catalog.");
      path = "skills/" + encodeURIComponent(input);
      break;
    case "recall":
    case "save": {
      const limit = action === "save" ? 8000 : 2000;
      if (!input || input.length > limit) throw new Error(`Enter between 1 and ${limit} characters.`);
      path = action === "save" ? "memory" : "recall";
      body = action === "save" ? { text: input } : { query: input };
      break;
    }
    // The person's chat-app messages waiting for their Claude (a cloud run collects them this way).
    case "inbox":
      path = "inbox/claim";
      body = { limit: 10 };
      break;
    case "reply":
      if (!ID.test(arg || "")) throw new Error("Give the message id from the inbox: reply <id>, with the answer on stdin.");
      if (!input || input.length > 30000) throw new Error("Enter an answer of up to 30000 characters.");
      path = `inbox/${arg}/reply`;
      body = { text: input };
      {
        const attached = await replyFiles(files, replyRoots(env));
        if (attached.length) body.files = attached;
      }
      break;
    // Mnemio's tools (colleague requests, approvals, goals, knowledge sync, connected MCP servers) without MCP:
    // the same endpoint the plugin's mnemio-tools server uses, for cloud runs and scripts.
    case "tools":
      return mcpCall({ method: "tools/list" }, env, request).then(r => ({ tools: r.tools.map(t => ({ name: t.name, description: t.description, input: t.inputSchema })) }));
    case "tool": {
      if (!/^[a-z0-9_]{1,64}$/.test(arg || "")) throw new Error("Name the tool: tool <name>, with its JSON input on stdin.");
      let args = {};
      if (input) {
        try { args = JSON.parse(input); } catch { throw new Error("The tool's input on stdin must be JSON."); }
      }
      return mcpCall({ method: "tools/call", params: { name: arg, arguments: args } }, env, request);
    }
    // Connecting this computer, and what it syncs.
    case "connect":
      return arg === "--wait" ? connect(undefined, { env, request }) : connect(arg || input, { env, request, waitMs: 0 });
    case "disconnect":
      return disconnect({ env, request });
    case "status": {
      const config = await workspaceConfig({ env, request, refresh: true });
      if (!config) return { connected: false, message: "Not connected: run /mnemio:connect <your workspace address>." };
      return { connected: true, workspace: config.workspace, url: config.url, as: config.user, syncs: config.prefs.syncAll ? "every project" : config.prefs.projects, loadsSkills: config.prefs.loadSkills, companySkillsInstalled: (await installedSkills(env)).length, answersChats: config.answersChats };
    }
    case "sync-here":
    case "stop-sync-here": {
      const path = await realpath(arg || process.cwd());
      const r = await callMnemio("config/projects", { path, add: action === "sync-here" }, { env, request });
      await workspaceConfig({ env, request, refresh: true });
      return { project: path, syncing: action === "sync-here", projects: r.prefs.projects };
    }
    default:
      throw new Error("Choose connect, disconnect, status, sync-here, stop-sync-here, skills, skill, recall, save, inbox, reply, tools or tool.");
  }
  const result = await callMnemio(path, body, { env, request, timeout: startup ? 3000 : 65000 });
  // Files that came with chat messages are saved locally, and each message lists where.
  if (action === "inbox") {
    for (const m of result.messages) m.files = await downloadAttachments(m, { env, request });
  }
  if (!startup) return result;
  if (!result.skills.length) return;
  return { hookSpecificOutput: { hookEventName: "SessionStart",
    additionalContext: "Available Mnemio skills (use mnemio:brain to retrieve one): " + JSON.stringify(result.skills.slice(0, 80).map(name => ({ name, description: result.descriptions?.[name] }))).slice(0, 8000) } };
}
