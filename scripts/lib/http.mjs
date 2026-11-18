/**
 * Calls Mnemio's plugin API (/api/claude/*) as the person whose token this is.
 *
 * In a Claude cloud session (CLAUDE_CODE_REMOTE=true) the token isn't in the environment: it is a network secret
 * that Anthropic's proxy adds to requests for the Mnemio host after they leave the VM, so none is sent from here.
 */
export function mnemioConfig(env = process.env) {
  const cloud = env.CLAUDE_CODE_REMOTE === "true";
  const url = new URL(env.MNEMIO_URL || (cloud ? "https://unset.invalid" : "http://localhost:8787"));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (cloud && !env.MNEMIO_URL) throw new Error("Set MNEMIO_URL in this cloud environment's environment variables.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (loopback && url.protocol === "http:"))) {
    throw new Error("Set MNEMIO_URL to an HTTPS workspace origin or a local development address.");
  }
  if (!env.MNEMIO_TOKEN && !cloud) throw new Error("Set MNEMIO_TOKEN from Mnemio → Settings → Claude before starting Claude Code.");
  return { url, token: env.MNEMIO_TOKEN || null };
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
