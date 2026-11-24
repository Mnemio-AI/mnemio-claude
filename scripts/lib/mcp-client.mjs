import { mnemioConfig } from "./http.mjs";

/**
 * A small client for an MCP server on Mnemio (Streamable HTTP): Mnemio's tools (/api/claude/mcp) and the person's
 * connected apps (/api/claude/apps/mcp). The plugin's own stdio server passes their tools on to Claude, so the
 * address and token come from the saved sign-in instead of being fixed in .mcp.json.
 */
export class MnemioMcp {
  constructor(path, { env = process.env, request = fetch } = {}) {
    this.path = path;
    this.env = env;
    this.request = request;
    this.session = null;
    this.ready = null;
    this.ids = 0;
  }

  async post(message, { notification = false } = {}) {
    const { url, token } = mnemioConfig(this.env);
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token && { authorization: "Bearer " + token }),
      ...(this.session && { "mcp-session-id": this.session }),
      ...(this.protocol && { "mcp-protocol-version": this.protocol }),
      // The background listener says which chat it's answering, and a session started to listen (channel mode) is
      // answering chats too: Mnemio then holds calls that send, change or delete until the person approves them.
      ...((this.env.MNEMIO_ANSWERING || this.env.MNEMIO_CHANNEL === "1") && { "x-mnemio-answering": this.env.MNEMIO_ANSWERING || "channel" })
    };
    const r = await this.request(new URL(this.path, url), { method: "POST", headers, body: JSON.stringify(message), redirect: "error", signal: AbortSignal.timeout(120000) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (notification) return null;
    if (r.status === 404 && this.session) {
      // The server forgot the session: start again once.
      this.session = null;
      this.ready = null;
      throw Object.assign(new Error("session expired"), { retry: true });
    }
    const type = r.headers.get("content-type") || "";
    const text = await r.text();
    let reply;
    if (type.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          const m = JSON.parse(line.slice(5).trim());
          if (m.id === message.id) reply = m;
        } catch {}
      }
    } else {
      try { reply = JSON.parse(text); } catch {}
    }
    if (!reply) throw new Error(`Mnemio answered ${r.status}${text ? ": " + text.slice(0, 200) : ""}`);
    if (reply.error) throw new Error(reply.error.message || "Mnemio tool call failed");
    return reply.result;
  }

  async init() {
    this.ready ??= (async () => {
      const result = await this.post({ jsonrpc: "2.0", id: ++this.ids, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mnemio-plugin", version: "1" } } });
      this.protocol = result?.protocolVersion;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { notification: true }).catch(() => {});
    })().catch(e => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  async call(method, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.init();
        return await this.post({ jsonrpc: "2.0", id: ++this.ids, method, ...(params !== undefined && { params }) });
      } catch (e) {
        if (!e.retry || attempt) throw e;
      }
    }
  }

  async tools() {
    const out = [];
    let cursor;
    do {
      const page = await this.call("tools/list", cursor ? { cursor } : undefined);
      out.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  }
}
