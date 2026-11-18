import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { forgetCredentials, forgetPending, readCredentials, readPending, saveCredentials, savePending } from "./credentials.mjs";
import { removeSkills } from "./skills-install.mjs";

/**
 * /mnemio:connect: sign in by approving in the browser (no token to copy). Asks the workspace for a short code,
 * opens the approval page, and waits for the person to press Approve there; the workspace then hands this
 * computer its own token, saved privately (credentials.mjs).
 */

/** "acme.mnemio.ai", "https://acme.mnemio.ai/settings", "localhost:5173" → an origin. */
export function workspaceUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(raw);
  let u;
  try {
    u = new URL(/^https?:\/\//.test(raw) ? raw : `${local ? "http" : "https"}://${raw}`);
  } catch {
    throw new Error(`"${raw}" isn't a workspace address. Use one like acme.mnemio.ai.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (loopback && u.protocol === "http:"))) throw new Error("The workspace address must use https.");
  return u.origin;
}

function openBrowser(url, env) {
  if (env.MNEMIO_NO_BROWSER === "1") return false;
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function post(base, path, body, request) {
  const r = await request(new URL(path, base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20000) });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

export async function connect(input, { env = process.env, request = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), waitMs = 270000, log = m => process.stderr.write(m + "\n") } = {}) {
  const url = workspaceUrl(input) || workspaceUrl(env.MNEMIO_URL) || readCredentials(env)?.url || readPending(env)?.url;
  if (!url) throw new Error("Which Mnemio workspace? Run /mnemio:connect with its address, for example /mnemio:connect acme.mnemio.ai.");

  let pending = readPending(env);
  if (!pending || pending.url !== url || Date.parse(pending.expiresAt) < Date.now()) {
    const { status, data } = await post(url, "/api/claude/connect/start", { label: `Claude Code on ${hostname().replace(/\.local$/, "")}`.slice(0, 80) }, request);
    if (status !== 200 || !data.device_code) throw new Error(data.error || `The workspace answered ${status}. Is ${url} a Mnemio workspace?`);
    pending = { url, deviceCode: data.device_code, userCode: data.user_code, link: data.verification_uri_complete, interval: data.interval || 3, expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(), workspace: data.workspace };
    savePending(pending, env);
    const opened = openBrowser(pending.link, env);
    log(`${opened ? "Opened" : "Open"} ${pending.link} and approve code ${pending.userCode}.`);
  } else if (waitMs) {
    log(`Waiting for approval of code ${pending.userCode} at ${pending.link}.`);
  }
  // Step one only: show the link and code now; `connect --wait` then waits for the approval.
  if (!waitMs) return { approve: pending.link, code: pending.userCode, workspace: pending.workspace, expiresAt: pending.expiresAt };

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const { status, data } = await post(url, "/api/claude/connect/poll", { device_code: pending.deviceCode }, request);
    if (data.status === "approved" && data.token) {
      saveCredentials({ url: data.url ? workspaceUrl(data.url) : url, token: data.token, workspace: data.workspace || pending.workspace, connectedAt: new Date().toISOString() }, env);
      forgetPending(env);
      return { connected: true, workspace: data.workspace || pending.workspace, url };
    }
    if (status === 410 || data.status === "denied" || data.status === "expired") {
      forgetPending(env);
      throw new Error(data.status === "denied" ? "The connection was denied in Mnemio." : "The code expired. Run /mnemio:connect again.");
    }
    if (status !== 200) throw new Error(data.error || `The workspace answered ${status}.`);
    await sleep((data.interval || pending.interval) * 1000);
  }
  return { waiting: true, code: pending.userCode, link: pending.link, message: "Still waiting for approval. Approve it in the browser, then run /mnemio:connect again to finish." };
}

/** /mnemio:disconnect: signs this computer out at the workspace and forgets the saved sign-in. */
export async function disconnect({ env = process.env, request = fetch } = {}) {
  const c = readCredentials(env);
  forgetPending(env);
  if (!c) return { disconnected: false, message: "This computer isn't connected to Mnemio." };
  try {
    await request(new URL("/api/claude/config/token", c.url), { method: "DELETE", headers: { authorization: "Bearer " + c.token }, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch {
    // Offline: forget it here anyway; it can also be signed out in Mnemio → Settings → Claude.
  }
  forgetCredentials(env);
  // The company's skills belong to the workspace: they go with the sign-in.
  const { removed } = await removeSkills({ env }).catch(() => ({ removed: 0 }));
  return { disconnected: true, workspace: c.workspace || c.url, ...(removed && { companySkillsRemoved: removed }) };
}
