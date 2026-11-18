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
