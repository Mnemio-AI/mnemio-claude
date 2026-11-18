import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Where the plugin keeps its Mnemio sign-in (from /mnemio:connect), outside any project and readable by this user
 * only. MNEMIO_URL / MNEMIO_TOKEN in the environment still win (cloud runs, scripts, company-managed setups).
 */
export const configDir = (env = process.env) => env.MNEMIO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mnemio");
const file = (env, name) => join(configDir(env), name);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** { url, token, workspace, connectedAt } or null. */
export const readCredentials = (env = process.env) => {
  const c = readJson(file(env, "credentials.json"));
  return c && typeof c.url === "string" && typeof c.token === "string" ? c : null;
};
export const saveCredentials = (value, env = process.env) => writeJson(file(env, "credentials.json"), value);
export const forgetCredentials = (env = process.env) => {
  rmSync(file(env, "credentials.json"), { force: true });
  rmSync(file(env, "config-cache.json"), { force: true });
};

/** A connect request waiting for approval, so running /mnemio:connect again keeps waiting on the same code. */
export const readPending = (env = process.env) => readJson(file(env, "pending-connect.json"));
export const savePending = (value, env = process.env) => writeJson(file(env, "pending-connect.json"), value);
export const forgetPending = (env = process.env) => rmSync(file(env, "pending-connect.json"), { force: true });

/** The workspace's settings for the plugin (GET /api/claude/config), cached briefly. */
export const readConfigCache = (env = process.env) => readJson(file(env, "config-cache.json"));
export const saveConfigCache = (value, env = process.env) => writeJson(file(env, "config-cache.json"), value);
export const credentialsPath = (env = process.env) => file(env, "credentials.json");
