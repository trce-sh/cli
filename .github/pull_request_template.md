## What changed

Describe the user-visible change and why it belongs in the CLI.

## Verification

- [ ] `pnpm run verify`
- [ ] `pnpm run smoke:package`
- [ ] User-visible changes have a `CHANGELOG.md` entry under `[Unreleased]`, or no entry is needed
- [ ] New parser behavior has a sanitized fixture and golden test
- [ ] Network payload changes have exact privacy-boundary tests
- [ ] No prompt, response, source, diff, credential, local path, or private repository data is included
