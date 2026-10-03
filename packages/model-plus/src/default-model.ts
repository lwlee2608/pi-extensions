import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Favorite } from "./store.ts";

export class DefaultModelStore {
  private readonly agentDir: string;

  constructor(agentDir = getAgentDir()) {
    this.agentDir = agentDir;
  }

  private settings(): SettingsManager {
    return SettingsManager.create(this.agentDir, this.agentDir, { projectTrusted: false });
  }

  read(): Favorite | undefined {
    const settings = this.settings();
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    return provider && id ? { provider, id } : undefined;
  }

  async save(model: Favorite): Promise<void> {
    const settings = this.settings();
    settings.setDefaultModelAndProvider(model.provider, model.id);
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
  }
}
