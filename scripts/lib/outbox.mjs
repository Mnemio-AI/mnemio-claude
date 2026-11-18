import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const digest = value => createHash("sha256").update(value).digest("hex");

// Scope retry data to one account token, server and project. Rotation never sends old notes as a new user.
export function syncDirectory(env, project, kind) {
  if (!env.CLAUDE_PLUGIN_DATA || !env.MNEMIO_TOKEN) throw new Error("Plugin data directory and token required for automatic memory.");
  return join(env.CLAUDE_PLUGIN_DATA, kind, digest(JSON.stringify([env.MNEMIO_URL || "http://localhost:8787", env.MNEMIO_TOKEN, project])));
}

export async function retain(dir, payload, send) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(payload);
  const path = join(dir, digest(body) + ".json");
  const tmp = join(dir, randomUUID() + ".tmp");
  await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
  await send(payload);
  await unlink(path).catch(e => { if (e.code !== "ENOENT") throw e; });
}

export async function retry(dir, send) {
  let files;
  try { files = await readdir(dir); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const path = join(dir, file);
    let body;
    try { body = await readFile(path, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    await send(JSON.parse(body));
    await unlink(path).catch(e => { if (e.code !== "ENOENT") throw e; });
  }
}
