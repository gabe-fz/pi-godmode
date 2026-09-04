/**
 * Deterministic terminal fixture data. It is intentionally not invoked at
 * module load: discovery must inspect this file and never execute it.
 */
export const terminalFixture = {
  width: 40,
  height: 4,
  screen: ["GODMODE FIXTURE", "ready", "fixture> ", ""] as const,
} as const;

export function main(): typeof terminalFixture {
  return terminalFixture;
}
