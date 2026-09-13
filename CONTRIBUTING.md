# Contributing to trce

## Build and install

Use Node.js 22.14 or newer and pnpm 10.34.5. Check with `node --version` and `pnpm --version`.
Clone this repository and enter the checkout:

```sh
git clone https://github.com/trce-sh/cli.git
cd cli
```

Install dependencies and build the executable:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

Install the local build on your PATH without running package scripts:

```sh
npm install --global . --ignore-scripts
trce --version
trce report
```

The version should match `package.json`, and the report should run without an account. This
replaces any global `@trce/cli` installation. To undo it, run `npm uninstall --global @trce/cli`.
Rebuild after source changes. For an isolated package installation check, use `smoke:package` below.

## Verify a change

```sh
pnpm run verify
pnpm run smoke:package
pnpm run benchmark
```

`verify` runs Biome, the type check, and the tests. `smoke:package` builds, packs, installs the
tarball in a temporary directory, and runs the installed binary. Read
[Architecture](docs/ARCHITECTURE.md) for how the CLI operates and [Privacy](PRIVACY.md) for
the payload contract before changing code.

## Parser changes

Native Claude Code and Codex formats can change without notice. Each parser path needs a sanitized
fixture and a golden test. Unknown records must increment coverage counters and then be skipped.
Never include a real transcript or a path copied from another person's machine.

Keep coverage counters for unsupported records and parse failures. Bump the parser version when
the interpretation of existing records changes. Check the report golden when visible output changes.

## Privacy changes

The payload schema is a default-deny boundary. Do not add prompts, responses, code, diffs, full
skill instructions, local paths, shell arguments, branches, commits, pull-request identifiers, or
prompt-derived task identifiers. Any new metadata field needs a documented reason and a privacy
test before implementation.

Keep pull requests focused and include the commands used to verify the change. A merged pull request
does not authorize an npm release.

The CLI must remain standalone, with no imports from the dashboard. Coordinate changes to shared
fingerprint and payload contracts through versioned fixtures, not application-source dependencies.
See [Releasing](RELEASING.md) for package and integration gates.

## Changelog entries

For user-visible changes, add a short entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
Describe what users can do or what was fixed. Skip internal refactors, formatting, and routine
dependency updates unless they change behavior, compatibility, or security.

The changelog is curated, not generated from commit messages. At release time the maintainer
groups entries under the approved version and date, then uses those notes for the GitHub release.
GitHub's generated PR list can help check for omissions; it does not replace the user-facing notes.
