# trce CLI

Standalone local-first CLI for trce. This repository contains the CLI, not the dashboard.

Read `README.md`, `RELEASING.md`, `PRIVACY.md`, and `docs/ARCHITECTURE.md` before changing code.

## Conventions

- Node 22, TypeScript, pnpm, Biome, and Vitest.
- Verify with `pnpm run verify`; run `pnpm run smoke:package` for release-facing changes.
- Only skill metadata may leave a machine. Never send prompts, responses, code, diffs, paths
  outside skill directories, shell arguments, or unrelated repository data. `push --dry-run` must
  print the exact request body.
- Native agent formats are unstable. Unknown records degrade gracefully; every parser path needs a
  sanitized fixture and golden test.
- Keep this repository standalone. Do not import source from another checkout.
- Keep the package private and on a development version until the maintainer approves a release.
- Pushes, publication, repository visibility, and cloud changes require separate approval.
- Use small commits prefixed with `cli:`.
