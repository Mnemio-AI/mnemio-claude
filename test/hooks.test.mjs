import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { handle, syncProject } from "../scripts/hooks.mjs";

async function setup(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mnemio-project-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { MNEMIO_SYNC_PROJECT: cwd, MNEMIO_TOKEN: "test", CLAUDE_PLUGIN_DATA: join(cwd, "data") };
  const calls = [];
  const request = async (url, opts) => {
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
