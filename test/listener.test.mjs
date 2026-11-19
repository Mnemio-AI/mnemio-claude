import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { answerOne, check, claudeArgs, claudeProbe, claudeSignIn, desktopClaude, install, listenerSettings, listenerDir, mcpConfig, messageFolder, openFence, outboxFiles, replyText, run, reportSetup, runClaude, shortName, startHeartbeat, status, stepReporter, toolEvents, workDir } from "../scripts/listener.mjs";
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
function fakeClaude(reply, { bytes = false } = {}) {
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
        const text = r === null ? "" : Array.isArray(r) ? r.map(l => JSON.stringify(l)).join("\n") + "\n" : JSON.stringify(r);
        if (bytes) {
          // Raw bytes, cut inside the first multi-byte character: the way a pipe can deliver them.
          const buf = Buffer.from(text);
          const cut = buf.findIndex(b => b >= 0x80) + 1 || Math.floor(buf.length / 2);
          child.stdout.emit("data", buf.subarray(0, cut));
          child.stdout.emit("data", buf.subarray(cut));
        } else {
          const cut = Math.floor(text.length / 2);
          child.stdout.emit("data", text.slice(0, cut));
          child.stdout.emit("data", text.slice(cut));
        }
        child.emit("close", r === null ? 1 : 0);
      });
    } };
    child.kill = () => {};
    return child;
  };
  return { calls, spawnFn };
}

const message = (id, text, conversation = "web:c1") => ({ id, conversation, platform: "web", sender: "Asha", text, context: [], memories: ["Asha ships on Fridays."], attachments: [] });

/** The outbox a fake claude was allowed to write to (from its Edit rule: "//" + a full path). */
const outboxOf = args => /^Edit\(\/(\/.+)\/\*\*\)$/.exec(args.find(a => a.startsWith("Edit(")))[1];

test("claude runs with only Mnemio's tools, skills, reading this message's folder and writing its outbox", () => {
  assert.deepEqual(claudeArgs({ sessionId: "s1", folder: "/c/messages/m1", outbox: "/c/messages/m1/outbox", mcp: "{}" }), ["-p", "--output-format", "stream-json", "--verbose", "--resume", "s1", "--tools", "Read,Edit,Write,Skill,ToolSearch", "--strict-mcp-config", "--mcp-config", "{}", "--no-chrome", "--allowedTools", "mcp__plugin_mnemio_mnemio", "Skill", "Read(//c/messages/m1/**)", "Edit(//c/messages/m1/outbox/**)"]);
  // Only Mnemio's own server, started from this plugin, under the plugin's server name (so its tools keep their
  // names and any deny rule for them applies), with the sign-in by reference, never on the command line.
  const servers = JSON.parse(mcpConfig("/usr/bin/node")).mcpServers;
  assert.deepEqual(Object.keys(servers), ["plugin_mnemio_mnemio"]);
  assert.equal(servers.plugin_mnemio_mnemio.command, "/usr/bin/node");
  assert.match(servers.plugin_mnemio_mnemio.args[0], /scripts\/channel\.mjs$/);
  assert.deepEqual(servers.plugin_mnemio_mnemio.env, { MNEMIO_CHANNEL: "", MNEMIO_URL: "${MNEMIO_URL:-}", MNEMIO_TOKEN: "${MNEMIO_TOKEN:-}" });
  // A plugin installed under a folder with spaces: a real path, not a percent-encoded URL.
  assert.equal(JSON.parse(mcpConfig("/n", "/Users/a b/plugins/mnemio/scripts/channel.mjs")).mcpServers.plugin_mnemio_mnemio.args[0], "/Users/a b/plugins/mnemio/scripts/channel.mjs");
  assert.doesNotMatch(JSON.parse(mcpConfig()).mcpServers.plugin_mnemio_mnemio.args[0], /%[0-9A-F]{2}/);
  assert.ok(!claudeArgs({ folder: "/f", outbox: "/f/outbox" }).includes("--resume"));
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
  const state = await run({ env, request, spawnFn: broken.spawnFn, once: true, signIn: async () => "ok" });
  assert.match(sent[0].text, /couldn't answer this: Not logged in/);
  assert.equal(state.lastError, "Not logged in");

  const nobody = await run({ env: { MNEMIO_CONFIG_DIR: env.MNEMIO_CONFIG_DIR }, request, once: true, signIn: async () => "ok" });
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

test("steps get the names a person would use, and a preview only where it can't carry private text", () => {
  assert.deepEqual(describeStep("mcp__plugin_mnemio_mnemio__list_goals", {}), { tool: "Checking goals", preview: "" });
  assert.deepEqual(describeStep("mcp__mnemio__list_goals", {}), { tool: "Checking goals", preview: "" }, "as the listener loads them");
  assert.deepEqual(describeStep("mcp__plugin_mnemio_mnemio__recall_memory", { query: "rollout  plan" }), { tool: "Searching memory", preview: "rollout plan" });
  assert.equal(describeStep("Skill", { skill: "mnemio-release-checklist" }).tool, "Using mnemio-release-checklist");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__GMAIL_FETCH_EMAILS", { query: "x" }).tool, "Using gmail fetch emails");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__call_connected_tool", { server: "crm", tool: "find_deal" }).tool, "Using find deal");
  assert.deepEqual(describeStep("Write", { file_path: "/w/outbox/report.csv", content: "secret,stuff" }), { tool: "Making a file", preview: "report.csv" });
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__recall_memory", { query: "x".repeat(500) }).preview.length, 120);
  // These can show in a shared thread: what's being sent or approved never does.
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__send_to_my_chat_app", { text: "My salary is…" }).preview, "");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__message_colleague", { colleague_email: "a@b.c", message: "Private" }).preview, "");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__request_approval", { title: "Pay invoice", details: "IBAN …" }).preview, "");
  assert.equal(describeStep("Grep", { pattern: "password" }).preview, "");
  assert.equal(describeStep("ToolSearch", { query: "select:mcp__plugin_mnemio_mnemio__list_goals" }), null, "Claude Code's plumbing isn't a step");
  // A name Claude made up (any text, before the tool checks it) never goes in the label: only plain identifiers.
  assert.equal(describeStep("Skill", { skill: "my salary is 90k" }).tool, "Using a skill");
  assert.equal(describeStep("mcp__plugin_mnemio_mnemio__call_connected_tool", { tool: "send the board deck to bob" }).tool, "Using a connected tool");
  assert.ok(describeStep("mcp__plugin_mnemio_mnemio__" + "X".repeat(150), {}).tool.length <= 80, "labels fit Mnemio's 80 characters");
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
  const fs = require("node:fs");
  const id = "7d0c8a5e-0000-4000-8000-0000000000a1";
  // Left over from an earlier run of this message that crashed: never sent with this answer.
  fs.mkdirSync(join(listenerDir(env), "messages", id, "outbox"), { recursive: true });
  fs.writeFileSync(join(listenerDir(env), "messages", id, "outbox", "old.txt"), "stale");
  // What earlier versions left in the working folder (every message's files): removed, so nothing can read them.
  fs.mkdirSync(join(workDir(env), "inbox", "7d0c8a5e-0000-4000-8000-0000000000a0"), { recursive: true });
  fs.writeFileSync(join(workDir(env), "inbox", "7d0c8a5e-0000-4000-8000-0000000000a0", "other.pdf"), "someone else's");
  const long = "q".repeat(230) + ".xlsx";
  let box;
  const claude = fakeClaude((args, input, cwd) => {
    box = outboxOf(args);
    assert.match(box, new RegExp(`/listener/messages/${id}\\.[0-9a-f]{8}/outbox$`), "this message's own outbox, one per claim");
    assert.ok(args.includes(`Read(/${dirname(box)}/**)`), "reading only this message's folder");
    assert.ok(!args.some(a => a.startsWith("Read(./")), "not the working folder");
    assert.ok(!fs.existsSync(join(cwd, "inbox")), "earlier versions' files are gone");
    assert.ok(!fs.existsSync(join(box, "old.txt")), "the outbox starts empty");
    fs.writeFileSync(join(box, "report.csv"), "a,b\n1,2\n");
    fs.mkdirSync(join(box, "charts"));
    fs.writeFileSync(join(box, "charts", "q3.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(join(box, long), "wide");
    fs.writeFileSync(join(box, ".hidden"), "no");
    fs.writeFileSync(join(box, "big.bin"), Buffer.alloc(15 * 1024 * 1024 + 1));
    fs.mkdirSync(join(box, "a/b/c/d/e/f/g"), { recursive: true });
    fs.writeFileSync(join(box, "a/b/c/d/e/f/g/deep.txt"), "deep");
    fs.symlinkSync("/etc/hosts", join(box, "hosts"));
    return [toolUse("t0", "ToolSearch", { query: "goals" }), toolResult("t0"), toolUse("t1", "mcp__plugin_mnemio_mnemio__list_goals", {}), toolResult("t1"), toolUse("t2", "Write", { file_path: join(box, "report.csv") }), toolResult("t2"), success("Here's the report.")];
  });
  const text = await answerOne(message(id, "Make me a report"), { env, request, spawnFn: claude.spawnFn });
  assert.ok(claude.calls[0].input.includes(`write it into ${box}/`));
  assert.deepEqual(calls.map(c => c.path), [...Array(4).fill(`/api/claude/inbox/${id}/progress`), `/api/claude/inbox/${id}/reply`], "steps first, in order, then the answer");
  assert.deepEqual(calls.slice(0, 4).map(c => c.body), [
    { step: "t1", tool: "Checking goals", preview: "", state: "started" },
    { step: "t1", tool: "Checking goals", state: "done" },
    { step: "t2", tool: "Making a file", preview: "report.csv", state: "started" },
    { step: "t2", tool: "Making a file", state: "done" }
  ]);
  const reply = calls[4].body;
  const short = "q".repeat(114) + "….xlsx";
  assert.deepEqual(reply.files.map(f => f.name), ["q3.png", short, "report.csv"], "regular, visible files only (subfolders too), never through a link; long names shortened");
  assert.ok(reply.files.every(f => f.name.length <= 120), "names the reply API takes");
  assert.equal(Buffer.from(reply.files[2].data, "base64").toString(), "a,b\n1,2\n");
  assert.match(text, /^Here's the report\.[\s\S]*Not sent: a\/b\/c\/d\/e\/f\/g\/ \(folders nested too deep\), big\.bin\./, "files left out are named, deep folders too");
  assert.ok(!fs.existsSync(dirname(box)), "the message's folder is removed after sending");
});

test("one message's files never go out with another conversation's answer, even when the first one failed", async t => {
  const env = await home(t);
  const { calls, request } = recorder();
  const fs = require("node:fs");
  let n = 0;
  const claude = fakeClaude((args, input, cwd) => {
    n++;
    if (n === 1) {
      fs.writeFileSync(join(outboxOf(args), "private.txt"), "for Asha only");
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

test("two listeners answering at once keep their messages' folders apart; one left behind long ago is cleared", async t => {
  const env = await home(t);
  const fs = require("node:fs");
  const dir = listenerDir(env);
  const a = messageFolder(dir, "7d0c8a5e-0000-4000-8000-0000000000d1");
  fs.writeFileSync(join(a.outbox, "mine.txt"), "A's");
  const old = join(dir, "messages", "7d0c8a5e-0000-4000-8000-0000000000d0");
  fs.mkdirSync(old);
  fs.utimesSync(old, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000));
  const b = messageFolder(dir, "7d0c8a5e-0000-4000-8000-0000000000d2");
  assert.notEqual(a.base, b.base);
  assert.ok(!b.base.startsWith(workDir(env)), "outside the folder Claude works in");
  assert.equal(fs.readFileSync(join(a.outbox, "mine.txt"), "utf8"), "A's", "another message's folder in use is left alone");
  assert.ok(!fs.existsSync(old), "an abandoned one is cleared");
  assert.throws(() => messageFolder(dir, "../escape"), /invalid message id/);
});

test("a messages folder that is a link is removed, never followed and cleared", async t => {
  const env = await home(t);
  const fs = require("node:fs");
  const dir = listenerDir(env);
  const elsewhere = join(env.MNEMIO_CONFIG_DIR, "elsewhere");
  fs.mkdirSync(join(elsewhere, "keep"), { recursive: true });
  fs.utimesSync(join(elsewhere, "keep"), new Date(0), new Date(0));
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(elsewhere, join(dir, "messages"));
  messageFolder(dir, "7d0c8a5e-0000-4000-8000-0000000000d3");
  assert.ok(fs.existsSync(join(elsewhere, "keep")), "what the link pointed at is untouched");
  assert.ok(!fs.lstatSync(join(dir, "messages")).isSymbolicLink());
});

test("a listener folder kept elsewhere through a link stays a link", async t => {
  const env = await home(t);
  const fs = require("node:fs");
  const disk = join(env.MNEMIO_CONFIG_DIR, "other-disk");
  fs.mkdirSync(disk);
  fs.symlinkSync(disk, listenerDir(env));
  const box = messageFolder(listenerDir(env), "7d0c8a5e-0000-4000-8000-0000000000d4");
  assert.ok(fs.lstatSync(listenerDir(env)).isSymbolicLink(), "the link is left as it is");
  assert.ok(box.base.startsWith(fs.realpathSync(disk)));
});

test("the reply always fits the reply API: a long answer is cut, and the note about files left out is bounded", () => {
  const note = replyText("Answer.", Array.from({ length: 500 }, (_, i) => `file-${i}-${"x".repeat(40)}.csv`));
  assert.match(note, /^Answer\.\n\n_\(Not sent: file-0-[\s\S]* and \d+ more\. Up to 10 files/);
  assert.ok(note.length < 2_000);
  const huge = replyText("y".repeat(40_000), ["a.bin"]);
  assert.equal(huge.length <= 30_000, true);
  assert.match(huge, /Cut short[\s\S]*Not sent: a\.bin/);
  assert.equal(shortName("short.pdf"), "short.pdf");
  // Cut inside a code block: it's closed, so what follows (and the file links Mnemio adds) isn't shown as code.
  const code = replyText("Here:\n```\n" + "line\n".repeat(8_000), []);
  assert.ok(code.length <= 30_000);
  assert.match(code, /\n```\n\n_\(Cut short/);
  // A "```" line inside a "````" example doesn't end it; only a fence still open at the cut is closed, with its own kind.
  assert.equal(openFence("````md\n```js\nx\n```\n````\nprose"), "");
  assert.equal(openFence("text\n````md\n```js\nx\n```"), "````");
  assert.equal(openFence("~~~\nx"), "~~~");
  assert.equal(openFence("text\r\n```js\r\nx\r\n"), "```", "Windows line endings too");
  const longFence = replyText("`".repeat(40) + "\n" + "z".repeat(40_000), []);
  assert.ok(longFence.length <= 30_000, "room is kept for a closing fence of any length");
  assert.match(longFence, new RegExp("\\n" + "`".repeat(40) + "\\n\\n_\\(Cut short"));
  const nested = replyText("Example:\n````md\n```js\n" + "y\n".repeat(20_000), []);
  assert.match(nested, /\n````\n\n_\(Cut short/);
  const closed = replyText("````md\n```\nz\n```\n````\n" + "w".repeat(40_000), []);
  assert.doesNotMatch(closed, /```\n\n_\(Cut short/, "nothing to close: no stray fence");
  // Never half of a character (an emoji is two UTF-16 units).
  assert.doesNotMatch(shortName("😀".repeat(80) + ".png"), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.doesNotMatch(replyText("x" + "😀".repeat(20_000)), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("Claude's raw output never reaches the chat when it stops without an answer", async () => {
  // A tool use (with private input), then it stops: no result line.
  const claude = fakeClaude(() => [toolUse("t1", "mcp__plugin_mnemio_mnemio__send_to_my_chat_app", { text: "secret plan" })]);
  const e = await runClaude("hi", { bin: "claude", args: [], cwd: "/", spawnFn: claude.spawnFn }).catch(x => x);
  assert.match(e.message, /Claude stopped without an answer \(exit code 0\)/);
  assert.doesNotMatch(e.message, /secret/);
});

test("a character split between two chunks of Claude's output arrives whole", async () => {
  const seen = [];
  const claude = fakeClaude(() => [toolUse("t1", "Read", { file_path: "/w/inbox/Résumé — 2026.pdf" }), toolResult("t1"), success("Lu ✓")], { bytes: true });
  const r = await runClaude("hi", { bin: "claude", args: [], cwd: "/", spawnFn: claude.spawnFn, onTool: e => seen.push(e) });
  assert.equal(r.text, "Lu ✓");
  assert.equal(seen[0].input.file_path, "/w/inbox/Résumé — 2026.pdf");
});

test("a failed answer is reported as failed, so Mnemio never takes it for the answer", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) return Response.json(message("7d0c8a5e-0000-4000-8000-0000000000e1", "Hi"));
    sent.push(JSON.parse(opts.body));
    return Response.json({ delivered: "reply" });
  };
  const broken = fakeClaude(() => null);
  const state = await run({ env, request, spawnFn: broken.spawnFn, once: true, signIn: async () => "ok" });
  assert.equal(sent[0].failed, true);
  assert.match(sent[0].text, /couldn't answer this: Claude stopped without an answer/);
  assert.match(state.lastError, /exit code 1/);
});

test("step reports still on their way when the answer is ready hold it up briefly, and none go after it", async t => {
  const env = await home(t);
  const posted = [];
  let release;
  const request = async (url, opts) => {
    posted.push(JSON.parse(opts.body));
    if (posted.length === 1) await new Promise(r => { release = r; });
    return Response.json({ ok: true });
  };
  const steps = stepReporter({ id: "7d0c8a5e-0000-4000-8000-0000000000f1" }, { env, request, flushMs: 50 });
  steps.onTool({ id: "t1", name: "mcp__plugin_mnemio_mnemio__list_goals", input: {}, state: "started" });
  steps.onTool({ id: "t1", state: "done" });
  const started = Date.now();
  await steps.flush();
  assert.ok(Date.now() - started < 1_000, "the answer doesn't wait for a slow report");
  assert.deepEqual(steps.unconfirmed(), [{ step: "t1", state: "done" }], "how it ended goes with the answer instead");
  // At most what Mnemio keeps, failed ones first.
  for (let i = 0; i < 150; i++) {
    steps.onTool({ id: `x${i}`, name: "Read", input: {}, state: "started" });
    steps.onTool({ id: `x${i}`, state: i === 149 ? "failed" : "done" });
  }
  const ends = steps.unconfirmed();
  assert.equal(ends.length, 100);
  assert.deepEqual(ends[0], { step: "x149", state: "failed" });
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(posted.length, 1, "the queued report is dropped once the answer went");
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
  assert.deepEqual(sent, [{ text: "Read it.", steps: [{ step: "t1", state: "done" }] }], "the step's end goes with the answer instead");
});

test("an outbox that was swapped for a link sends nothing", async t => {
  const env = await home(t);
  const fs = require("node:fs");
  const box = messageFolder(listenerDir(env), "7d0c8a5e-0000-4000-8000-0000000000e9");
  fs.rmSync(box.outbox, { recursive: true });
  fs.symlinkSync(env.MNEMIO_CONFIG_DIR, box.outbox);
  await assert.rejects(outboxFiles(box.outbox), /moved or replaced/);
});

test("when Claude stops mid-way, the failure says how its steps ended: unfinished ones failed", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) return Response.json(message("7d0c8a5e-0000-4000-8000-0000000000ea", "Hi"));
    sent.push({ path: url.pathname, body: JSON.parse(opts.body) });
    return Response.json({ ok: true });
  };
  const claude = fakeClaude(() => [toolUse("t1", "mcp__plugin_mnemio_mnemio__list_goals", {}), toolResult("t1"), toolUse("t2", "Read", { file_path: "/x/a.pdf" })]);
  await run({ env, request, spawnFn: claude.spawnFn, once: true, signIn: async () => "ok" });
  const failure = sent.find(s => s.path.endsWith("/reply")).body;
  assert.equal(failure.failed, true);
  assert.deepEqual(failure.steps, [{ step: "t2", state: "failed" }], "the cut-off step is failed; the finished one was already confirmed");
});

test("a workspace that is a link isn't cleared through it", async t => {
  const env = await home(t);
  const fs = require("node:fs");
  const elsewhere = join(env.MNEMIO_CONFIG_DIR, "elsewhere");
  fs.mkdirSync(join(elsewhere, "inbox"), { recursive: true });
  fs.writeFileSync(join(elsewhere, "inbox", "keep.txt"), "keep");
  fs.mkdirSync(listenerDir(env), { recursive: true });
  fs.symlinkSync(elsewhere, workDir(env));
  const { request } = recorder();
  await answerOne(message("7d0c8a5e-0000-4000-8000-0000000000eb", "Hi"), { env, request, spawnFn: fakeClaude(() => success("Hello.")).spawnFn });
  assert.ok(fs.existsSync(join(elsewhere, "inbox", "keep.txt")));
});

test("where the company manages Claude Code's MCP servers, the listener takes no message it couldn't answer safely", async t => {
  const env = await home(t);
  const managed = join(env.MNEMIO_CONFIG_DIR, "managed-mcp.json");
  require("node:fs").writeFileSync(managed, "{}");
  const request = async () => assert.fail("no message is collected");
  const state = await run({ env, request, once: true, signIn: async () => "ok", managedPaths: [managed] });
  assert.match(state.lastError, /company manages Claude Code's MCP servers/);
});

test("a first attempt's unfinished steps end as failed even when the retry answers", async t => {
  const env = await home(t);
  const { calls, request } = recorder();
  require("node:fs").mkdirSync(listenerDir(env), { recursive: true });
  require("node:fs").writeFileSync(join(listenerDir(env), "sessions.json"), JSON.stringify({ "web:c1": "old" }));
  const claude = fakeClaude(args => args.includes("--resume")
    ? [toolUse("t1", "mcp__plugin_mnemio_mnemio__list_goals", {})]
    : [toolUse("", "Read", {}), success("Done.")]);
  // Step reports go through first, then the answer: t1's end was never reported.
  await answerOne(message("7d0c8a5e-0000-4000-8000-0000000000ec", "Hi"), { env, request, spawnFn: claude.spawnFn });
  const answer = calls.find(c => c.path.endsWith("/reply")).body;
  assert.deepEqual(answer.steps, [{ step: "t1", state: "failed" }]);
  assert.ok(!calls.some(c => c.path.endsWith("/progress") && c.body.step === ""), "a step without an id isn't reported");
});

test("signed out of Claude Code: the person is told so, and the listener collects nothing until they sign in again", async t => {
  const env = await home(t);
  const sent = [];
  let polls = 0;
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) {
      polls++;
      return Response.json(message("7d0c8a5e-0000-4000-8000-0000000000f1", "Hi"));
    }
    sent.push(JSON.parse(opts.body));
    return Response.json({ delivered: "reply" });
  };
  const broken = fakeClaude(() => ({ type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · Please run /login" }));
  let signedIn = "ok";
  const signIn = async () => signedIn;
  // It says "ok" at the start; the answer fails for want of a sign-in, and the check then says so.
  const first = run({ env, request, spawnFn: broken.spawnFn, once: true, signIn: async () => { const s = signedIn; signedIn = "signed_out"; return s; } });
  const state = await first;
  assert.equal(state.claude, "signed_out");
  assert.match(sent[0].text, /signed out on .+ Open Claude Code there and sign in again/);
  assert.equal(sent[0].failed, true);
  // Still signed out, even after a restart: nothing is collected (the message would only fail), and Claude isn't
  // tried again yet.
  let probes = 0;
  const probe = async () => { probes++; return "signed_out"; };
  const idle = await run({ env, request, once: true, signIn, probe });
  assert.equal(polls, 1);
  assert.equal(probes, 0);
  assert.match(idle.lastError, /signed out/);
  // Ten minutes on, Claude itself is tried, since `auth status` can be wrong: it answers, so collecting starts again.
  const stateFile = join(listenerDir(env), "state.json");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(stateFile, JSON.stringify({ ...saved, signedOutAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
  const working = fakeClaude(() => ({ type: "result", subtype: "success", is_error: false, result: "Hello" }));
  const back = await run({ env, request, spawnFn: working.spawnFn, once: true, signIn, probe: async () => { probes++; return "ok"; } });
  assert.equal(probes, 1);
  assert.equal(back.claude, "ok");
  assert.equal(polls, 2);
  // An error that isn't about signing in is passed on as it is.
  signedIn = "ok";
  const other = fakeClaude(() => ({ type: "result", subtype: "error_max_turns", is_error: true, result: "Too many turns" }));
  await run({ env, request, spawnFn: other.spawnFn, once: true, signIn });
  assert.match(sent.at(-1).text, /couldn't answer this: Too many turns/);
});

test("claude auth status: signed in, signed out (even with a failing exit), or unknown on an older Claude Code", async () => {
  const settings = { claude: "/bin/claude", env: {} };
  const reply = (err, stdout) => ({ execFn: (bin, args, opts, cb) => { assert.deepEqual(args, ["auth", "status", "--json"]); cb(err, stdout); } });
  assert.equal(await claudeSignIn(settings, reply(null, JSON.stringify({ loggedIn: true, email: "a@b.c" }))), "ok");
  assert.equal(await claudeSignIn(settings, reply(Object.assign(new Error("exit 1"), { code: 1 }), JSON.stringify({ loggedIn: false }))), "signed_out");
  assert.equal(await claudeSignIn(settings, reply(new Error("unknown command 'auth'"), "")), "unknown");
});

test("the heartbeat goes out on its own, while an answer is still being worked on, and says how the listener is", async t => {
  const env = await home(t);
  const beats = [];
  const request = async (url, opts) => {
    assert.equal(url.pathname, "/api/claude/listener/heartbeat");
    beats.push(JSON.parse(opts.body));
    return Response.json({ ok: true, every: 30 });
  };
  const state = { claude: "ok", busy: true, lastError: null };
  const stop = startHeartbeat(state, { env, request, every: 20, version: "9.9.9" });
  await new Promise(r => setTimeout(r, 70));
  stop();
  assert.ok(beats.length >= 3, `beats: ${beats.length}`);
  assert.deepEqual(beats[0], { version: "9.9.9", claude: "ok", busy: true, error: null });
  const n = beats.length;
  await new Promise(r => setTimeout(r, 40));
  assert.equal(beats.length, n, "stopped");
  // The local status goes by the heartbeat too: busy for minutes, still running.
  assert.deepEqual([status({ env }).running, status({ env }).busy], [true, true]);
});

test("setting the listener up is reported to Mnemio, and a failure says what went wrong", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    sent.push({ path: url.pathname, body: JSON.parse(opts.body) });
    return Response.json({ ok: true });
  };
  assert.equal(await reportSetup("installed", undefined, { env, request }), true);
  await reportSetup("failed", "Couldn't find the claude command.", { env, request });
  assert.deepEqual(sent, [{ path: "/api/claude/listener/setup", body: { install: "installed" } }, { path: "/api/claude/listener/setup", body: { install: "failed", error: "Couldn't find the claude command." } }]);
  assert.equal(await reportSetup("off", undefined, { env, request: async () => { throw new Error("offline"); } }), false, "says when Mnemio didn't get it");
});

/** A fake Claude Desktop folder with these versions of its Claude Code (each in a build folder). */
async function desktopHome(t, versions) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-desktop-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const v of versions) {
    const bin = join(dir, "Library/Application Support/Claude/claude-code", v, "b0", "claude.app/Contents/MacOS");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    await chmod(join(bin, "claude"), 0o755);
  }
  return dir;
}

test("on a Mac with only Claude Desktop, the listener uses Desktop's Claude Code, the newest one", async t => {
  const home = await desktopHome(t, ["2.1.9", "2.1.325", "2.1.40"]);
  const bin = desktopClaude({ home, platform: "darwin" });
  assert.match(bin, /claude-code\/2\.1\.325\/b0\/claude\.app\/Contents\/MacOS\/claude$/);
  assert.equal(desktopClaude({ home, platform: "linux" }), null);
  assert.equal(desktopClaude({ home: join(home, "nowhere"), platform: "darwin" }), null);
});

test("when Claude Desktop updates and the saved Claude Code is gone, the listener finds the new one", async t => {
  const env = await home(t);
  delete env.MNEMIO_CLAUDE_BIN;
  await mkdir(listenerDir(env), { recursive: true });
  const gone = "/Users/asha/Library/Application Support/Claude/claude-code/2.1.9/b0/claude.app/Contents/MacOS/claude";
  await writeFile(join(listenerDir(env), "listener.json"), JSON.stringify({ claude: gone, path: "/usr/bin" }));
  assert.equal(listenerSettings(env, { desktop: () => "/new/claude" }).claude, "/new/claude");
  // A command chosen on purpose (a wrapper with its own settings, say) that went away isn't swapped for Desktop's.
  await writeFile(join(listenerDir(env), "listener.json"), JSON.stringify({ claude: "/opt/acme/claude-wrapper" }));
  assert.equal(listenerSettings(env, { desktop: () => "/new/claude" }).claude, "/opt/acme/claude-wrapper");
  // Still there (or a bare command name): kept as it is.
  await writeFile(join(listenerDir(env), "listener.json"), JSON.stringify({ claude: process.execPath }));
  assert.equal(listenerSettings(env, { desktop: () => "/new/claude" }).claude, process.execPath);
  await writeFile(join(listenerDir(env), "listener.json"), JSON.stringify({ claude: "claude" }));
  assert.equal(listenerSettings(env, { desktop: () => "/new/claude" }).claude, "claude");
});

test("check says what /mnemio:connect needs to know before offering the listener", async t => {
  const env = await home(t);
  const seen = [];
  const signIn = async s => { seen.push(s.claude); assert.equal(s.env.ANTHROPIC_API_KEY, undefined, "checked as the service will run, without the shell's key"); return "signed_out"; };
  const r = await check({ env: { ...env, ANTHROPIC_API_KEY: "sk-shell-only" }, platform: "darwin", node: "22.3.0", desktop: () => null, signIn });
  assert.deepEqual({ ...r, listener: undefined }, { supported: true, node: "22.3.0", nodeOk: true, claude: "/usr/local/bin/claude", claudeFrom: "claude-code", signedIn: "signed_out", listener: undefined });
  assert.deepEqual(seen, ["/usr/local/bin/claude"]);
  assert.equal(typeof r.listener.installed, "boolean");
  const old = await check({ env, platform: "win32", node: "20.11.1", desktop: () => null, signIn });
  assert.equal(old.supported, false);
  assert.equal(old.nodeOk, false);
  // Claude Desktop's own Claude Code is said to be that.
  const desk = await check({ env: { ...env, MNEMIO_CLAUDE_BIN: "/d/claude" }, platform: "darwin", desktop: () => "/d/claude", signIn: async () => "ok" });
  assert.equal(desk.claudeFrom, "claude-desktop");
});

test("claude auth status alone saying signed out never stops a listener: it can be wrong while Claude answers", async t => {
  const env = await home(t);
  let polls = 0;
  const request = async (url) => {
    if (url.pathname.endsWith("/next")) { polls++; return new Response(null, { status: 204 }); }
    return Response.json({ ok: true });
  };
  const state = await run({ env, request, once: true, signIn: async () => "signed_out", probe: async () => assert.fail("not probed") });
  assert.equal(polls, 1, "it still collects");
  assert.equal(state.claude, "unknown");
});

test("the probe asks Claude itself, and tells a missing sign-in from other trouble", async t => {
  const env = await home(t);
  const answers = [[null, "OK", ""], [Object.assign(new Error("exit 1"), { code: 1 }), "", "Invalid API key · Please run /login"], [Object.assign(new Error("exit 1"), { code: 1 }), "", "network down"]];
  const seen = [];
  const execFn = (bin, args, opts, cb) => { seen.push({ bin, args, cwd: opts.cwd, listener: opts.env.MNEMIO_LISTENER }); const [e, out, err] = answers.shift(); cb(e, out, err); };
  const settings = { claude: "/usr/local/bin/claude", env: { PATH: "/usr/bin" } };
  assert.equal(await claudeProbe(settings, { cwd: workDir(env), execFn }), "ok");
  assert.equal(await claudeProbe(settings, { cwd: workDir(env), execFn }), "signed_out");
  assert.equal(await claudeProbe(settings, { cwd: workDir(env), execFn }), "unknown");
  assert.deepEqual(seen[0], { bin: "/usr/local/bin/claude", args: ["-p", "Reply with just OK.", "--max-turns", "1"], cwd: workDir(env), listener: "1" });
});
