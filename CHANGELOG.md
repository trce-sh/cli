# Changelog

## [Unreleased]

## [0.2.2] - 2026-09-15

### Changes

- The local report opens with the trace mark, pads every line, boxes the overview with a proportion bar of called, no-call, and not-measured installations, and shows a call bar per row in Recent activity on terminals 100 columns or wider.
- Every section table shares one skill-column width, so agent and scope columns line up across sections and issue text gets the spare room.
- After No calls, the report counts skills never called per agent with the description tokens they still load per session, and the number of overlapping skill pairs.
- In an interactive terminal the report plays a short reveal after the scan: progress lines per agent with live file counts, then the header, overview, and activity rows. `--static` or `TRCE_STATIC=1` prints at once; pipes, `--json`, and `CI` never animate.
- The report asks the terminal for its background colour and uses a light palette on light backgrounds. Light backgrounds use separate dim, success, warning, and danger tones.
- Email, newsletter, drip, and nurture skills file under Marketing & content instead of Agent workflows.

## [0.2.1] - 2026-09-14

### Bug fixes

- Preserve an outer Codex notifier when removing trce from its JSON-encoded callback. Reinstalling also refreshes trce's nested notification wrapper.
- Preserve escaped characters in existing Codex notification arguments.

## [0.2.0] - 2026-09-13

Initial release of the local-first skill management CLI.

- Offline skill inventory, activity reports, duplicate detection, and drift comparison.
- Large text files keep the same fingerprint across LF and CRLF checkouts without buffering the whole file.
- Claude Code and Codex session evidence with token accounting. Cursor inventory support.
- Team linking, scoped metadata uploads, exact dry-run payloads, and background reporting hooks.
- Personal and Shared skill installation, updates, and recoverable removal.
- Install changes are serialized across commands and background uploads. Updates detect executable-mode changes and protect local permission edits on macOS and Linux.
- Reviewed sharing and standardization through direct-to-GitHub pull requests.
- Node 22 support, no runtime dependencies or telemetry, and an audited package allowlist.
