import { pathToFileURL } from "node:url";
import { run } from "./lib/commands.mjs";
export { run };

const STDIN_LIMITS = { skill: 8192, recall: 8192, save: 8192, reply: 32768 };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, arg] = process.argv.slice(2);
  try {
    // `skill <name>` may name the skill as an argument; everything else that takes text reads it from stdin.
    let input = action === "skill" && arg ? arg : "";
    if (action in STDIN_LIMITS && !input) {
      for await (const chunk of process.stdin.setEncoding("utf8")) {
        input += chunk;
        if (input.length > STDIN_LIMITS[action]) throw new Error("Input too long.");
      }
    }
    const result = await run(action, input.trim(), process.env, fetch, arg);
    if (result) console.log(JSON.stringify(result, null, action === "inbox" ? 2 : 0));
  } catch (error) {
    console.error("Mnemio:", error.message);
    process.exitCode = action === "session-start" ? 0 : 1;
  }
}
