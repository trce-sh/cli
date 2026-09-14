# Changelog

## [Unreleased]

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
