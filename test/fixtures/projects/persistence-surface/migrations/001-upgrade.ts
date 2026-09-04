/**
 * Migration-shaped fixture data only. There is deliberately no migration
 * function or top-level operation: discovery must inspect, never execute or
 * apply, this file.
 */
export const migrationFixture = {
  id: "001-upgrade",
  fromSchemaVersion: 0,
  toSchemaVersion: 1,
  operations: [
    { kind: "add-field", path: "metadata.upgraded", value: true },
  ],
} as const;
