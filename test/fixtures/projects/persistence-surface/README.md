# Persistence surface fixture

Passive, bounded persistence/migration fixture for static inspection. `data/workflow-v0.json` is representative prior-state data; `migrations/001-upgrade.ts` is migration-shaped fixture data, not an executable migration. Discovery must never import, run, or apply either file.
