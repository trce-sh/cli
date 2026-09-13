# Using trce

[Install the CLI](../CONTRIBUTING.md#build-and-install), then run `trce report` from a repository
where you use agent skills. Run `trce <command> --help` for options and network behavior.

## Local reports

```sh
trce report
trce report --all
trce report --since 7d
trce report --json
trce dedupe --all
trce diff review
```

Replace `review` with a skill name from your report. Reports cover 30 days by default;
`--since` accepts `1d` through `3650d`. These commands are offline and need no account.

Claude Code and Codex provide usage evidence. Cursor provides inventory only. Inferred reads and
token estimates are not measures of skill quality. For scripts, use JSON output; set `NO_COLOR=1`
to disable terminal colors.

## Connect to trce

With [workspace access](https://trce.sh?utm_source=github&utm_medium=referral&utm_campaign=cli&utm_content=usage),
follow the app's setup instructions, then link and inspect your first report:

```sh
trce init --no-hooks
trce push --dry-run
trce push
```

Confirm the code in your browser. Add `--no-browser` on a headless machine.
Dry-run fetches repository scope but uploads no report.

Run `trce init --hooks-only` to report automatically after sessions. Plain `trce init` links
and installs hooks together. `trce init --remove` removes trce's hooks but keeps the machine link.
See [Privacy](../PRIVACY.md#unlink-or-remove) to revoke access.

For a local dashboard, pass `--url http://localhost:3000` to `init`.
`TRCE_URL` also sets the origin; `--url` takes precedence.

## Manage installed skills

Install commands require a machine link. Personal installs also need `gh auth login`;
Shared installs use workspace access. Replace this example with a skill you can access:

```sh
trce add acme/skills:skills/review --harness claude --dry-run
trce add acme/skills:skills/review --harness claude
trce update review --dry-run
trce update review
trce remove review --dry-run
trce remove review
```

Omit `--harness` to install for both Claude Code and Codex. `--ref` selects a Git revision.
Add `--shared` for a configured team library. Cursor installation is not supported.

Updates stop on local edits or missing managed files. Removal prints the location of the recoverable
copy. There is no update rollback command; save your own edits before resolving a conflict.

For a reviewed team change, copy the command from the app's **Finish on your machine** dialog.
A waiting-change notice means that machine holds files needed for the approved PR.
Review the resulting diff in GitHub before merging.

## Troubleshooting

- **No sessions:** check the reported directories and widen the window with `--since 90d`.
  If you moved agent homes, check `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
- **Not linked:** run `trce init --no-hooks` and confirm the code.
- **No connected repositories:** finish repository setup in the app, then push again.
- **Connection refused:** check the origin in the error and whether your local app is running.
- **Expired code or revoked link:** run `trce init` for a fresh link.
- **Update refused local edits:** save your changes and compare them with the source before retrying.
- **Install records locked:** wait for the other trce command to finish. After an interrupted
  command, and only when no trce command is running, run `rmdir ~/.trce/installs.lock` and retry.

See [Support](../SUPPORT.md) for other problems. Remove private data before posting a report.

## Commands

```text
  init         Link this machine and install background hooks
  report       Show local skill activity and issues
  dedupe       Find likely and possible duplicate pairs
  diff         Compare installed copies of one skill
  push         Send metadata for connected repositories (--dry-run prints it)
  add          Install a Personal or Shared skill on this machine
  update       Update skills installed with add
  remove       Remove a skill installed with add (kept in a local trash)
  promote      Finish a Share with team or Add to repository review
  unify        Finish a Standardize review
  hook         Internal: run by the background hooks, not for interactive use
```

Exit codes: `0` success, `1` error, `2` required machine link missing.
