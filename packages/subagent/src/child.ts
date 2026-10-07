import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
  const token = process.env.PI_SUBAGENT_TOKEN;
  if (!token || !process.send) throw new Error("Child questions require the owning parent's private IPC channel");
  const pending = new Map<string, { resolve: (message: string) => void; reject: (error: Error) => void }>();
  const receive = (value: unknown) => {
    const reply = value as { type?: string; token?: string; requestId?: string; message?: string };
    if (reply?.type !== "subagent_reply" || reply.token !== token || !reply.requestId) return;
    const waiter = pending.get(reply.requestId);
    if (!waiter || typeof reply.message !== "string") return;
    pending.delete(reply.requestId);
    process.send?.({ type: "subagent_reply_ack", token, requestId: reply.requestId });
    waiter.resolve(reply.message);
  };
  process.on("message", receive);
  pi.on("session_shutdown", () => {
    process.off("message", receive);
    for (const waiter of pending.values()) waiter.reject(new Error("Question cancelled: child shutdown. Do not guess or continue the disputed action."));
    pending.clear();
  });
  pi.registerTool({
    name: "ask_parent", label: "Ask parent", executionMode: "sequential", description: "Ask the parent for a blocking decision. Wait for an explicit answer. Cancellation is not permission to guess or continue.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }) }),
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const requestId = randomUUID();
      const message = await new Promise<string>((resolve, reject) => {
        const cancel = () => { clean(); pending.delete(requestId); reject(new Error("Question cancelled. Do not guess or continue the disputed action.")); };
        const clean = () => signal?.removeEventListener("abort", cancel);
        pending.set(requestId, { resolve: message => { clean(); resolve(message); }, reject: error => { clean(); reject(error); } });
        signal?.addEventListener("abort", cancel, { once: true });
        process.send!({ type: "subagent_question", token, requestId, question: args.question }, error => {
          if (error) { clean(); pending.delete(requestId); reject(error); }
        });
      });
      return { content: [{ type: "text", text: message }], details: { requestId, answered: true } };
    },
  });
}
