import type { GodmodeConfig, ThinkingLevel } from "./types.ts";

export interface PiModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface ModelLeaseHost {
  findModel(provider: string, id: string): PiModel | undefined;
  isModelScoped(model: PiModel): boolean;
  setModel(model: PiModel): Promise<boolean>;
  getModel(): PiModel | undefined;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface ModelLeaseSnapshot {
  previousModel: PiModel;
  previousThinking: ThinkingLevel;
  godmodeModel: PiModel;
  godmodeThinking: ThinkingLevel;
}

function tuple(model: PiModel | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export class ModelLease {
  #snapshot?: ModelLeaseSnapshot;

  get active(): boolean { return this.#snapshot !== undefined; }
  get snapshot(): Readonly<ModelLeaseSnapshot> | undefined { return this.#snapshot; }

  async acquire(config: GodmodeConfig, host: ModelLeaseHost): Promise<ModelLeaseSnapshot> {
    if (this.#snapshot) throw new Error("Godmode model lease is already active.");
    const previousModel = host.getModel();
    if (!previousModel) throw new Error("Cannot enable Godmode without an active Primary model.");
    const previousThinking = host.getThinkingLevel();
    const configured = config.godmodePolicy.allowedModels;
    const currentKey = tuple(previousModel);
    const ordered = [...configured].sort((left, right) => {
      const leftCurrent = `${left.provider}/${left.model}` === currentKey ? 0 : 1;
      const rightCurrent = `${right.provider}/${right.model}` === currentKey ? 0 : 1;
      return leftCurrent - rightCurrent;
    });

    const failures: string[] = [];
    let selected: PiModel | undefined;
    for (const candidate of ordered) {
      const model = host.findModel(candidate.provider, candidate.model);
      if (!model) { failures.push(`${candidate.provider}/${candidate.model}: unavailable`); continue; }
      if (!host.isModelScoped(model)) { failures.push(`${candidate.provider}/${candidate.model}: outside active model scope`); continue; }
      if (!(await host.setModel(model))) { failures.push(`${candidate.provider}/${candidate.model}: authentication unavailable`); continue; }
      const active = host.getModel();
      if (!active || active.provider !== candidate.provider || active.id !== candidate.model) {
        failures.push(`${candidate.provider}/${candidate.model}: selection could not be verified`);
        continue;
      }
      selected = model;
      break;
    }
    if (!selected) {
      if (tuple(host.getModel()) !== tuple(previousModel)) await host.setModel(previousModel);
      host.setThinkingLevel(previousThinking);
      throw new Error(`No configured Godmode model is available and authenticated. ${failures.join("; ")}`);
    }

    try {
      host.setThinkingLevel(config.godmodePolicy.minimumThinking);
      const actualThinking = host.getThinkingLevel();
      if (actualThinking !== config.godmodePolicy.minimumThinking) {
        throw new Error(`Godmode thinking verification failed: requested ${config.godmodePolicy.minimumThinking}, host applied ${actualThinking}.`);
      }
      this.#snapshot = {
        previousModel,
        previousThinking,
        godmodeModel: selected,
        godmodeThinking: actualThinking,
      };
      return this.#snapshot;
    } catch (error) {
      await host.setModel(previousModel);
      host.setThinkingLevel(previousThinking);
      throw error;
    }
  }

  async restore(host: ModelLeaseHost): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    let restoreError: Error | undefined;
    try {
      if (!(await host.setModel(snapshot.previousModel))) restoreError = new Error(`Could not restore prior Primary model ${tuple(snapshot.previousModel)} (authentication unavailable).`);
      else if (tuple(host.getModel()) !== tuple(snapshot.previousModel)) restoreError = new Error(`Could not verify restoration of prior Primary model ${tuple(snapshot.previousModel)}.`);
      host.setThinkingLevel(snapshot.previousThinking);
      if (host.getThinkingLevel() !== snapshot.previousThinking) restoreError ??= new Error(`Could not restore prior thinking level ${snapshot.previousThinking}.`);
    } finally {
      this.#snapshot = undefined;
    }
    if (restoreError) throw restoreError;
  }
}
