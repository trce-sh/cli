<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/trce-dark.svg">
  <img src="assets/trce.svg" alt="trce" width="128" height="32">
</picture>

# Review system for your agent skills.

[![CI](https://github.com/trce-sh/cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trce-sh/cli/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.14-5FA04E?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

trce shows which skills your coding agents use, where copies have drifted, and which skills
overlap. Start with a local report. Connect to [trce.sh](https://trce.sh?utm_source=github&utm_medium=referral&utm_campaign=cli&utm_content=readme_intro) when you want to review
skills across your team.

No account for local reports. No prompts, responses, or source code sent to trce.

## Get started

Requires Node.js 22.14 or newer.

```sh
npm install --global @trce/cli
trce report
```

Or run without a global install:

```sh
npx @trce/cli report
```

See recent skill calls, differing copies, and potential cleanup in your terminal. These commands
work offline:

```sh
trce report --all         # Include installed skills with no recorded calls
trce report --since 7d    # Focus on the past week
trce dedupe              # Find skills with overlapping instructions
trce diff review         # Compare installed copies of a skill named "review"
trce report --json       # Use the report in your own tools
```

trce reads Claude Code and Codex session history. Cursor support covers installed skills only,
not usage. Codex skill reads are inferred evidence, not proof that the instructions were followed.

## From one machine to your whole team

Your local report answers "what happens here?" [trce.sh](https://trce.sh?utm_source=github&utm_medium=referral&utm_campaign=cli&utm_content=readme_team) brings reports from
connected repositories into one workspace so you can:

- See which developers use a skill, with call history across Claude Code and Codex.
- Find versions that have drifted across machines and repositories.
- Review what to share, standardize, or retire, then make repository changes through GitHub pull requests.
- Keep a Shared skills library that teammates can install from and update locally.

**[Request access to trce.sh](https://trce.sh?utm_source=github&utm_medium=referral&utm_campaign=cli&utm_content=readme_cta)** to use the team workspace.

With access, link your machine, connect repositories in the app, and preview your first report:

```sh
trce init --no-hooks
trce push --dry-run
trce push
```

The preview fetches your team's repository scope but uploads no report. To send reports
automatically after sessions, run `trce init --hooks-only`. No daemon to keep running.

Publishing a report does not publish your skill files. The dashboard receives metadata;
reviewed skill files travel directly between your machine and GitHub.

## Privacy by design

Local reports stay local. Linked reports contain skill metadata such as names, descriptions,
fingerprints, call counts, and token counts, scoped to connected repositories. Linking also sends
your machine's short hostname and platform.

trce does not receive prompts, responses, source code, diffs, shell arguments, or unrelated local
paths. The package has no telemetry, runtime dependencies, or install scripts.

[Read the privacy summary](PRIVACY.md) for what is sent and how to stop reporting.

## Documentation and help

- [Usage guide](docs/USAGE.md): linking, installing skills, and finishing reviewed changes.
- [Contributing](CONTRIBUTING.md): local setup, tests, and parser fixtures.
- [Support](SUPPORT.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Run `trce --help` for all commands or `trce <command> --help` for options and network behavior.

Licensed under [MIT](LICENSE).
