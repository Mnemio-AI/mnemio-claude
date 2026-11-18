import test from "node:test";
import assert from "node:assert/strict";
import { createChannel, eventFor } from "../scripts/channel.mjs";
import { run } from "../scripts/brain.mjs";

const env = { MNEMIO_TOKEN: "test-token", MNEMIO_URL: "https://brain.example", MNEMIO_CHANNEL: "1" };
const message = { id: "7d0c8a5e-0000-4000-8000-000000000001", platform: "slack", sender: "Asha", text: "And tomorrow?", context: [{ message: "Today?", answer: "Standup at 10." }] };

function harness(t, channelEnv, request) {
  const sent = [];
  const channel = createChannel({ env: channelEnv, request, send: m => sent.push(m), sleep: () => new Promise(r => setTimeout(r, 5)) });
  t.after(() => channel.close());
  return { sent, channel };
}

test("declares itself a Claude Code channel and offers the reply tool only when switched on", async t => {
  const off = harness(t, { ...env, MNEMIO_CHANNEL: "" }, assert.fail);
  await off.channel.onMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.deepEqual(off.sent[0].result.capabilities.experimental, { "claude/channel": {} });
  await off.channel.onMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  await off.channel.onMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(off.sent[1].result.tools, [], "an ordinary session never collects messages");

  const on = harness(t, env, async () => new Response(null, { status: 204 }));
  await on.channel.onMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(on.sent[0].result.tools[0].name, "reply");
  assert.deepEqual(on.sent[0].result.tools[0].inputSchema.required, ["chat_id", "text"]);
});

test("pushes each collected message into the session with its conversation, and sends the reply back", async t => {
  const calls = [];
  let served = false;
  const { sent, channel } = harness(t, env, async (url, opts) => {
    calls.push({ path: url.pathname + url.search, auth: opts.headers.authorization, body: opts.body && JSON.parse(opts.body) });
    if (url.pathname === "/api/claude/inbox/next") {
      if (served) return new Response(null, { status: 204 });
      served = true;
      return Response.json(message);
    }
    return Response.json({ delivered: "reply" });
  });
  await channel.onMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  while (!sent.length) await new Promise(r => setTimeout(r, 5));
  assert.equal(sent[0].method, "notifications/claude/channel");
  assert.deepEqual(sent[0].params.meta, { chat_id: message.id, platform: "slack", sender: "Asha" });
  assert.match(sent[0].params.content, /Earlier in this conversation:\n- Asha: Today\?\n- You: Standup at 10\.\n\nAsha wrote in Slack:\nAnd tomorrow\?/);
  assert.equal(calls[0].path, "/api/claude/inbox/next?wait=25");
  assert.equal(calls[0].auth, "Bearer test-token");

  await channel.onMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "reply", arguments: { chat_id: message.id, text: " Planning at 2. " } } });
  const answer = sent.find(m => m.id === 9);
  assert.deepEqual(answer.result.content, [{ type: "text", text: "Answer sent." }]);
  assert.deepEqual(calls.find(c => c.path.endsWith("/reply")), { path: `/api/claude/inbox/${message.id}/reply`, auth: "Bearer test-token", body: { text: "Planning at 2." } });
});

test("event meta keys are identifiers, as Claude Code requires", () => {
  for (const key of Object.keys(eventFor(message).params.meta)) assert.match(key, /^[A-Za-z0-9_]+$/);
});

test("a cloud run collects and answers with the token the proxy adds, never one from its environment", async () => {
  const cloud = { CLAUDE_CODE_REMOTE: "true", MNEMIO_URL: "https://brain.example" };
  const seen = [];
  const request = async (url, opts) => {
    seen.push({ path: url.pathname, auth: opts.headers.authorization, body: JSON.parse(opts.body) });
    return Response.json(url.pathname.endsWith("/claim") ? { messages: [message] } : { delivered: "reply" });
  };
  assert.deepEqual(await run("inbox", "", cloud, request), { messages: [{ ...message, files: [] }] }, "each message lists where its files were saved (none here)");
  await run("reply", "Planning at 2.", cloud, request, message.id);
  assert.deepEqual(seen, [
    { path: "/api/claude/inbox/claim", auth: undefined, body: { limit: 10 } },
    { path: `/api/claude/inbox/${message.id}/reply`, auth: undefined, body: { text: "Planning at 2." } }
  ]);
  await assert.rejects(run("inbox", "", { CLAUDE_CODE_REMOTE: "true" }, request), /MNEMIO_URL/);
  await assert.rejects(run("reply", "x", cloud, request, "../skills"), /message id/);
  await assert.rejects(run("inbox", "", { MNEMIO_URL: "https://brain.example", MNEMIO_CONFIG_DIR: "/nonexistent-mnemio" }, request), /mnemio:connect/, "locally a sign-in is required");
});
