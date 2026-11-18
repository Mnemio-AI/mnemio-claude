import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../scripts/brain.mjs";

const env = { MNEMIO_TOKEN: "test-token", MNEMIO_URL: "https://brain.example" };

test("writes only the selected note and sends authorization to the configured origin", async () => {
  const result = await run("save", "Use staging first.", env, async (url, options) => {
    assert.equal(url.href, "https://brain.example/api/claude/memory");
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { text: "Use staging first." });
    return Response.json({ saved: true });
  });
  assert.deepEqual(result, { saved: true });
});

test("startup sends nothing by default and supplies only a catalog when enabled", async () => {
  assert.equal(await run("session-start", "", {}, assert.fail), undefined);
  const result = await run("session-start", "", { ...env, MNEMIO_LOAD_SKILLS: "1" }, async (url, options) => {
    assert.equal(url.pathname, "/api/claude/skills");
    assert.equal(options.body, undefined);
    return Response.json({ skills: ["onboarding"] });
  });
  assert.match(result.hookSpecificOutput.additionalContext, /onboarding/);
});

test("rejects insecure remote origins and reports revoked tokens", async () => {
  await assert.rejects(run("skills", "", { ...env, MNEMIO_URL: "http://brain.example" }, assert.fail), /HTTPS/);
  await assert.rejects(run("skills", "", env, () => Response.json({ error: "Revoked" }, { status: 401 })), /401: Revoked/);
});

test("runs Mnemio's tools without MCP: list them, then call one with JSON input", async () => {
  const sent = [];
  const request = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push({ path: url.pathname, accept: opts.headers.accept, body });
    return Response.json({ jsonrpc: "2.0", id: 1, result: body.method === "tools/list"
      ? { tools: [{ name: "list_goals", description: "Goals", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "No goals yet." }] } });
  };
  assert.deepEqual(await run("tools", "", env, request), { tools: [{ name: "list_goals", description: "Goals", input: { type: "object" } }] });
  assert.deepEqual(await run("tool", '{"include_finished":true}', env, request, "list_goals"), { content: [{ type: "text", text: "No goals yet." }] });
  assert.deepEqual(sent.map(s => [s.path, s.body.method, s.body.params]), [["/api/claude/mcp", "tools/list", undefined], ["/api/claude/mcp", "tools/call", { name: "list_goals", arguments: { include_finished: true } }]]);
  assert.equal(sent[0].accept, "application/json, text/event-stream");
  await assert.rejects(run("tool", "not json", env, request, "list_goals"), /JSON/);
  await assert.rejects(run("tool", "", env, async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "Unknown tool" } }), "nope"), /Unknown tool/);
});
