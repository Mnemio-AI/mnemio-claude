import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerOne, claudeArgs, install, run, runClaude, toolEvents, workDir } from "../scripts/listener.mjs";
import { describeStep } from "../scripts/lib/steps.mjs";
import { handle } from "../scripts/hooks.mjs";
import { readCredentials } from "../scripts/lib/credentials.mjs";

async function home(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-listen-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { MNEMIO_CONFIG_DIR: dir, MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_CLAUDE_BIN: "/usr/local/bin/claude" };
}

/**
 * A fake `claude -p`: records what it was given and answers with `reply(args, input, cwd)` — one JSON result, or a
 * list of stream-json lines (tool uses, then the result), written in two chunks that split a line.
 */
function fakeClaude(reply) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = "";
    child.stdin = { end: text => {
      input = text;
      calls.push({ bin, args, cwd: opts.cwd, input, channel: opts.env.MNEMIO_CHANNEL, listener: opts.env.MNEMIO_LISTENER });
      const r = reply(args, input, opts.cwd);
      setImmediate(() => {
        const text = Array.isArray(r) ? r.map(l => JSON.stringify(l)).join("\n") + "\n" : JSON.stringify(r);
        const cut = Math.floor(text.length / 2);
        child.stdout.emit("data", text.slice(0, cut));
        child.stdout.emit("data", text.slice(cut));
        child.emit("close", 0);
      });
    } };
    child.kill = () => {};
    return child;
  };
  return { calls, spawnFn };
}

const message = (id, text, conversation = "web:c1") => ({ id, conversation, platform: "web", sender: "Asha", text, context: [], memories: ["Asha ships on Fridays."], attachments: [] });

test("claude runs with only Mnemio's tools, skills, reading its own folder and writing its outbox", () => {
  assert.deepEqual(claudeArgs({ dir: "/w", sessionId: "s1" }), ["-p", "--output-format", "stream-json", "--verbose", "--resume", "s1", "--allowedTools", "mcp__plugin_mnemio_mnemio", "Skill", "Read(./**)", "Edit(./outbox/**)"]);
  assert.ok(!claudeArgs({ dir: "/w" }).includes("--resume"));
});

test("runClaude reads Claude's JSON result, and reports its errors", async () => {
  const ok = fakeClaude(() => ({ type: "result", subtype: "success", is_error: false, result: " Done. ", session_id: "s9" }));
  assert.deepEqual(await runClaude("hi", { bin: "claude", args: [], cwd: "/", spawnFn: ok.spawnFn }), { text: "Done.", sessionId: "s9" });
  const bad = fakeClaude(() => ({ type: "result", subtype: "error_max_turns", is_error: true, result: "Too many turns" }));
  await assert.rejects(runClaude("hi", { bin: "claude", args: [], cwd: "/", spawnFn: bad.spawnFn }), /Too many turns/);
});

test("answers each message with the person's own claude, one session per conversation, and sends the reply", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    sent.push({ path: url.pathname, body: JSON.parse(opts.body) });
    return Response.json({ delivered: "reply" });
  };
  let n = 0;
  const claude = fakeClaude(args => args.includes("--resume") && args[args.indexOf("--resume") + 1] === "gone"
    ? { type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found" }
    : { type: "result", subtype: "success", is_error: false, result: `Answer ${++n}`, session_id: "sess-A" });

  assert.equal(await answerOne(message("7d0c8a5e-0000-4000-8000-000000000001", "How do we release?"), { env, request, spawnFn: claude.spawnFn }), "Answer 1");
  const first = claude.calls[0];
  assert.equal(first.bin, "/usr/local/bin/claude");
  assert.equal(first.cwd, workDir(env));
  assert.equal(first.channel, "", "never collects messages itself");
  assert.equal(first.listener, "1", "the plugin's hooks know it's the listener");
  assert.match(first.input, /What Mnemio remembers[\s\S]*Asha ships on Fridays[\s\S]*Asha wrote in the Mnemio web app:\nHow do we release\?[\s\S]*Your final message is sent to them as your reply/);
  assert.ok(!first.args.includes("--resume"));
  assert.deepEqual(sent[0], { path: "/api/claude/inbox/7d0c8a5e-0000-4000-8000-000000000001/reply", body: { text: "Answer 1" } });

  await answerOne(message("7d0c8a5e-0000-4000-8000-000000000002", "And tomorrow?"), { env, request, spawnFn: claude.spawnFn });
  assert.deepEqual(claude.calls[1].args.slice(4, 6), ["--resume", "sess-A"], "the same conversation continues its Claude session");

  // A session that's gone: a fresh one, not an error.
  await (await import("node:fs/promises")).writeFile(join(env.MNEMIO_CONFIG_DIR, "listener/sessions.json"), JSON.stringify({ "web:c2": "gone" }));
  assert.equal(await answerOne(message("7d0c8a5e-0000-4000-8000-000000000003", "Hi", "web:c2"), { env, request, spawnFn: claude.spawnFn }), "Answer 3");
});

test("the loop tells the person when their Claude couldn't answer, and waits for a sign-in when there's none", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) return Response.json(message("7d0c8a5e-0000-4000-8000-000000000004", "Hi"));
    sent.push(JSON.parse(opts.body));
    return Response.json({ delivered: "reply" });
  };
  const broken = fakeClaude(() => ({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" }));
  const state = await run({ env, request, spawnFn: broken.spawnFn, once: true });
  assert.match(sent[0].text, /couldn't answer this: Not logged in/);
  assert.equal(state.lastError, "Not logged in");

  const nobody = await run({ env: { MNEMIO_CONFIG_DIR: env.MNEMIO_CONFIG_DIR }, request, once: true });
  assert.match(nobody.lastError, /mnemio:connect/);
});

test("installs a background service that starts the newest plugin at login (dry run: nothing loaded)", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const env = { ...(await home(t)), MNEMIO_LISTENER_DRY_RUN: "1" };
  const r = install({ env, exec: () => assert.fail("dry run must not touch the system") });
  const file = await readFile(r.service, "utf8");
  assert.match(file, process.platform === "darwin" ? /launch\.mjs[\s\S]*<key>KeepAlive<\/key><true\/>/ : /Restart=always[\s\S]*launch\.mjs|launch\.mjs[\s\S]*Restart=always/);
  if (process.platform === "darwin") (await import("node:child_process")).execFileSync("plutil", ["-lint", r.service]);
  const launcher = await readFile(join(env.MNEMIO_CONFIG_DIR, "listener/launch.mjs"), "utf8");
  assert.match(launcher, /listener\.mjs/);
  const saved = JSON.parse(await readFile(join(env.MNEMIO_CONFIG_DIR, "listener/listener.json"), "utf8"));
  assert.equal(saved.claude, "/usr/local/bin/claude");
});

test("with the workspace set by the company, the first session starts connecting by itself, at most once a day", async t => {
  const env = { ...(await home(t)), MNEMIO_TOKEN: "", MNEMIO_NO_BROWSER: "1" };
  delete env.MNEMIO_TOKEN;
  let polls = 0;
  const request = async url => {
    if (url.pathname.endsWith("/connect/start")) return Response.json({ device_code: "d".repeat(43), user_code: "WXYZ-2345", verification_uri_complete: "https://acme.mnemio.ai/connect-claude?code=WXYZ-2345", expires_in: 600, interval: 1, workspace: "Acme" });
    if (url.pathname.endsWith("/connect/poll")) return ++polls < 2 ? Response.json({ status: "pending", interval: 0 }) : Response.json({ status: "approved", token: "mnemio_cc_" + "b".repeat(64), url: "https://acme.mnemio.ai", workspace: "Acme" });
    return Response.json({});
  };
  const start = { hook_event_name: "SessionStart", cwd: env.MNEMIO_CONFIG_DIR };
  const first = await handle(start, undefined, env, request);
  assert.match(first.hookSpecificOutput.additionalContext, /press Approve[\s\S]*|code WXYZ-2345/);
  await handle(start, "reconcile", env, request);
  assert.equal(readCredentials(env).token, "mnemio_cc_" + "b".repeat(64), "the background half finished it");

  // Disconnected again and a session the same day: no new page, just the hint.
  (await import("node:fs")).rmSync(join(env.MNEMIO_CONFIG_DIR, "credentials.json"));
  const again = await handle(start, undefined, env, async () => assert.fail("no new request today"));
  assert.match(again.hookSpecificOutput.additionalContext, /run \/mnemio:connect/);
});

test("a claude that can't start is reported, not a crash", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => { child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })); });
    child.kill = () => {};
    return child;
  };
  await assert.rejects(runClaude("hi", { bin: "claude", args: [], cwd: "/", spawnFn }), /ENOENT/);
});

test("in a listener's run, the plugin's hooks leave recall and saving to Mnemio", async () => {
  const env = { MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_LISTENER: "1", MNEMIO_SYNC_PROJECTS: "*", MNEMIO_CONFIG_DIR: tmpdir() + "/mnemio-listener-hooks" };
  const none = async () => assert.fail("no call to Mnemio");
  assert.equal(await handle({ hook_event_name: "UserPromptSubmit", cwd: tmpdir(), prompt: "hi" }, undefined, env, none), undefined);
  assert.equal(await handle({ hook_event_name: "Stop", cwd: tmpdir(), last_assistant_message: "hello" }, undefined, env, none), undefined);
});

const toolUse = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id, name, input }] } });
const toolResult = (id, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "…", is_error: isError }] } });
const success = (result, session_id = "sess-S") => ({ type: "result", subtype: "success", is_error: false, result, session_id });

test("reads Claude's stream: each tool use as it starts and ends, then the result", async () => {
  const seen = [];
  const claude = fakeClaude(() => [
    { type: "system", subtype: "init", session_id: "sess-S" },
    toolUse("t1", "mcp__plugin_mnemio_mnemio__list_goals", {}),
    toolResult("t1"),
    toolUse("t2", "Skill", { skill: "mnemio-release-checklist" }),
    toolResult("t2", true),
    success(" Shipped. ")
  ]);
  assert.deepEqual(await runClaude("hi", { bin: "claude", args: [], cwd: "/", spawnFn: claude.spawnFn, onTool: e => seen.push(e) }), { text: "Shipped.", sessionId: "sess-S" });
  assert.deepEqual(seen, [
    { id: "t1", name: "mcp__plugin_mnemio_mnemio__list_goals", input: {}, state: "started" },
    { id: "t1", state: "done" },
    { id: "t2", name: "Skill", input: { skill: "mnemio-release-checklist" }, state: "started" },
    { id: "t2", state: "failed" }
  ]);
  assert.deepEqual(toolEvents({ type: "result" }), []);
});

test("steps get the names a person would use, and only a short preview", () => {
  assert.deepEqual(describeStep("mcp__plugin_mnemio_mnemio__list_goals", {}), { tool: "Checking goals", preview: "" });
  assert.deepEqual(describeStep("mcp__plugin_mnemio_mnemio__recall_memory", { query: "rollout  plan" }), { tool: "Searching memory", preview: "rollout plan" });
  assert.equal(describeStep("Skill", { skill: "mnemio-release-checklist" }).tool, "Using mnemio-release-checklist");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__GMAIL_FETCH_EMAILS", { query: "x" }).tool, "Using gmail fetch emails");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__call_connected_tool", { server: "crm", tool: "find_deal" }).tool, "Using find deal");
  assert.deepEqual(describeStep("Write", { file_path: "/w/outbox/report.csv", content: "secret,stuff" }), { tool: "Making a file", preview: "report.csv" });
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__message_colleague", { message: "x".repeat(500) }).preview.length, 120);
  assert.equal(describeStep("ToolSearch", { query: "select:mcp__plugin_mnemio_mnemio__list_goals" }), null, "Claude Code's plumbing isn't a step");
});

/** A Mnemio that records the plugin API calls. */
function recorder() {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ path: url.pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
    return Response.json(url.pathname.endsWith("/reply") ? { delivered: "reply" } : { ok: true });
  };
  return { calls, request };
}

test("reports each step to Mnemio as it happens, then sends the answer with the files Claude put in its outbox", async t => {
  const env = await home(t);
  const { calls, request } = recorder();
  const { writeFile, mkdir } = await import("node:fs/promises");
  // Left over from an earlier run that crashed: never sent with this answer.
  await mkdir(join(workDir(env), "outbox"), { recursive: true });
  await writeFile(join(workDir(env), "outbox", "old.txt"), "stale");
  const claude = fakeClaude((args, input, cwd) => {
    assert.ok(!require("node:fs").existsSync(join(cwd, "outbox", "old.txt")), "the outbox starts empty");
    require("node:fs").writeFileSync(join(cwd, "outbox", "report.csv"), "a,b\n1,2\n");
    require("node:fs").mkdirSync(join(cwd, "outbox", "charts"));
    require("node:fs").writeFileSync(join(cwd, "outbox", "charts", "q3.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    require("node:fs").writeFileSync(join(cwd, "outbox", ".hidden"), "no");
    require("node:fs").writeFileSync(join(cwd, "outbox", "big.bin"), Buffer.alloc(15 * 1024 * 1024 + 1));
    require("node:fs").symlinkSync("/etc/hosts", join(cwd, "outbox", "hosts"));
    return [toolUse("t0", "ToolSearch", { query: "goals" }), toolResult("t0"), toolUse("t1", "mcp__plugin_mnemio_mnemio__list_goals", {}), toolResult("t1"), toolUse("t2", "Write", { file_path: join(cwd, "outbox/report.csv") }), toolResult("t2"), success("Here's the report.")];
  });
  const id = "7d0c8a5e-0000-4000-8000-0000000000a1";
  const text = await answerOne(message(id, "Make me a report"), { env, request, spawnFn: claude.spawnFn });
  assert.match(claude.calls[0].input, /write it into the outbox folder \(\.\/outbox\/\)/);
  assert.deepEqual(calls.map(c => c.path), [...Array(4).fill(`/api/claude/inbox/${id}/progress`), `/api/claude/inbox/${id}/reply`], "steps first, in order, then the answer");
  assert.deepEqual(calls.slice(0, 4).map(c => c.body), [
    { step: "t1", tool: "Checking goals", preview: "", state: "started" },
    { step: "t1", tool: "Checking goals", state: "done" },
    { step: "t2", tool: "Making a file", preview: "report.csv", state: "started" },
    { step: "t2", tool: "Making a file", state: "done" }
  ]);
  const reply = calls[4].body;
  assert.deepEqual(reply.files.map(f => f.name), ["q3.png", "report.csv"], "regular, visible files only (subfolders too), never through a link");
  assert.equal(Buffer.from(reply.files[1].data, "base64").toString(), "a,b\n1,2\n");
  assert.match(text, /^Here's the report\.[\s\S]*Too large or too many to send: big\.bin/);
  assert.deepEqual(require("node:fs").readdirSync(join(workDir(env), "outbox")), [], "emptied after sending");
});

test("one message's files never go out with another conversation's answer, even when the first one failed", async t => {
  const env = await home(t);
  const { calls, request } = recorder();
  let n = 0;
  const claude = fakeClaude((args, input, cwd) => {
    n++;
    if (n === 1) {
      require("node:fs").writeFileSync(join(cwd, "outbox", "private.txt"), "for Asha only");
      return { type: "result", subtype: "error_during_execution", is_error: true, result: "Crashed" };
    }
    return success("Hello.");
  });
  await assert.rejects(answerOne(message("7d0c8a5e-0000-4000-8000-0000000000b1", "Draft it", "slack:dm1"), { env, request, spawnFn: claude.spawnFn }), /Crashed/);
  await answerOne(message("7d0c8a5e-0000-4000-8000-0000000000b2", "Hi", "web:other"), { env, request, spawnFn: claude.spawnFn });
  const replies = calls.filter(c => c.path.endsWith("/reply"));
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].body, { text: "Hello." }, "no files");
});

test("a step report that fails never holds the answer up", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/progress")) throw new Error("connection reset");
    sent.push(JSON.parse(opts.body));
    return Response.json({ delivered: "reply" });
  };
  const claude = fakeClaude(() => [toolUse("t1", "Read", { file_path: "/w/inbox/a.pdf" }), toolResult("t1"), success("Read it.")]);
  assert.equal(await answerOne(message("7d0c8a5e-0000-4000-8000-0000000000c1", "Summarise"), { env, request, spawnFn: claude.spawnFn }), "Read it.");
  assert.deepEqual(sent, [{ text: "Read it." }]);
});
