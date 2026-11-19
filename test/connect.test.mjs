import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, disconnect, workspaceUrl } from "../scripts/lib/connect.mjs";
import { readCredentials, saveCredentials } from "../scripts/lib/credentials.mjs";
import { mnemioConfig } from "../scripts/lib/http.mjs";
import { createChannel } from "../scripts/channel.mjs";
import { syncProject } from "../scripts/hooks.mjs";
import { run } from "../scripts/brain.mjs";

async function home(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-config-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { MNEMIO_CONFIG_DIR: dir, MNEMIO_NO_BROWSER: "1" };
}

/** A fake workspace: the connect endpoints, approved on the second poll. */
function workspace({ outcome = "approved" } = {}) {
  const calls = [];
  let polls = 0;
  const request = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path: url.pathname, body, auth: opts.headers?.authorization });
    if (url.pathname === "/api/claude/connect/start") return Response.json({ device_code: "d".repeat(43), user_code: "ABCD-EFGH", verification_uri_complete: "https://acme.mnemio.ai/connect-claude?code=ABCD-EFGH", expires_in: 600, interval: 1, workspace: "Acme" });
    if (url.pathname === "/api/claude/connect/poll") {
      if (++polls < 2) return Response.json({ status: "pending", interval: 1 });
      return outcome === "approved" ? Response.json({ status: "approved", token: "mnemio_cc_" + "a".repeat(64), url: "https://acme.mnemio.ai", workspace: "Acme" }) : Response.json({ status: outcome }, { status: 410 });
    }
    if (url.pathname === "/api/claude/config/token") return Response.json({ ok: true });
    return Response.json({});
  };
  return { calls, request };
}

test("workspace addresses: bare hosts get https, local ones http, nothing else", () => {
  assert.equal(workspaceUrl("acme.mnemio.ai"), "https://acme.mnemio.ai");
  assert.equal(workspaceUrl("https://acme.mnemio.ai/settings"), "https://acme.mnemio.ai");
  assert.equal(workspaceUrl("localhost:5173"), "http://localhost:5173");
  assert.throws(() => workspaceUrl("http://acme.mnemio.ai"), /https/);
});

test("connect in two steps: show the code at once, then wait for the approval and save the sign-in privately", async t => {
  const env = await home(t);
  const { calls, request } = workspace();
  const shown = await connect("acme.mnemio.ai", { env, request, waitMs: 0 });
  assert.deepEqual(shown, { approve: "https://acme.mnemio.ai/connect-claude?code=ABCD-EFGH", code: "ABCD-EFGH", workspace: "Acme", expiresAt: shown.expiresAt });
  assert.match(calls[0].body.label, /^Claude Code on /);
  // Running the first step again shows the same code instead of starting over.
  assert.equal((await connect(undefined, { env, request, waitMs: 0 })).code, "ABCD-EFGH");
  assert.equal(calls.filter(c => c.path.endsWith("/start")).length, 1);
  const done = await connect(undefined, { env, request, sleep: async () => {}, log: () => {} });
  assert.deepEqual(done, { connected: true, workspace: "Acme", url: "https://acme.mnemio.ai" });
  const saved = readCredentials(env);
  assert.equal(saved.token, "mnemio_cc_" + "a".repeat(64));
  assert.equal((await stat(join(env.MNEMIO_CONFIG_DIR, "credentials.json"))).mode & 0o777, 0o600, "readable by this user only");
  // From now on every call uses it, with no environment variables.
  assert.deepEqual({ ...mnemioConfig(env), url: mnemioConfig(env).url.href }, { url: "https://acme.mnemio.ai/", token: saved.token });

  assert.deepEqual(await disconnect({ env, request }), { disconnected: true, workspace: "Acme" });
  assert.equal(calls.at(-1).path, "/api/claude/config/token", "signs this computer out at the workspace too");
  assert.equal(readCredentials(env), null);
  assert.throws(() => mnemioConfig(env), /run \/mnemio:connect/);
});

test("a denied connection saves nothing", async t => {
  const env = await home(t);
  const { request } = workspace({ outcome: "denied" });
  await connect("acme.mnemio.ai", { env, request, waitMs: 0 });
  await assert.rejects(connect(undefined, { env, request, sleep: async () => {}, log: () => {} }), /denied/);
  assert.equal(readCredentials(env), null);
});

test("a saved token only goes to its own workspace; the environment still wins", async t => {
  const env = await home(t);
  saveCredentials({ url: "https://acme.mnemio.ai", token: "mnemio_cc_saved" }, env);
  assert.equal(mnemioConfig({ ...env, MNEMIO_URL: "https://acme.mnemio.ai" }).token, "mnemio_cc_saved", "a company-set address keeps the saved sign-in");
  assert.throws(() => mnemioConfig({ ...env, MNEMIO_URL: "https://other.example" }), /connect/, "never sent to a different host");
  assert.equal(mnemioConfig({ ...env, MNEMIO_URL: "https://ci.example", MNEMIO_TOKEN: "mnemio_cc_env" }).token, "mnemio_cc_env");
});

test("which projects sync comes from Mnemio's settings", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mnemio-proj-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "app/src"), { recursive: true });
  await mkdir(join(base, "notes"));
  assert.equal(await syncProject({ cwd: join(base, "app/src") }, {}, { projects: [join(base, "app")] }), join(base, "app"));
  assert.equal(await syncProject({ cwd: join(base, "notes") }, {}, { projects: [join(base, "app")] }), null);
  assert.equal(await syncProject({ cwd: join(base, "notes") }, { CLAUDE_PROJECT_DIR: join(base, "notes") }, { syncAll: true }), join(base, "notes"));
});

test("sync-here adds this folder to the person's synced projects", async t => {
  const env = await home(t);
  saveCredentials({ url: "https://acme.mnemio.ai", token: "mnemio_cc_x" }, env);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-here-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = [];
  const request = async (url, opts) => {
    sent.push({ path: url.pathname, body: opts.body && JSON.parse(opts.body) });
    return url.pathname.endsWith("/projects") ? Response.json({ prefs: { projects: [dir] } }) : Response.json({ workspace: "Acme", prefs: {} });
  };
  assert.deepEqual(await run("sync-here", "", env, request, dir), { project: dir, syncing: true, projects: [dir] });
  assert.deepEqual(sent[0], { path: "/api/claude/config/projects", body: { path: dir, add: true } });
});

test("the plugin's server passes on Mnemio's tools and connected apps, and says when connecting changes them", async t => {
  const env = { ...(await home(t)) };
  const sent = [];
  const upstream = [];
  const request = async (url, opts) => {
    const body = JSON.parse(opts.body);
    upstream.push({ path: url.pathname, method: body.method, auth: opts.headers.authorization, session: opts.headers["mcp-session-id"] });
    const answer = result => body.id === undefined ? new Response(null, { status: 202 }) : url.pathname.includes("/apps/")
      // Connected apps answer as an event stream, with a session id, like Composio.
      ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" } })
      : Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {} });
    if (body.method === "tools/list") return answer({ tools: url.pathname.includes("/apps/") ? [{ name: "GMAIL_SEND", inputSchema: {} }] : [{ name: "list_goals", inputSchema: {} }] });
    if (body.method === "tools/call") return answer({ content: [{ type: "text", text: `ran ${body.params.name}` }] });
    return answer({});
  };
  const channel = createChannel({ env, request, send: m => sent.push(m), sleep: () => new Promise(r => setTimeout(r, 5)), watchMs: 5 });
  t.after(() => channel.close());
  await channel.onMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.match(sent[0].result.instructions, /isn't connected yet/);
  await channel.onMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  await channel.onMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(sent.find(m => m.id === 2).result.tools, [], "nothing until connected");

  saveCredentials({ url: "https://acme.mnemio.ai", token: "mnemio_cc_t" }, env);
  while (!sent.some(m => m.method === "notifications/tools/list_changed")) await new Promise(r => setTimeout(r, 5));
  await channel.onMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(sent.find(m => m.id === 3).result.tools.map(t => t.name), ["list_goals", "GMAIL_SEND"]);
  await channel.onMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "GMAIL_SEND", arguments: { to: "x" } } });
  assert.deepEqual(sent.find(m => m.id === 4).result.content, [{ type: "text", text: "ran GMAIL_SEND" }]);
  const appCalls = upstream.filter(u => u.path === "/api/claude/apps/mcp");
  assert.equal(appCalls.at(-1).session, "s-1", "keeps the apps server's session");
  assert.ok(upstream.every(u => u.auth === "Bearer mnemio_cc_t"), "the saved sign-in is used");
});

test("connect stops before showing a code when Node.js is too old for the plugin", async t => {
  let called = false;
  await assert.rejects(connect("acme.mnemio.ai", { env: {}, request: async () => { called = true; }, node: "20.11.1", waitMs: 0, log: () => {} }), /Node\.js 22 or newer, and this computer has 20\.11\.1/);
  assert.equal(called, false);
});

test("on a Node.js too old to have fetch, the command says to upgrade instead of failing on fetch", async () => {
  const { execFileSync } = await import("node:child_process");
  const old = 'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "16.20.0" } }); delete globalThis.fetch;';
  let out = "";
  try {
    execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(old)}`, fileURLToPath(new URL("../scripts/brain.mjs", import.meta.url)), "connect", "acme.mnemio.ai"], { encoding: "utf8", stdio: "pipe", env: { ...process.env, MNEMIO_CONFIG_DIR: tmpdir() } });
  } catch (e) {
    out = e.stderr;
  }
  assert.match(out, /Node\.js 22 or newer, and this computer has 16\.20\.0/);
  assert.doesNotMatch(out, /fetch is not defined/);
});
