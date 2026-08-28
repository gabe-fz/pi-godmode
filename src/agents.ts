import { AGENT_NAMES, facultyDefinitions, type RuntimeFacultyDefinition } from "./faculties.ts";
import type { Disposable, Faculty, GodmodeConfig } from "./types.ts";

export const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

export interface EventEmitter {
  emit(event: string, data: unknown): void;
}

interface RegistrationRequest {
  version: 1;
  name: string;
  definition: RuntimeFacultyDefinition;
  result?: { ok: true; registration: Disposable } | { ok: false; error: Error };
}

export function registerFaculties(events: EventEmitter, config: GodmodeConfig): Disposable[] {
  const definitions = facultyDefinitions(config);
  const registrations: Disposable[] = [];
  try {
    for (const faculty of Object.keys(AGENT_NAMES) as Faculty[]) {
      const request: RegistrationRequest = {
        version: 1,
        name: AGENT_NAMES[faculty],
        definition: definitions[faculty],
      };
      events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
      if (!request.result) throw new Error("pi-subagents did not handle runtime faculty registration. Ensure a compatible pi-subagents package is loaded in the same Pi process.");
      if (!request.result.ok) throw request.result.error;
      registrations.push(request.result.registration);
    }
    return registrations;
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    throw error;
  }
}
