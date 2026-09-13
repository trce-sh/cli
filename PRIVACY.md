# Privacy

Local reports stay on your machine. Linking to a workspace enables metadata uploads; it does
not give trce access to your prompts, responses, source code, or skill instructions.

## What leaves your machine

| Action | Destination | Data |
| --- | --- | --- |
| `report`, `dedupe`, `diff` | None | These commands are offline. |
| `init` | Linked dashboard | Short hostname, platform, and device-link confirmation. |
| `push` and background hooks | Linked dashboard | Skill names, descriptions, fingerprints, capability badges, agent/model identifiers, timestamps, opaque IDs, token counts, connected repository slugs, duplicate scores, and Shared install events. |
| `push --dry-run` | Linked dashboard | Authenticated repository-scope lookup only. No report upload. |
| Personal `add` / `update` | GitHub | Repository and skill source requests using your `gh` authentication. |
| Shared `add` / `update` | Linked dashboard, then GitHub | Library repository and credential request, then direct file downloads. |
| `promote` / `unify` | Linked dashboard and GitHub | Action ID and PR number to trce; reviewed skill files directly to GitHub. |
| `remove` | None | Moves managed files to local trash. |

Reports are limited to connected repositories, skills used in those sessions, and Shared library
installs. Descriptions are the SKILL.md frontmatter description, limited to 500 characters.
Keep credentials and unrelated private content out of skill names and descriptions.

trce never receives prompts, responses, source code, diffs, branch names, commit messages,
shell arguments, unrelated local paths, or the full skill instructions. Reviewed uploads to
GitHub print their file list and reject symbolic links and `.env` files.

## Inspect an upload

```sh
trce push --dry-run
```

This fetches repository scope and prints the exact report body without uploading it.
Unexpected fields and path-like values stop a push. This guard is not a general secret scanner.
For the field-level contract, see the [payload builder and allowlist](src/payload.ts).

## Local files

Machine credentials, install records, pending actions, hooks, and recoverable trash live under
`~/.trce/`. Credentials are in `config.json`; `skills.json` is a read-only fallback.
State files use owner-only permissions on macOS and Linux. On Windows they inherit your profile's
permissions. Do not share this directory.

An `installs.lock/` directory prevents overlapping commands from overwriting install records.

`init` adds Claude Code and Codex completion hooks unless you use `--no-hooks`. Hooks preserve
existing agent configuration and upload in the background at most once per minute.
Hooks run the installed CLI, never download packages, and do not forward notification payloads
to trce. If the CLI is moved or removed, hooks stop until reinstalled.
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` overrides are respected.

Dashboard and GitHub credentials are separate. Token-bearing requests refuse redirects.
Remote connections require HTTPS unless you explicitly allow insecure HTTP.

## Unlink or remove

1. Run `trce init --remove` to stop trce's hooks. This keeps the machine link.
2. Revoke the machine in the dashboard to invalidate its token.
3. Delete `~/.trce/config.json` and `~/.trce/skills.json`, if present, to remove local credentials.

Installed skills remain on disk. To use `trce remove <skill>`, do so before deleting the machine
link. Keep `~/.trce/trash/` if you need to recover removed skills.

The CLI has no analytics SDK or telemetry. Synthetic benchmarks read no user history.
Links from this repository use static campaign tags; they contain no machine or user identifiers.
Visiting the website is separate from running an offline command.

Questions or concerns: [hi@trce.sh](mailto:hi@trce.sh).
