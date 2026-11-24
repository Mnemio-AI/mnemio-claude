import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerOne, claudeArgs, failureOf, install, run, runClaude, saveSession, workDir } from "../scripts/listener.mjs";
import { MnemioMcp } from "../scripts/lib/mcp-client.mjs";
import { run as command } from "../scripts/lib/commands.mjs";
import { handle } from "../scripts/hooks.mjs";
import { readCredentials } from "../scripts/lib/credentials.mjs";

async function home(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-listen-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { MNEMIO_CONFIG_DIR: dir, MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_CLAUDE_BIN: "/usr/local/bin/claude" };
}

/** A fake `claude -p`: records what it was given and answers with `reply(args)` (after `delay(input)` ms). */
function fakeClaude(reply, delay = () => 0) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = "";
    child.stdin = { end: text => {
      input = text;
      calls.push({ bin, args, cwd: opts.cwd, input, channel: opts.env.MNEMIO_CHANNEL, listener: opts.env.MNEMIO_LISTENER, answering: opts.env.MNEMIO_ANSWERING });
      const r = reply(args, input, opts);
      setTimeout(() => {
        child.stdout.emit("data", JSON.stringify(r));
        child.emit("close", 0);
      }, delay(input));
    } };
    child.kill = () => {};
    return child;
  };
  return { calls, spawnFn };
}

const message = (id, text, conversation = "web:c1") => ({ id, conversation, platform: "web", sender: "Asha", text, context: [], memories: ["Asha ships on Fridays."], attachments: [] });

test("claude runs with only Mnemio's tools, skills and reading its own folder", () => {
  assert.deepEqual(claudeArgs({ dir: "/w", sessionId: "s1", mcpConfig: "/c/m.json" }), ["-p", "--output-format", "json", "--resume", "s1", "--mcp-config", "/c/m.json", "--strict-mcp-config", "--tools", "Read,Write,Skill", "--setting-sources", "project,local", "--permission-mode", "default", "--allowedTools", "mcp__mnemio", "Skill", "Read(./**)"], "nothing of their own Claude Code profile: no shell, no other MCP servers");
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
  assert.ok(first.cwd.startsWith(join(workDir(env), "c") + "/"), "a folder of this conversation's own");
  assert.equal(first.channel, "", "never collects messages itself");
  assert.equal(first.listener, "1", "the plugin's hooks know it's the listener");
  assert.equal(first.answering, "7d0c8a5e-0000-4000-8000-000000000001", "Mnemio is told which chat its tools are called for");
  assert.match(first.input, /What Mnemio remembers[\s\S]*Asha ships on Fridays[\s\S]*Asha wrote in the Mnemio web app:\nHow do we release\?[\s\S]*Your final message is sent to them as your reply/);
  assert.ok(!first.args.includes("--resume"));
  assert.deepEqual(sent[0], { path: "/api/claude/inbox/7d0c8a5e-0000-4000-8000-000000000001/reply", body: { text: "Answer 1" } });

  await answerOne(message("7d0c8a5e-0000-4000-8000-000000000002", "And tomorrow?"), { env, request, spawnFn: claude.spawnFn });
  assert.deepEqual(claude.calls[1].args.slice(3, 5), ["--resume", "sess-A"], "the same conversation continues its Claude session");

  // A session that's gone: a fresh one, not an error.
  // (An older listener saved just the session id.)
  await (await import("node:fs/promises")).writeFile(join(env.MNEMIO_CONFIG_DIR, "listener/sessions.json"), JSON.stringify({ "web:c2": "gone" }));
  assert.equal(await answerOne(message("7d0c8a5e-0000-4000-8000-000000000003", "Hi", "web:c2"), { env, request, spawnFn: claude.spawnFn }), "Answer 3");
});

test("the loop tells the person when their Claude couldn't answer, and waits for a sign-in when there's none", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) return Response.json(message("7d0c8a5e-0000-4000-8000-000000000004", "Hi"));
    sent.push({ path: url.pathname, body: JSON.parse(opts.body) });
    return Response.json({ delivered: "reply" });
  };
  const broken = fakeClaude(() => ({ type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · Please run /login" }));
  const state = await run({ env, request, spawnFn: broken.spawnFn, once: true });
  const replied = () => sent.filter(x => !x.path.endsWith("/health"));
  assert.deepEqual(replied().map(x => x.path), ["/api/claude/inbox/7d0c8a5e-0000-4000-8000-000000000004/release"], "signed out: handed back for when they sign in again");
  assert.deepEqual(replied()[0].body, { retry_in: 1800, notice: "Claude Code on this computer is signed out: run claude there and sign in with /login." }, "and they're told why it's late");
  assert.match(state.lastError, /signed out/);
  assert.deepEqual(sent.filter(x => x.path.endsWith("/health")).at(-1)?.body, { error: state.lastError }, "and Mnemio shows it in Settings");
  const odd = fakeClaude(() => ({ type: "result", subtype: "error_during_execution", is_error: true, result: "Something odd" }));
  sent.length = 0;
  await run({ env, request, spawnFn: odd.spawnFn, once: true });
  assert.match(replied()[0].body.text, /couldn't answer this: Something odd/);

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

test("a usage limit or a passing failure hands the message back; when Mnemio won't take it back, they're told", async t => {
  const env = await home(t);
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 3600;
  assert.deepEqual(failureOf(new Error(`Claude AI usage limit reached|${reset}`), now).kind, "limit");
  assert.ok(Math.abs(failureOf(new Error(`Claude AI usage limit reached|${reset}`), now).retryIn - 3660) <= 1, "until it resets");
  assert.equal(failureOf(new Error("5-hour limit reached ∙ resets 3pm"), now).retryIn, 900);
  assert.equal(failureOf(new Error("API Error: 529 Overloaded")).kind, "passing");
  // What Claude Code 2.1 actually says for a bad token (its JSON also gives api_error_status 401).
  assert.equal(failureOf(Object.assign(new Error("Failed to authenticate. API Error: 401 OAuth access token is invalid."), { status: 401, type: "authentication_error" })).kind, "signedOut");
  assert.equal(failureOf(new Error("Failed to authenticate. API Error: 401 OAuth access token is invalid.")).kind, "signedOut", "even from the text alone");
  assert.equal(failureOf(Object.assign(new Error("API Error"), { status: 429, type: "rate_limit_error" })).kind, "limit");
  assert.equal(failureOf(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })).kind, "signedOut");
  assert.equal(failureOf(new Error("Claude took too long to answer.")).kind, "fatal");

  const sent = [];
  let refuse = false;
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) return Response.json({ ...message("7d0c8a5e-0000-4000-8000-000000000005", "Hi"), attempt: 2 });
    sent.push({ path: url.pathname.split("/").pop(), body: JSON.parse(opts.body) });
    if (refuse && url.pathname.endsWith("/release")) return Response.json({ error: "handed back too often" }, { status: 409 });
    return Response.json({ ok: true });
  };
  const busy = fakeClaude(() => ({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 Overloaded" }));
  await run({ env, request, spawnFn: busy.spawnFn, once: true });
  assert.deepEqual(sent.filter(x => x.path !== "health"), [{ path: "release", body: { retry_in: 120 } }], "second try: twice the wait, and no reply yet");
  sent.length = 0;
  refuse = true;
  await run({ env, request, spawnFn: busy.spawnFn, once: true });
  assert.deepEqual(sent.filter(x => x.path !== "health").map(x => x.path), ["release", "reply"]);
  assert.match(sent.find(x => x.path === "reply").body.text, /couldn't answer this: API Error: 529/);
});

test("answers different conversations at the same time, and one conversation in order", async t => {
  const env = await home(t);
  const queue = [message("7d0c8a5e-0000-4000-8000-00000000000a", "A1", "web:a"), message("7d0c8a5e-0000-4000-8000-00000000000b", "A2", "web:a"), message("7d0c8a5e-0000-4000-8000-00000000000c", "B1", "web:b")];
  const log = [];
  let polls = 0;
  const request = async (url, opts) => {
    if (url.pathname.endsWith("/next")) {
      if (++polls > 6) throw new Error("stop");
      return queue.length ? Response.json(queue.shift()) : new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/reply")) log.push(`done ${JSON.parse(opts.body).text}`);
    return Response.json({ delivered: "reply" });
  };
  const claude = fakeClaude((args, input) => {
    const text = /wrote in the Mnemio web app:\n(\w+)/.exec(input)[1];
    log.push(`start ${text}`);
    return { type: "result", subtype: "success", is_error: false, result: text, session_id: "s-" + text };
  }, input => (input.includes("A1") ? 60 : 5));
  let stops = 0;
  await run({ env, request, spawnFn: claude.spawnFn, sleep: async () => { if (++stops > 1) throw new Error("done"); }, parallel: 3 }).catch(() => {});
  await new Promise(r => setTimeout(r, 150));
  assert.ok(log.indexOf("start B1") < log.indexOf("done A1"), "B doesn't wait for A");
  assert.ok(log.indexOf("done A1") < log.indexOf("start A2"), "A2 waits for A1");
});

test("conversation sessions are forgotten after 30 days, newest kept", async t => {
  const env = await home(t);
  const day = 86_400_000;
  const now = Date.now();
  saveSession(env, "old", "s-old", now - 40 * day);
  saveSession(env, "recent", "s-recent", now - day);
  saveSession(env, "new", "s-new", now);
  const saved = JSON.parse(await readFile(join(env.MNEMIO_CONFIG_DIR, "listener/sessions.json"), "utf8"));
  assert.deepEqual(Object.keys(saved), ["new", "recent"]);
});

test("the tool server tells Mnemio which chat the listener is answering", async () => {
  const seen = [];
  const request = async (url, opts) => {
    seen.push(opts.headers["x-mnemio-answering"]);
    return Response.json({ jsonrpc: "2.0", id: JSON.parse(opts.body).id ?? 0, result: { tools: [] } });
  };
  await new MnemioMcp("/api/claude/mcp", { env: { MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_ANSWERING: "7d0c8a5e-0000-4000-8000-000000000001" }, request }).tools();
  await new MnemioMcp("/api/claude/mcp", { env: { MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_ANSWERING: "" }, request }).tools();
  assert.ok(seen.slice(0, 3).every(h => h === "7d0c8a5e-0000-4000-8000-000000000001"));
  assert.ok(seen.slice(3).every(h => h === undefined), "ordinary sessions don't send it");
});

test("files Claude saves in the message's outbox go with its reply; it may write nowhere else", async t => {
  const env = await home(t);
  const sent = [];
  const request = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return Response.json({ delivered: "reply" });
  };
  const id = "7d0c8a5e-0000-4000-8000-0000000000f1";
  const claude = fakeClaude((args, input, opts) => {
    assert.ok(args.includes(`Write(./outbox/${id}/**)`), "writing only in this message's outbox");
    assert.match(input, new RegExp(`save it in .*outbox/${id}/`));
    mkdirSync(join(opts.cwd, "outbox", id), { recursive: true });
    writeFileSync(join(opts.cwd, "outbox", id, "report.csv"), "a,b\n1,2\n");
    return { type: "result", subtype: "success", is_error: false, result: "Report attached.", session_id: "s-f" };
  });
  await answerOne(message(id, "Make me a report"), { env, request, spawnFn: claude.spawnFn });
  assert.deepEqual(sent[0], { text: "Report attached.", files: [{ name: "report.csv", data: Buffer.from("a,b\n1,2\n").toString("base64") }] });
});

test("a session started to listen (channel mode) has its changing calls held too", async () => {
  const seen = [];
  const request = async (url, opts) => {
    seen.push(opts.headers["x-mnemio-answering"]);
    return Response.json({ jsonrpc: "2.0", id: JSON.parse(opts.body).id ?? 0, result: { tools: [] } });
  };
  await new MnemioMcp("/api/claude/mcp", { env: { MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_CHANNEL: "1" }, request }).tools();
  assert.ok(seen.length && seen.every(h => h === "channel"));
});

test("a cloud run's tool calls say which message they're for", async () => {
  const headers = [];
  const request = async (url, opts) => {
    headers.push(opts.headers["x-mnemio-answering"]);
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  };
  const env = { MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t" };
  await command("tool", "{}", env, request, "list_goals", [], "7d0c8a5e-0000-4000-8000-000000000009");
  await command("tool", "{}", env, request, "list_goals");
  assert.deepEqual(headers, ["7d0c8a5e-0000-4000-8000-000000000009", undefined]);
  await assert.rejects(command("tool", "{}", env, request, "list_goals", [], "not-an-id"), /--for takes the id/);
});

test("on Windows, a sign-in task keeps the listener running (dry run: nothing scheduled)", async t => {
  const env = { ...(await home(t)), MNEMIO_LISTENER_DRY_RUN: "1" };
  const r = install({ env, platform: "win32", exec: () => assert.fail("dry run must not touch the system") });
  const script = await readFile(r.service, "utf8");
  assert.match(script, /:loop\r\n.*launch\.mjs.*listener\.log.*\r\ntimeout \/t 30/);
  assert.match(script, /set "MNEMIO_CONFIG_DIR=/);
  assert.deepEqual(r.task.slice(0, 5), ["/Create", "/F", "/SC", "ONLOGON", "/RL"]);
});

test("each conversation answers in its own folder, with the company skills as its own", async t => {
  const env = await home(t);
  const skills = join(env.MNEMIO_CONFIG_DIR, "claude", "skills");
  mkdirSync(join(skills, "mnemio-release"), { recursive: true });
  writeFileSync(join(skills, "mnemio-release", "SKILL.md"), "---\nname: mnemio-release\n---\nShip.");
  mkdirSync(join(skills, "my-own"), { recursive: true });
  const cfg = { ...env, CLAUDE_CONFIG_DIR: join(env.MNEMIO_CONFIG_DIR, "claude") };
  const request = async () => Response.json({ delivered: "reply" });
  const claude = fakeClaude((args, input, opts) => {
    assert.deepEqual(readdirSync(join(opts.cwd, ".claude", "skills")), ["mnemio-release"], "company skills only, not their own");
    return { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" };
  });
  await answerOne(message("7d0c8a5e-0000-4000-8000-0000000000a1", "A", "web:a"), { env: cfg, request, spawnFn: claude.spawnFn });
  await answerOne(message("7d0c8a5e-0000-4000-8000-0000000000b1", "B", "web:b"), { env: cfg, request, spawnFn: claude.spawnFn });
  assert.notEqual(claude.calls[0].cwd, claude.calls[1].cwd);
});
