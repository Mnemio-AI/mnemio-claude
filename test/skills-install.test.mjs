import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills, removeSkills, renameSkill } from "../scripts/lib/skills-install.mjs";
import { handle } from "../scripts/hooks.mjs";

async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mnemio-skills-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { MNEMIO_URL: "https://acme.mnemio.ai", MNEMIO_TOKEN: "mnemio_cc_t", MNEMIO_CONFIG_DIR: join(dir, "config"), MNEMIO_SKILLS_DIR: join(dir, "skills") };
  let bundle = { hash: "h1", skills: [
    { name: "release", hash: "a", files: { "SKILL.md": "---\nname: release\ndescription: How we ship\n---\nBuild, then tag.", "references/checklist.md": "- tests" } },
    { name: "onboarding", hash: "b", files: { "SKILL.md": "---\ndescription: First week\n---\nSay hello." } }
  ] };
  const asked = [];
  const request = async url => {
    asked.push(url.pathname + url.search);
    if (url.pathname === "/api/claude/config") return Response.json({ workspace: "Acme", prefs: { loadSkills: true } });
    return Response.json(url.searchParams.get("have") === bundle.hash ? { hash: bundle.hash, unchanged: true } : bundle);
  };
  return { dir, env, request, asked, setBundle: b => { bundle = b; } };
}

test("the frontmatter names the skill mnemio-<name>, whatever it said", () => {
  assert.equal(renameSkill("---\nname: release\ndescription: x\n---\nBody", "mnemio-release"), "---\nname: mnemio-release\ndescription: x\n---\nBody");
  assert.equal(renameSkill("---\ndescription: x\n---\nBody", "mnemio-a"), "---\nname: mnemio-a\ndescription: x\n---\nBody");
  assert.equal(renameSkill("No frontmatter", "mnemio-a"), "---\nname: mnemio-a\n---\nNo frontmatter");
});

test("installs company skills as Claude Code skills, updates them, and leaves the person's own folders alone", async t => {
  const { dir, env, request, asked, setBundle } = await setup(t);
  await mkdir(join(dir, "skills/mnemio-onboarding"), { recursive: true });
  await writeFile(join(dir, "skills/mnemio-onboarding/SKILL.md"), "my own skill");
  await mkdir(join(dir, "skills/my-notes"));

  assert.deepEqual(await installSkills({ env, request }), { installed: 1, removed: 0, skipped: 1 }, "a same-named folder they made isn't overwritten");
  assert.equal(await readFile(join(dir, "skills/mnemio-release/SKILL.md"), "utf8"), "---\nname: mnemio-release\ndescription: How we ship\n---\nBuild, then tag.");
  assert.equal(await readFile(join(dir, "skills/mnemio-release/references/checklist.md"), "utf8"), "- tests");
  assert.equal(await readFile(join(dir, "skills/mnemio-onboarding/SKILL.md"), "utf8"), "my own skill");

  assert.deepEqual(await installSkills({ env, request }), { unchanged: true, installed: 1 }, "nothing downloaded when nothing changed");
  assert.match(asked.at(-1), /have=h1/);

  setBundle({ hash: "h2", skills: [{ name: "pricing", hash: "c", files: { "SKILL.md": "---\nname: pricing\n---\nAsk sales." } }] });
  assert.deepEqual(await installSkills({ env, request }), { installed: 1, removed: 1, skipped: 0 });
  assert.ok(!existsSync(join(dir, "skills/mnemio-release")), "a skill removed in Mnemio leaves Claude too");
  assert.deepEqual((await readdir(join(dir, "skills"))).sort(), ["mnemio-onboarding", "mnemio-pricing", "my-notes"]);

  assert.deepEqual(await removeSkills({ env }), { removed: 1 });
  assert.deepEqual((await readdir(join(dir, "skills"))).sort(), ["mnemio-onboarding", "my-notes"]);
});

test("unsafe paths in a bundle are never written outside the skill", async t => {
  const { dir, env, setBundle } = await setup(t);
  setBundle({ hash: "x", skills: [{ name: "evil", hash: "e", files: { "SKILL.md": "ok", "../../escape.md": "no", "a/../../b.md": "no", "run.sh": "no" } }] });
  await installSkills({ env, request: async () => Response.json({ hash: "x", skills: [{ name: "evil", hash: "e", files: { "SKILL.md": "ok", "../../escape.md": "no", "a/../../b.md": "no", "run.sh": "no" } }] }) });
  assert.deepEqual(await readdir(join(dir, "skills/mnemio-evil")), ["SKILL.md"]);
  assert.ok(!existsSync(join(dir, "escape.md")));
});

test("the background start-of-session hook installs them, and removes them when switched off in Mnemio", async t => {
  const { dir, env, request } = await setup(t);
  await handle({ hook_event_name: "SessionStart", cwd: dir }, "reconcile", env, request);
  assert.ok(existsSync(join(dir, "skills/mnemio-release/SKILL.md")));
  const off = async url => url.pathname === "/api/claude/config" ? Response.json({ workspace: "Acme", prefs: { loadSkills: false } }) : request(url);
  await rm(join(env.MNEMIO_CONFIG_DIR, "config-cache.json"), { force: true });
  await handle({ hook_event_name: "SessionStart", cwd: dir }, "reconcile", env, off);
  assert.ok(!existsSync(join(dir, "skills/mnemio-release")));
});
