import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { constants } from "node:fs";
import { fetchMnemio } from "./http.mjs";

/** Same limits Mnemio applies (server: claude-inbox.ts FILE_LIMITS). */
export const LIMITS = { count: 10, eachBytes: 15 * 1024 * 1024, totalBytes: 30 * 1024 * 1024 };

/** Where files that came with chat messages are saved: private to this person, outside any repository. */
export const inboxDir = (env = process.env) => join(env.CLAUDE_PLUGIN_DATA || tmpdir(), "mnemio-inbox");

const safeName = name => String(name).replace(/[/\\\0]/g, "_").replace(/^\.+/, "").trim().slice(0, 120) || "file";

/** Downloads a collected message's attachments (into `folder`, by default <dir>/<message id>); returns their local paths, in order. */
export async function downloadAttachments(message, { env = process.env, request = fetch, dir = inboxDir(env), folder } = {}) {
  if (!message.attachments?.length) return [];
  if (!/^[0-9a-f-]{36}$/.test(message.id)) throw new Error("Mnemio sent an invalid message id.");
  folder ??= join(dir, message.id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const paths = [];
  const used = new Set();
  for (const a of message.attachments) {
    const response = await fetchMnemio(`inbox/${message.id}/files/${encodeURIComponent(a.id)}`, { env, request });
    const data = Buffer.from(await response.arrayBuffer());
    let name = safeName(a.name);
    for (let n = 2; used.has(name); n++) name = `${n}-${safeName(a.name)}`;
    used.add(name);
    const path = join(folder, name);
    await writeFile(path, data, { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}

/**
 * Local files Claude wants to send with an answer, as { name, data(base64) }. Only regular files inside `roots`
 * (the session's folder, the temp folder, the inbox folder), never hidden ones or through a link: a message in a
 * shared thread must not be able to talk Claude into posting ~/.ssh or a project's .env.
 */
export async function replyFiles(paths, roots) {
  if (!paths?.length) return [];
  if (!Array.isArray(paths) || paths.length > LIMITS.count) throw new Error(`Attach up to ${LIMITS.count} files.`);
  const realRoots = (await Promise.all(roots.filter(Boolean).map(r => realpath(r).catch(() => null)))).filter(Boolean);
  const out = [];
  let total = 0;
  for (const p of paths) {
    if (typeof p !== "string" || !isAbsolute(p)) throw new Error("Give each file as an absolute path.");
    const real = await realpath(p).catch(() => null);
    if (!real || real !== p) throw new Error(`${p}: not found, or reached through a link.`);
    const root = realRoots.find(r => real === r || real.startsWith(r + sep));
    if (!root) throw new Error(`${p}: only files in this session's folder or the temp folder can be sent.`);
    if (relative(root, real).split(sep).some(part => part.startsWith("."))) throw new Error(`${p}: hidden files can't be sent.`);
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`${p}: not a file.`);
    if (info.size > LIMITS.eachBytes || total + info.size > LIMITS.totalBytes) throw new Error(`${p}: too large to send (up to 15 MB each, 30 MB in all).`);
    const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const data = await file.readFile();
      total += data.length;
      out.push({ name: basename(real), data: data.toString("base64") });
    } finally {
      await file.close();
    }
  }
  return out;
}

export const replyRoots = (env = process.env) => [process.cwd(), env.CLAUDE_PROJECT_DIR, tmpdir(), inboxDir(env)];
