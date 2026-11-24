import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { handle, syncProject } from "../scripts/hooks.mjs";
import { readListenerOffer, saveListenerOffer } from "../scripts/lib/credentials.mjs";

async function setup(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mnemio-project-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { MNEMIO_SYNC_PROJECT: cwd, MNEMIO_URL: "http://localhost:8787", MNEMIO_TOKEN: "test", CLAUDE_PLUGIN_DATA: join(cwd, "data"), MNEMIO_CONFIG_DIR: join(cwd, "config-home"), MNEMIO_SKILLS_DIR: join(cwd, "skills-home") };
  const calls = [];
  const request = async (url, opts) => {
    // Reading the person's settings from Mnemio isn't a sync call.
    if (url.pathname === "/api/claude/config") return Response.json({ workspace: "Acme", prefs: {} });
    if (url.pathname === "/api/claude/skills/_bundle") return Response.json({ hash: "none", skills: [] });
    calls.push({ path: url.pathname, data: opts.body && JSON.parse(opts.body) });
    return Response.json({ hash: "a".repeat(64), skills: ["deploy"], facts: ["Use staging first."] });
  };
  const hook = (event, mode, network = request) => handle({ cwd, ...event }, mode, env, network);
  return { cwd, calls, hook, env };
}

test("recalls mid-turn only in the enabled project", async t => {
  const { cwd, hook, calls } = await setup(t);
  const event = { hook_event_name: "UserPromptSubmit", prompt: "How do we deploy?" };
  assert.match((await hook(event)).hookSpecificOutput.additionalContext, /Use staging/);
  assert.deepEqual(calls[0].data, { query: event.prompt });
  const outside = await realpath(await mkdtemp(join(tmpdir(), "mnemio-elsewhere-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await hook({ ...event, cwd: outside });
  assert.equal(calls.length, 1, "a folder outside every opted-in project sends nothing");
});

test("syncs several projects, from any folder inside one, as the deepest listed project", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mnemio-projects-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const d of ["web/src", "web/packages/api", "notes"]) await mkdir(join(base, d), { recursive: true });
  const env = { MNEMIO_SYNC_PROJECTS: [join(base, "web"), join(base, "web/packages/api"), "relative/ignored"].join(delimiter) };
  assert.equal(await syncProject({ cwd: join(base, "web/src") }, env), join(base, "web"));
  assert.equal(await syncProject({ cwd: join(base, "web/packages/api") }, env), join(base, "web/packages/api"));
  assert.equal(await syncProject({ cwd: join(base, "notes") }, env), null);
  assert.equal(await syncProject({ cwd: join(base, "webby") }, env), null, "a sibling with the same prefix isn't inside");
  assert.equal(await syncProject({ cwd: join(base, "notes") }, { MNEMIO_SYNC_PROJECT: join(base, "notes") }), join(base, "notes"));
  assert.equal(await syncProject({ cwd: join(base, "web/src") }, { MNEMIO_SYNC_PROJECTS: "*", CLAUDE_PROJECT_DIR: join(base, "web") }), join(base, "web"));
  assert.equal(await syncProject({ cwd: join(base, "notes") }, {}), null, "nothing syncs unless opted in");
});

test("next startup retries an interrupted turn save without resending after acknowledgment", async t => {
  const { hook, calls } = await setup(t);
  const turn = { hook_event_name: "Stop", last_assistant_message: "Use staging.", transcript_path: "/never/read" };
  await assert.rejects(hook(turn, undefined, async () => { throw Error("offline"); }), /offline/);
  for (let i = 0; i < 2; i++) await hook({ hook_event_name: "SessionStart" }, "reconcile");
  assert.deepEqual(calls, [{ path: "/api/claude/memory", data: { text: "Use staging.", source: "turn" } }]);
});

test("uploads authored Markdown references after edits and skips linked, hidden and executable files", async t => {
  const { cwd, calls, hook } = await setup(t);
  const dir = join(cwd, ".claude/skills/ship");
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# Ship");
  await writeFile(join(dir, "references/check.md"), "Build first");
  await writeFile(join(dir, ".env"), "skip");
  await writeFile(join(dir, "build.sh"), "skip");
  await symlink(join(dir, ".env"), join(dir, "linked.md"));
  await hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(dir, "references/check.md") } });
  await hook({ hook_event_name: "SessionStart" }, "reconcile");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data.files, { "SKILL.md": "# Ship", "references/check.md": "Build first" });
});

test("updates the same memory document when Claude edits it", async t => {
  const { cwd, calls, hook, env } = await setup(t);
  env.CLAUDE_CONFIG_DIR = join(cwd, "config");
  const session = join(env.CLAUDE_CONFIG_DIR, "projects/demo");
  await mkdir(join(session, "memory"), { recursive: true });
  const path = join(session, "memory/release.md");
  for (const text of ["Tuesday", "Thursday"]) {
    await writeFile(path, text);
    await hook({ hook_event_name: "PostToolUse", tool_name: "Write", transcript_path: join(session, "session.jsonl"), tool_input: { file_path: path } });
  }
  assert.equal(calls[0].data.key, calls[1].data.key);
  assert.deepEqual(calls.map(c => c.data.text), ["Tuesday", "Thursday"]);
});

test("connected by the company's setup, Claude asks about the background listener until it's answered", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mnemio-managed-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Managed settings give the workspace only; this computer has no sign-in yet. Nothing listens on port 1, so the
  // listener's own report to Mnemio fails fast.
  const env = { MNEMIO_URL: "http://localhost:1", MNEMIO_NO_BROWSER: "1", MNEMIO_CONFIG_DIR: join(home, "config"), MNEMIO_SKILLS_DIR: join(home, "skills"), CLAUDE_PLUGIN_DATA: join(home, "data") };
  const request = async url => {
    if (url.pathname === "/api/claude/connect/start") return Response.json({ device_code: "d".repeat(43), user_code: "ABCD-EFGH", verification_uri_complete: "http://localhost:1/connect-claude?code=ABCD-EFGH", expires_in: 600, interval: 1, workspace: "Acme" });
    if (url.pathname === "/api/claude/connect/poll") return Response.json({ status: "approved", token: "t".repeat(40), workspace: "Acme" });
    if (url.pathname === "/api/claude/config") return Response.json({ workspace: "Acme", prefs: {} });
    return Response.json({ hash: "none", skills: [] });
  };
  const start = mode => handle({ hook_event_name: "SessionStart", cwd: home }, mode, env, request);
  const context = output => output?.hookSpecificOutput?.additionalContext ?? "";
  const offer = readListenerOffer;
  const asks = /answer their Mnemio chats here in the background/;

  assert.match(context(await start()), /press Approve/);
  assert.equal(offer(env), null, "nothing to ask before the approval");
  assert.match(context(await start("reconcile")), asks, "the session that connected is asked at its next turn");
  assert.ok(offer(env).connectedAt && !offer(env).shownAt);

  const first = context(await start());
  assert.match(first, asks, "and so is the next session");
  assert.match(first, /\/mnemio:listen command .* "on"\. If no, run it with the argument "skip"/);
  assert.equal(context(await start()), "", "only once a day");
  assert.equal(context(await handle({ hook_event_name: "SessionStart", cwd: home }, undefined, { ...env, MNEMIO_LISTENER: "1" }, request)), "", "never in a listener's own run");
  saveListenerOffer({ ...offer(env), shownAt: Date.now() - 25 * 3_600_000 }, env);
  assert.match(context(await start()), asks, "an ignored question comes back the next day");

  // Saying no (or yes) answers it for good.
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/listener.mjs", import.meta.url)), "skip"], { env: { ...process.env, ...env } });
  assert.equal(offer(env), null);
  assert.equal(context(await start()), "", "an answered question isn't asked again, even a day later");
});

test("a computer connected with /mnemio:connect is never asked again at session start", async t => {
  const { hook, env } = await setup(t);
  const output = await hook({ hook_event_name: "SessionStart" });
  assert.doesNotMatch(output?.hookSpecificOutput?.additionalContext ?? "", /in the background/);
  assert.equal(readListenerOffer(env), null);
});

test("a session that starts after the approval finishes connecting at once, and a denied request isn't reopened", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mnemio-approved-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { MNEMIO_URL: "http://localhost:1", MNEMIO_NO_BROWSER: "1", MNEMIO_CONFIG_DIR: join(home, "config"), MNEMIO_SKILLS_DIR: join(home, "skills"), CLAUDE_PLUGIN_DATA: join(home, "data") };
  let answer = "pending", starts = 0;
  const request = async url => {
    if (url.pathname === "/api/claude/connect/start") return starts++, Response.json({ device_code: "d".repeat(43), user_code: "ABCD-EFGH", verification_uri_complete: "http://localhost:1/connect-claude?code=ABCD-EFGH", expires_in: 600, interval: 1, workspace: "Acme" });
    if (url.pathname === "/api/claude/connect/poll") return answer === "approved" ? Response.json({ status: "approved", token: "t".repeat(40), workspace: "Acme" }) : answer === "denied" ? Response.json({ status: "denied" }, { status: 410 }) : Response.json({ status: "pending", interval: 1 });
    return Response.json({ workspace: "Acme", prefs: {}, hash: "none", skills: [] });
  };
  const start = () => handle({ hook_event_name: "SessionStart", cwd: home }, undefined, env, request);
  const context = output => output?.hookSpecificOutput?.additionalContext ?? "";

  assert.match(context(await start()), /press Approve/);
  assert.match(context(await start()), /press Approve/, "still waiting: the same code, not a new one");
  assert.equal(starts, 1);
  answer = "approved";
  const next = context(await start());
  assert.match(next, /finished connecting this computer/, "approved meanwhile: connected here, not asked to approve again");
  assert.match(next, /answer their Mnemio chats here in the background/);
  assert.ok(readListenerOffer(env).shownAt, "asked already, so the next session doesn't ask again today");
  assert.equal(context(await start()), "");

  // Denied: the request is gone, and no new approval page opens until the once-a-day turn.
  const other = { ...env, MNEMIO_CONFIG_DIR: join(home, "config-2") };
  answer = "pending";
  await handle({ hook_event_name: "SessionStart", cwd: home }, undefined, other, request);
  answer = "denied";
  assert.doesNotMatch(context(await handle({ hook_event_name: "SessionStart", cwd: home }, undefined, other, request)), /press Approve/);
  assert.equal(starts, 2, "no new request right after a denial");
});
