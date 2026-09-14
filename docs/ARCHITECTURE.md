# How the CLI works

This document covers the public CLI only. The dashboard is a separate application.
The CLI runs on Node.js, compiles TypeScript to ES modules, and has no runtime dependencies.

## Local analysis

`trce report` reads skill directories and Claude Code or Codex session history concurrently.
It fingerprints installed files, associates recorded skill calls with copies found on the machine,
and identifies drift and possible duplicates. Cursor contributes inventory, not usage evidence.

Session parsers stream native records and retain accounting and invocation metadata rather than
whole transcripts. Unknown records and parse failures are counted and skipped. A historical call
refers to the skill version observed during the scan, not necessarily the version present at call time.

`report`, `dedupe`, and `diff` are offline. Terminal output and JSON exports are separate from
the upload payload.

## Network and file changes

Linking stores a machine token locally. Uploads first fetch the linked workspace's repository
scope, then build an allowlisted metadata payload. `push --dry-run` prints that same body without
uploading it. See [Privacy](../PRIVACY.md) for the data categories and how to stop reporting.

Skill installation downloads files directly from GitHub. Updates check managed copies for local
changes before replacement; removal moves them to recoverable trash. Reviewed PR commands send
skill files directly to GitHub, never through trce.

Completion hooks run only the installed local CLI; they never download a package. A missing CLI
path exits quietly until hooks are reinstalled. An atomic admission gate limits launches to once
per minute before creating a child process. Codex notification wrappers reject recursive chains,
mark child environments against reentry, and coalesce callbacks within one second as a second
guard. Notification payloads go only to a pre-existing notifier, never to trce. Reinstalling hooks
refreshes owned launchers; `trce init --remove` also removes their admission state.

If another notifier wraps trce's saved command in a JSON argument, removal restores the previous
command inside that wrapper and preserves its other arguments. Unknown encodings, changed
callback arguments, and wrappers without a saved previous command are left untouched.

There is no resident daemon. Local state lives under `~/.trce/`; agent hook configuration stays
in each agent's own settings. If a crash leaves an admission directory behind, hooks fail closed.
Remove and reinstall hooks to clear it.

## Finding the code

| Area | Start here |
| --- | --- |
| Process setup and command dispatch | [runtime](../src/runtime.ts), [commands](../src/cli.ts) |
| Inventory and session discovery | [inventory](../src/inventory.ts), [history](../src/history.ts) |
| Native formats | [parsers](../src/parsers/) |
| Analysis and presentation | [analysis](../src/analysis.ts), [output](../src/output.ts) |
| Upload contract | [payload](../src/payload.ts) |
| Managed installs | [catalog](../src/catalog.ts), [install records](../src/installs.ts) |
| Hooks | [hooks](../src/hooks.ts) |

Commands accept process and network dependencies so tests can exercise them without an interactive
terminal. Tests live beside their implementation. Sanitized fixtures cover native formats;
versioned contracts check fingerprints and rejected metadata.

See [Contributing](../CONTRIBUTING.md) for verification and [Releasing](../RELEASING.md) for
package and integration checks.
