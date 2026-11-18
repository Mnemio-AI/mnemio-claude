import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { callMnemio } from "./http.mjs";
import { configDir } from "./credentials.mjs";

/**
 * Company skills as real Claude Code skills: every skill the person receives in Mnemio (official, shared with them,
 * their hosted assistant's) is written to ~/.claude/skills/mnemio-<name>/, so Claude uses them like its own.
 * Only folders this plugin installed (listed in its manifest) are ever changed or removed; anything else in the
 * skills folder — the person's own skills, a folder they happen to call mnemio-something — is left alone.
 */

export const skillsRoot = (env = process.env) => env.MNEMIO_SKILLS_DIR || join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills");
const manifestPath = env => join(configDir(env), "installed-skills.json");
const PREFIX = "mnemio-";
const SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MD_PATH = /^[a-z0-9_-][a-z0-9_.-]*(\/[a-z0-9_-][a-z0-9_.-]*)*\.md$/i;

async function readManifest(env) {
  try {
    const m = JSON.parse(await readFile(manifestPath(env), "utf8"));
    return { hash: m.hash ?? null, dirs: Array.isArray(m.dirs) ? m.dirs.filter(d => typeof d === "string" && d.startsWith(PREFIX)) : [], root: m.root ?? null };
  } catch {
    return { hash: null, dirs: [], root: null };
  }
}

async function writeManifest(env, m) {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath(env), JSON.stringify(m, null, 2), { mode: 0o600 });
}

/** SKILL.md's frontmatter names the skill mnemio-<name>, so it can't clash with one of the person's own. */
export function renameSkill(md, name) {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (!fm) return `---\nname: ${name}\n---\n${md}`;
  const body = /^name:.*$/m.test(fm[1]) ? fm[1].replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n${fm[1]}`;
  return md.replace(fm[0], `---\n${body}\n---`);
}

/** Brings the installed company skills up to date. Returns what changed. */
export async function installSkills({ env = process.env, request = fetch } = {}) {
  const root = skillsRoot(env);
  const manifest = await readManifest(env);
  const bundle = await callMnemio(`skills/_bundle${manifest.hash && manifest.root === root ? `?have=${manifest.hash}` : ""}`, undefined, { env, request, timeout: 60000 });
  if (bundle.unchanged) return { unchanged: true, installed: manifest.dirs.length };

  await mkdir(root, { recursive: true });
  const mine = new Set(manifest.root === root ? manifest.dirs : []);
  const wanted = [];
  let skipped = 0;
  for (const s of bundle.skills ?? []) {
    if (!SAFE.test(s.name) || !s.files?.["SKILL.md"]) { skipped++; continue; }
    const dirName = PREFIX + s.name;
    const dir = join(root, dirName);
    // Never overwrite a folder the person made themselves.
    if (existsSync(dir) && !mine.has(dirName)) { skipped++; continue; }
    const temp = join(root, `.${dirName}.${randomUUID()}.tmp`);
    try {
      for (const [path, text] of Object.entries(s.files)) {
        if (!MD_PATH.test(path) || path.split("/").includes("..")) continue;
        const target = join(temp, ...path.split("/"));
        if (!target.startsWith(temp + sep)) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, path === "SKILL.md" ? renameSkill(text, dirName) : text);
      }
      await rm(dir, { recursive: true, force: true });
      await rename(temp, dir);
      wanted.push(dirName);
    } catch (e) {
      await rm(temp, { recursive: true, force: true });
      throw e;
    }
  }
  // Skills that left the person's Mnemio leave their Claude too.
  const removed = [];
  for (const d of mine) {
    if (!wanted.includes(d)) {
      await rm(join(root, d), { recursive: true, force: true });
      removed.push(d);
    }
  }
  await writeManifest(env, { hash: bundle.hash, dirs: wanted, root, installedAt: new Date().toISOString() });
  return { installed: wanted.length, removed: removed.length, skipped: skipped + (bundle.skipped ?? 0) };
}

/** Company skills off, or disconnected: take out what this plugin installed. */
export async function removeSkills({ env = process.env } = {}) {
  const manifest = await readManifest(env);
  if (!manifest.root) return { removed: 0 };
  for (const d of manifest.dirs) await rm(join(manifest.root, d), { recursive: true, force: true });
  await rm(manifestPath(env), { force: true });
  return { removed: manifest.dirs.length };
}

export const installedSkills = async (env = process.env) => (await readManifest(env)).dirs;
export const skillsInstalled = async (env = process.env) => (await installedSkills(env)).length > 0;
