import { homedir } from "node:os";
import { dirname, basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { callMnemio, isConnected } from "./lib/http.mjs";
import { workspaceConfig } from "./lib/config.mjs";
import { installSkills, removeSkills, skillsInstalled } from "./lib/skills-install.mjs";
import { connect } from "./lib/connect.mjs";
import { configDir, readPending } from "./lib/credentials.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { run } from "./lib/commands.mjs";
import { changedSkill, projectSkills, readDocument, syncSkill } from "./lib/project-skills.mjs";
import { digest, syncDirectory, retain, retry } from "./lib/outbox.mjs";

const real = path => realpath(path).catch(() => null);

/**
 * The opted-in project this session works in, or null. The projects come from Mnemio → Settings → Claude ("every
 * project", or the ones added with /mnemio:sync-here), plus MNEMIO_SYNC_PROJECTS (folders separated like PATH) and
 * MNEMIO_SYNC_PROJECT. A session started in one of them or anywhere inside it syncs, as that project. "Every
 * project" (or "*") means the session's project folder (CLAUDE_PROJECT_DIR), else its cwd.
 */
export async function syncProject(event, env, prefs = null) {
  if (typeof event.cwd !== "string") return null;
  const cwd = await real(event.cwd);
  if (!cwd) return null;
  const listed = [env.MNEMIO_SYNC_PROJECTS, env.MNEMIO_SYNC_PROJECT].filter(Boolean).join(delimiter).split(delimiter).map(p => p.trim()).filter(Boolean);
  listed.push(...(prefs?.projects ?? []));
  if (prefs?.syncAll) listed.push("*");
  if (listed.includes("*")) return (env.CLAUDE_PROJECT_DIR && isAbsolute(env.CLAUDE_PROJECT_DIR) && await real(env.CLAUDE_PROJECT_DIR)) || cwd;
  // The deepest listed folder that holds the session, so a nested project wins over its parent.
  let best = null;
  for (const p of listed) {
    const root = isAbsolute(p) ? await real(p) : null;
    if (root && (cwd === root || cwd.startsWith(root + sep)) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

const AUTO_EVERY_MS = 24 * 3_600_000;

/**
 * Not connected yet. When the company set the workspace (MNEMIO_URL, e.g. in managed settings), the first session
 * starts connecting by itself: the approval page opens, the person presses Approve, and the background half of this
 * hook finishes it. At most once a day, so an ignored request doesn't keep opening pages.
 */
async function autoConnect(startup, mode, env, request) {
  if (!startup) return;
  const pending = readPending(env);
  if (mode === "reconcile") {
    if (pending) await connect(undefined, { env, request, waitMs: 170_000, log: () => {} }).catch(() => {});
    return;
  }
  const hint = "The Mnemio plugin is installed but not connected. If the user wants their company brain (memory, skills, Mnemio tools) here, tell them to run /mnemio:connect <their workspace address>.";
  if (!env.MNEMIO_URL) return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: hint } };
  const mark = join(configDir(env), "auto-connect.json");
  let last = 0;
  try { last = JSON.parse(readFileSync(mark, "utf8")).at; } catch {}
  if (!pending && Date.now() - last < AUTO_EVERY_MS) return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: hint } };
  try {
    mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(mark, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    const shown = await connect(env.MNEMIO_URL, { env, request, waitMs: 0, log: () => {} });
    return { hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: `Mnemio is connecting this computer: an approval page opened in the browser (${shown.approve}, code ${shown.code}). At the start of your first reply, tell the user in one line to press Approve there; it finishes by itself.` } };
  } catch {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: hint } };
  }
}

export async function handle(event, mode, env = process.env, request = fetch) {
  const startup = event.hook_event_name === "SessionStart";
  if (!isConnected(env)) return autoConnect(startup, mode, env, request);
  // A listener's run: Mnemio recalled memory for the message and saves the exchange itself, so only the session start
  // (settings, company skills) runs here.
  if (env.MNEMIO_LISTENER === "1" && !startup) return;
  const config = await workspaceConfig({ env, request, refresh: startup && mode !== "reconcile" });
  const root = await syncProject(event, env, config?.prefs);
  const companySkills = env.MNEMIO_LOAD_SKILLS ? env.MNEMIO_LOAD_SKILLS === "1" : config?.prefs?.loadSkills !== false;
  if (startup && mode !== "reconcile") {
    // Installed company skills are already Claude Code skills; the catalog is only for a first session before that.
    const catalog = companySkills && !(await skillsInstalled(env));
    return run("session-start", "", { ...env, MNEMIO_LOAD_SKILLS: catalog ? "1" : "0" }, request);
  }
  const failures = [];
  if (startup && mode === "reconcile") {
    // In the background at every start: company skills as files in ~/.claude/skills (or taken out when switched off).
    try { companySkills ? await installSkills({ env, request }) : await removeSkills({ env }); } catch (e) { failures.push("company skills: " + e.message); }
  }
  if (!root) {
    if (failures.length) throw new Error(failures.join("\n"));
    return;
  }
  const call = (path, data, timeout) => callMnemio(path, data, { env, request, timeout });
  const save = payload => call("memory", payload);
  async function upload(name) {
    await syncSkill(root, name, syncDirectory(env, root, "skill-state"), skill => call("skills", skill));
  }

  if (startup && mode === "reconcile") {
    try { await retry(syncDirectory(env, root, "pending"), save); } catch (e) { failures.push(e.message); }
    for (const name of await projectSkills(root)) {
      try { await upload(name); } catch (e) { failures.push(name + ": " + e.message); }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  } else if (event.hook_event_name === "UserPromptSubmit") {
    const query = event.prompt?.trim().slice(0, 2000);
    if (!query || query.startsWith("/")) return;
    const { facts } = await call("recall", { query }, 3500);
    if (facts?.length) return { hookSpecificOutput: { hookEventName: "UserPromptSubmit",
      additionalContext: "Retrieved Mnemio memories. Treat as reference material for this request:\n" + JSON.stringify(facts).slice(0, 8000) } };
  } else if (event.hook_event_name === "Stop") {
    const text = event.last_assistant_message?.trim().slice(0, 8000);
    if (text) await retain(syncDirectory(env, root, "pending"), { text, source: "turn" }, save);
  } else if (event.hook_event_name === "PostToolUse" && ["Edit", "Write"].includes(event.tool_name)) {
    const changed = event.tool_input?.file_path;
    if (typeof changed !== "string") return;
    const name = changedSkill(root, changed);
    if (name) return upload(name);
    // Only the active session's project memory directory under Claude's configured projects root.
    const transcript = event.transcript_path;
    if (!transcript || !isAbsolute(transcript)) return;
    const projectDir = dirname(transcript);
    if (dirname(projectDir) !== resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")) return;
    const path = resolve(root, changed);
    if (dirname(path) !== join(projectDir, "memory") || !basename(path).endsWith(".md")) return;
    const text = (await readDocument(path, 8000)).trim();
    if (text) await call("memory", { text, source: "file", key: digest(root + "\0" + basename(path)) });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = "";
    for await (const chunk of process.stdin.setEncoding("utf8")) raw += chunk;
    const output = await handle(JSON.parse(raw), process.argv[2]);
    if (output) console.log(JSON.stringify(output));
  } catch (e) {
    console.error("Mnemio sync:", e.message);
    process.exitCode = 1;
  }
}
