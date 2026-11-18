import { callMnemio, isConnected } from "./http.mjs";
import { readConfigCache, saveConfigCache } from "./credentials.mjs";

/**
 * The person's plugin settings from Mnemio (Settings → Claude): which projects sync, whether the skill catalog
 * loads. Fetched at session start and kept for a few minutes, so prompt hooks don't wait on the network.
 */
const FRESH_MS = 5 * 60_000;
const DEFAULTS = { syncAll: false, projects: [], loadSkills: true };

export async function workspaceConfig({ env = process.env, request = fetch, refresh = false, timeout = 3000 } = {}) {
  if (!isConnected(env)) return null;
  const cached = readConfigCache(env);
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < FRESH_MS) return cached.config;
  try {
    const config = await callMnemio("config", undefined, { env, request, timeout });
    config.prefs = { ...DEFAULTS, ...config.prefs };
    try { saveConfigCache({ fetchedAt: new Date().toISOString(), config }, env); } catch {}
    return config;
  } catch {
    // Offline or slow: last known settings beat none.
    return cached?.config ?? null;
  }
}
