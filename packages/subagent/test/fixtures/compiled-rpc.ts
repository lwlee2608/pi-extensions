import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "--mode rpc") throw new Error(`Unexpected CLI arguments: ${process.argv}`);
const token = process.env.PI_SUBAGENT_TOKEN;
process.send?.({ type: "subagent_ready", token });
process.on("message", (value: any) => {
  if (value.type !== "subagent_reply" || value.token !== token) return;
  process.send?.({ type: "subagent_reply_ack", token, requestId: value.requestId });
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
});
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const { id, type } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: true, data: { disposition: "started" } }) + "\n");
  if (type === "prompt") process.send?.({ type: "subagent_question", token, requestId: "fixture-question", question: "Reply over IPC?" });
});
lines.on("close", () => process.exit(0));
