export interface ActiveToolsHost {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

const GODMODE_TOOLS = ["godmode_delegate", "godmode_workflow", "godmode_control"] as const;
const REPLACED_TOOLS = ["subagent", "subagent_wait"] as const;

export class ActiveToolLease {
  readonly #host: ActiveToolsHost;
  #before?: Set<string>;

  constructor(host: ActiveToolsHost) { this.#host = host; }
  get active(): boolean { return this.#before !== undefined; }

  acquire(): void {
    if (this.#before) throw new Error("Godmode active-tool lease is already held.");
    const before = new Set(this.#host.getActiveTools());
    const next = [...before].filter((name) => !REPLACED_TOOLS.includes(name as typeof REPLACED_TOOLS[number]));
    for (const name of GODMODE_TOOLS) if (!next.includes(name)) next.push(name);
    this.#host.setActiveTools(next);
    const actual = new Set(this.#host.getActiveTools());
    if (REPLACED_TOOLS.some((name) => actual.has(name)) || GODMODE_TOOLS.some((name) => !actual.has(name))) {
      this.#host.setActiveTools([...before]);
      throw new Error("Could not verify Godmode active-tool restrictions.");
    }
    this.#before = before;
  }

  release(): void {
    const before = this.#before;
    if (!before) return;
    const current = new Set(this.#host.getActiveTools());
    for (const name of GODMODE_TOOLS) if (!before.has(name)) current.delete(name);
    for (const name of REPLACED_TOOLS) {
      if (before.has(name)) current.add(name);
      else current.delete(name);
    }
    this.#host.setActiveTools([...current]);
    this.#before = undefined;
  }
}
