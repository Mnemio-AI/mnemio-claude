import { callMnemio } from "./http.mjs";
import { downloadAttachments, replyFiles, replyRoots } from "./attachments.mjs";

const ID = /^[0-9a-f-]{36}$/;

export async function run(action, input, env = process.env, request = fetch, arg, files = []) {
  const startup = action === "session-start";
  if (startup && env.MNEMIO_LOAD_SKILLS !== "1") return;
  let path;
  let body;
  switch (action) {
    case "session-start":
    case "skills":
      path = "skills";
      break;
    case "skill":
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input)) throw new Error("Enter a skill name from the catalog.");
      path = "skills/" + encodeURIComponent(input);
      break;
    case "recall":
    case "save": {
      const limit = action === "save" ? 8000 : 2000;
      if (!input || input.length > limit) throw new Error(`Enter between 1 and ${limit} characters.`);
      path = action === "save" ? "memory" : "recall";
      body = action === "save" ? { text: input } : { query: input };
      break;
    }
    // The person's chat-app messages waiting for their Claude (a cloud run collects them this way).
    case "inbox":
      path = "inbox/claim";
      body = { limit: 10 };
      break;
    case "reply":
      if (!ID.test(arg || "")) throw new Error("Give the message id from the inbox: reply <id>, with the answer on stdin.");
      if (!input || input.length > 30000) throw new Error("Enter an answer of up to 30000 characters.");
      path = `inbox/${arg}/reply`;
      body = { text: input };
      {
        const attached = await replyFiles(files, replyRoots(env));
        if (attached.length) body.files = attached;
      }
      break;
    default:
      throw new Error("Choose skills, skill, recall, save, inbox or reply.");
  }
  const result = await callMnemio(path, body, { env, request, timeout: startup ? 3000 : 65000 });
  // Files that came with chat messages are saved locally, and each message lists where.
  if (action === "inbox") {
    for (const m of result.messages) m.files = await downloadAttachments(m, { env, request });
  }
  if (!startup) return result;
  if (!result.skills.length) return;
  return { hookSpecificOutput: { hookEventName: "SessionStart",
    additionalContext: "Available Mnemio skills (use mnemio:brain to retrieve one): " + JSON.stringify(result.skills.slice(0, 80).map(name => ({ name, description: result.descriptions?.[name] }))).slice(0, 8000) } };
}
