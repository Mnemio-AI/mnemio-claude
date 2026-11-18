import { readCredentials } from "./credentials.mjs";

/**
 * Calls Mnemio's plugin API (/api/claude/*) as the person who connected this Claude.
 *
 * Where the address and token come from, first match wins:
 *  1. MNEMIO_URL / MNEMIO_TOKEN in the environment (cloud runs, scripts, company-managed setups);
 *  2. the sign-in saved by /mnemio:connect.
 * In a Claude cloud session (CLAUDE_CODE_REMOTE=true) the token isn't in the environment: it is a network secret
 * that Anthropic's proxy adds to requests for the Mnemio host after they leave the VM, so none is sent from here.
 */
export const NOT_CONNECTED = "Mnemio isn't connected: run /mnemio:connect <your workspace address>.";

export function mnemioConfig(env = process.env) {
  const cloud = env.CLAUDE_CODE_REMOTE === "true";
  const saved = env.MNEMIO_TOKEN ? null : readCredentials(env);
  const rawUrl = env.MNEMIO_URL || saved?.url;
  if (!rawUrl) throw new Error(cloud ? "Set MNEMIO_URL in this cloud environment's environment variables." : NOT_CONNECTED);
  const url = new URL(rawUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (loopback && url.protocol === "http:"))) {
    throw new Error("The Mnemio address must be an HTTPS workspace origin or a local development address.");
  }
  // A saved token only ever goes to the workspace it came from.
  const savedToken = saved && new URL(saved.url).origin === url.origin ? saved.token : null;
  const token = env.MNEMIO_TOKEN || savedToken || null;
  if (!token && !cloud) throw new Error(NOT_CONNECTED);
  return { url, token };
}

/** Whether this Claude can reach Mnemio (without calling it). */
export function isConnected(env = process.env) {
  try {
    mnemioConfig(env);
    return true;
  } catch {
    return false;
  }
}

/** A raw response (file downloads). Throws on an error status. */
export async function fetchMnemio(path, { env = process.env, request = fetch, timeout = 120000 } = {}) {
  const { url, token } = mnemioConfig(env);
  const response = await request(new URL("/api/claude/" + path, url), {
    method: "GET", headers: token ? { authorization: "Bearer " + token } : {}, redirect: "error", signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Mnemio HTTP ${response.status}: ${detail.error || "request failed"}`);
  }
  return response;
}

export async function callMnemio(path, payload, { env = process.env, request = fetch, timeout = 65000, method, signal } = {}) {
  const { url, token } = mnemioConfig(env);
  const headers = token ? { authorization: "Bearer " + token } : {};
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body) headers["content-type"] = "application/json";
  const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
  const response = await request(new URL("/api/claude/" + path, url), {
    method: method || (body ? "POST" : "GET"), headers, body, redirect: "error",
    signal: AbortSignal.any(signals)
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Mnemio HTTP ${response.status}: ${detail.error || "request failed"}`);
  }
  return response.json();
}
