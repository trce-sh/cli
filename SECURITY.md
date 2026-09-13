# Security policy

## Report a vulnerability

Do not open a public issue for a problem that could expose local agent data, device tokens, skill
contents, repository access, or package publishing credentials.

Contact [hi@trce.sh](mailto:hi@trce.sh). Include the CLI version, affected command, impact, and a
sanitized reproduction. Do not attach native session
files, prompts, responses, source code, diffs, `.env` files, auth tokens, or local paths.

## Security invariants

- `report`, `dedupe`, and `diff` stay offline. Networked commands are named in help and the README.
- Only skill metadata is sent to trce. The one machine identifier is the short hostname, sent by
  `init` at link time as the default machine label so a team can tell machines apart.
  Prompts, responses, code, diffs, file paths outside skill directories,
  and shell arguments are never sent. [Privacy](PRIVACY.md) explains what is sent and links to the field-level contract.
- `push --dry-run` is byte-for-byte equal to the request body sent by `push`.
- The payload boundary rejects unknown fields and forbidden content.
- Device tokens never appear in payloads, logs, or command output.
- Native records and full skill instructions never enter trce. Reviewed skill files move directly
  between the machine and GitHub.
- npm publishing remains disabled until a separate release approval.
