import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { digest } from "./outbox.mjs";
import { mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

// An authored document may contain private data. Never follow links outside the opted-in tree.
export async function readDocument(path, limit) {
  if (await realpath(path) !== path) throw new Error("Linked documents are excluded from sync.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Document exceeds sync limits.");
    const bytes = Buffer.alloc(limit + 1);
    let n = 0;
    while (n < bytes.length) {
      const { bytesRead } = await file.read(bytes, n, bytes.length - n, null);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n > limit) throw new Error("Document exceeds sync limits.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n));
  } finally {
    await file.close();
  }
}

const validName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function changedSkill(project, changedPath) {
  const parts = relative(join(project, ".claude/skills"), resolve(project, changedPath)).split(sep);
  return parts.length > 1 && validName.test(parts[0]) && parts.at(-1).endsWith(".md") ? parts[0] : null;
}

export async function projectSkills(project) {
  const root = join(project, ".claude/skills");
  try {
    if (await realpath(root) !== root) return [];
    return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && validName.test(e.name)).map(e => e.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function skillBundle(project, name) {
  if (!validName.test(name)) throw new Error("Invalid skill name.");
  const root = join(project, ".claude/skills", name);
  const files = Object.create(null);
  let remaining = 60000;
  let count = 0;
  async function walk(dir) {
    if (await realpath(dir) !== dir) throw new Error("Linked directories are excluded from sync.");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!/^[a-z0-9_-][a-z0-9_.-]*$/i.test(entry.name) || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        if (++count > 32) throw new Error("A skill can contain up to 32 Markdown documents.");
        const text = await readDocument(path, remaining);
        remaining -= Buffer.byteLength(text);
        files[relative(root, path).split(sep).join("/")] = text;
      }
    }
  }
  await walk(root);
  if (!files["SKILL.md"]) return null;
  return { name, files };
}

/** Record the acknowledged revision. Offline edits retry at startup and competing projects cannot overwrite it. */
export async function syncSkill(project, name, stateDir, upload) {
  const bundle = await skillBundle(project, name);
  if (!bundle) return;
  const localHash = digest(JSON.stringify(Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b))));
  const statePath = join(stateDir, name + ".json");
  let previous;
  try { previous = JSON.parse(await readFile(statePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (previous?.localHash === localHash) return;
  const reply = await upload({ ...bundle, previousHash: previous?.remoteHash });
  if (!/^[a-f0-9]{64}$/.test(reply.hash)) throw new Error("Mnemio returned an invalid skill revision.");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temp = join(stateDir, randomUUID() + ".tmp");
  await writeFile(temp, JSON.stringify({ localHash, remoteHash: reply.hash }), { flag: "wx", mode: 0o600 });
  await rename(temp, statePath);
}
