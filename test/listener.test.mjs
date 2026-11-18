import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerOne, claudeArgs, install, run, runClaude, workDir } from "../scripts/listener.mjs";
import { handle } from "../scripts/hooks.mjs";
import { readCredentials } from "../scripts/lib/credentials.mjs";

async function home(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-listen-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { MNEMIO_CONFIG_DIR: dir, MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_CLAUDE_BIN: "/usr/local/bin/claude" };
}

/** A fake `claude -p`: records what it was given and answers with `reply(args)`. */
function fakeClaude(reply) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = "";
    child.stdin = { end: text => {
      input = text;
      calls.push({ bin, args, cwd: opts.cwd, input, channel: opts.env.MNEMIO_CHANNEL });
      const r = reply(args, input);
      setImmediate(() => {
        child.stdout.emit("data", JSON.stringify(r));
        child.emit("close", 0);
      });
    } };
    child.kill = () => {};
    return child;
  };
  return { calls, spawnFn };
}

const message = (id, text, conversation = "web:c1") => ({ id, conversation, platform: "web", sender: "Asha", text, context: [], memories: ["Asha ships on Fridays."], attachments: [] });

test("claude runs with only Mnemio's tools, skills and reading its own folder", () => {
  assert.deepEqual(claudeArgs({ dir: "/w", sessionId: "s1" }), ["-p", "--output-format", "json", "--resume", "s1", "--allowedTools", "mcp__plugin_mnemio_mnemio", "Skill", "Read(/w/**)"]);
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
  assert.match(first.input, /What Mnemio remembers[\s\S]*Asha ships on Fridays[\s\S]*Asha wrote in the Mnemio web app:\nHow do we release\?[\s\S]*Your final message is sent to them as your reply/);
  assert.ok(!first.args.includes("--resume"));
  assert.deepEqual(sent[0], { path: "/api/claude/inbox/7d0c8a5e-0000-4000-8000-000000000001/reply", body: { text: "Answer 1" } });

  await answerOne(message("7d0c8a5e-0000-4000-8000-000000000002", "And tomorrow?"), { env, request, spawnFn: claude.spawnFn });
  assert.deepEqual(claude.calls[1].args.slice(3, 5), ["--resume", "sess-A"], "the same conversation continues its Claude session");

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
