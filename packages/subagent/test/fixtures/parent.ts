import { Manager } from "../../src/manager.ts";
import type { Launch } from "../../src/profiles.ts";

const manager = new Manager({ root: process.argv[2], parentId: "process-parent" });
process.send?.({ ready: true });
process.on("message", async value => {
  const command = value as { id: string; action: string; launch?: Launch; task?: string; workerId?: string; runId?: string };
  try {
    let result: unknown;
    switch (command.action) {
      case "start": result = manager.start(command.launch!, command.task!, "retained"); break;
      case "wait": result = await manager.wait([command.runId!]); break;
      case "status": result = manager.status(); break;
      case "recover": result = await manager.recover(command.workerId!); break;
      case "message": result = await manager.message(command.workerId!, command.task!); break;
      case "shutdown": await manager.shutdown(); process.send?.({ id: command.id, result: true }, () => process.exit(0)); return;
    }
    process.send?.({ id: command.id, result });
  } catch (error) { process.send?.({ id: command.id, error: String(error) }); }
});
