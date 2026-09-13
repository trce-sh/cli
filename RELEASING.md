# Releasing @trce/cli

This checklist is for maintainers. Keep the package private and on a development version until
a release is approved. Remote creation, visibility changes, pushes, and publication require approval.
Passing `release:check` validates metadata; it does not prove app compatibility or authorize release.

## Integration gate

Run these checks with the installed local binary and a localhost dashboard, then repeat them
with the packed release candidate against the hosted service. Record evidence with the release
review, not as a running status log in the product documentation.

- Confirm the CLI and dashboard agree on fingerprints for SKILL.md and full directories, including
  file ordering, CRLF text, binary files, and executable modes. Inventory, installs, reviewed
  actions, and drift reconciliation must use the same contract.
- Check that dashboard privacy validation rejects the same forbidden metadata as the CLI fixtures.
- Link a machine, inspect `push --dry-run`, push, and replay the same sessions. Counts must not
  increase on replay. Verify attribution from a second developer and machine revocation.
- Complete real Claude Code and Codex sessions and confirm each completion hook reports them.
  Include a project-relative Codex skill read and a failed Claude Skill call. Check attribution
  and outcomes against the native records, not just the agent's final answer.
- Check hook coexistence with an existing notifier, repeated callbacks, and a moved CLI install.
  Hooks must not recurse, accumulate package-manager processes, or download a fallback package.
- Test Shared add, update, and removal, including local edits and recovery from trash.
- Finish reviewed sharing and standardization, inspect the GitHub pull request, and confirm
  dashboard reconciliation. Replacing or deleting auxiliary files remains blocked until reviewed
  actions attest the whole directory, not just SKILL.md.

Use disposable test data. Unit tests and synthetic parser benchmarks do not replace these checks.

## Repository and publisher setup

- Review every tracked file and run a secret scan. Include no private application source, history,
  session data, credentials, or local review artifacts. Verify licenses for non-code assets.
- After approval, prepare `trce-sh/cli` privately with only the reviewed history. Require Node 22
  CI on Linux, macOS, and Windows before making the repository public.
- Finish dependency review and integration testing before the history cutover. Keep a recovery
  copy outside the public repository. A force-push does not remove GitHub's read-only PR references;
  use a fresh repository if development commits must not remain accessible through old PRs.
- Configure branch and tag protection, required CI, private vulnerability reporting, Dependabot,
  and the available secret-scanning and push-protection settings.
- Use squash-only merges and read-only workflow tokens. Require approval for external-contributor
  workflows and pin Actions to reviewed commit hashes. Review major dependency upgrades separately;
  keep Node types aligned with the supported runtime.
- Protect the GitHub `npm` environment. Confirm ownership of `@trce/cli` and the `@trce` scope,
  maintainer two-factor authentication, and npm Trusted Publisher settings for owner `trce-sh`,
  repository `cli`, workflow `publish.yml`, and environment `npm`. Do not store an npm token.
- Some protections depend on visibility and plan. Recheck them after transfer and visibility
  changes. Keep release tags blocked from the `npm` environment until reviewer protection is
  available and configured; then allow only `v*` tags.

## Prepare a release

1. Complete the integration gate with the packed candidate against the hosted service, including
   the owner and second-developer flows. Obtain approval for the release and public visibility.
2. Check that repository metadata, README badges, clone instructions, and issue links point to
   `trce-sh/cli` after transfer. Replace the README's source-install note with the approved npm
   installation command only when that package is available.
3. Remove `private` from `package.json` and set the approved stable version. Move the changelog's
   `[Unreleased]` entries under that version and date, leaving an empty `[Unreleased]` section.
4. Run these commands sequentially from the repository root. Package checks rebuild `dist/`.

   ```sh
   pnpm install --frozen-lockfile
   pnpm run verify
   pnpm audit
   pnpm run release:check
   pnpm run smoke:package
   pnpm run benchmark
   pnpm run pack:check
   ```

5. Inspect the tarball. Only compiled `dist/` modules, the two logo SVGs, `CHANGELOG.md`, `LICENSE`,
   `PRIVACY.md`, `README.md`, and npm's package metadata may ship. No source maps, runtime
   dependencies, or install-time scripts are allowed.
6. Commit the release, merge to protected `main`, and create the matching `v<version>` GitHub
   release. The publish workflow uses npm trusted publishing with provenance.
7. Confirm the workflow's package version and npm provenance. Publishing is not undone by deleting
   a Git tag; a faulty package needs an approved deprecation or corrective release.

## Verify the published package

Run outside every trce checkout on a clean Node 22 machine:

```sh
npx --yes @trce/cli@latest --version
npx --yes @trce/cli@latest report
npm install --global @trce/cli@latest
trce --version
trce report
```

Both entry points must show the released version. Local reports must work without an account or
network request. Repeat the integration gate against the hosted service with the published binary.

Deprecating any older npm release or archiving another repository is a separate, approved task.
