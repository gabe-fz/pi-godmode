import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FACULTIES, THINKING_LEVELS, type FacultyConfig, type GodmodeConfig, type ModelTuple } from "./types.ts";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MIN_TIMEOUT_MS = 1_000;
const NUCLEUS_THINKING = new Set(["medium", "high", "xhigh"]);
const FACULTY_THINKING = new Set<string>(THINKING_LEVELS);

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}.`);
  if (missing.length) throw new Error(`${field} is missing fields: ${missing.join(", ")}.`);
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} must be an exact nonempty string without surrounding whitespace or control characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > 256) throw new Error(`${field} must be at most 256 UTF-8 bytes.`);
  return value;
}

function modelTuple(value: unknown, field: string): ModelTuple {
  const input = record(value, field);
  exactKeys(input, ["provider", "model"], field);
  return { provider: exactString(input.provider, `${field}.provider`), model: exactString(input.model, `${field}.model`) };
}

function facultyConfig(value: unknown, field: string): FacultyConfig {
  const input = record(value, field);
  exactKeys(input, ["provider", "model", "thinking", "timeoutMs"], field);
  const tuple = modelTuple({ provider: input.provider, model: input.model }, field);
  if (typeof input.thinking !== "string" || !FACULTY_THINKING.has(input.thinking)) {
    throw new Error(`${field}.thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  if (!Number.isInteger(input.timeoutMs) || (input.timeoutMs as number) < MIN_TIMEOUT_MS || (input.timeoutMs as number) > MAX_TIMEOUT_MS) {
    throw new Error(`${field}.timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`);
  }
  return { ...tuple, thinking: input.thinking as FacultyConfig["thinking"], timeoutMs: input.timeoutMs as number };
}

export function parseConfig(value: unknown): GodmodeConfig {
  const root = record(value, "config");
  exactKeys(root, ["schemaVersion", "nucleusPolicy", "faculties"], "config");
  if (root.schemaVersion !== 1) throw new Error(`Unsupported Godmode config schemaVersion '${String(root.schemaVersion)}'; expected 1.`);

  const nucleus = record(root.nucleusPolicy, "config.nucleusPolicy");
  exactKeys(nucleus, ["allowedModels", "minimumThinking"], "config.nucleusPolicy");
  if (!Array.isArray(nucleus.allowedModels) || nucleus.allowedModels.length === 0 || nucleus.allowedModels.length > 32) {
    throw new Error("config.nucleusPolicy.allowedModels must contain 1 to 32 exact model tuples.");
  }
  const allowedModels = nucleus.allowedModels.map((entry, index) => modelTuple(entry, `config.nucleusPolicy.allowedModels[${index}]`));
  const tupleKeys = allowedModels.map(({ provider, model }) => `${provider}\0${model}`);
  if (new Set(tupleKeys).size !== tupleKeys.length) throw new Error("config.nucleusPolicy.allowedModels contains duplicate model tuples.");
  if (typeof nucleus.minimumThinking !== "string" || !NUCLEUS_THINKING.has(nucleus.minimumThinking)) {
    throw new Error("config.nucleusPolicy.minimumThinking must be medium, high, or xhigh.");
  }

  const facultiesInput = record(root.faculties, "config.faculties");
  exactKeys(facultiesInput, FACULTIES, "config.faculties");
  const faculties = Object.fromEntries(FACULTIES.map((name) => [name, facultyConfig(facultiesInput[name], `config.faculties.${name}`)])) as GodmodeConfig["faculties"];
  const nucleusSet = new Set(tupleKeys);
  for (const name of FACULTIES) {
    const faculty = faculties[name];
    if (nucleusSet.has(`${faculty.provider}\0${faculty.model}`)) {
      throw new Error(`config.faculties.${name} may not reuse a Nucleus provider/model tuple.`);
    }
  }
  return {
    schemaVersion: 1,
    nucleusPolicy: { allowedModels, minimumThinking: nucleus.minimumThinking as GodmodeConfig["nucleusPolicy"]["minimumThinking"] },
    faculties,
  };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "godmode", "config.json");
}

export async function loadConfig(path = configPath()): Promise<GodmodeConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read Godmode configuration at '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) throw new Error(`Godmode configuration exceeds ${MAX_CONFIG_BYTES} bytes.`);
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Godmode configuration at '${path}' is not valid JSON: ${error.message}`);
    throw error;
  }
}
