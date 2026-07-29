# Security policy

## Supported versions

Security fixes are applied to the current `main` branch before a stable support
policy is published. Do not rely on a development snapshot for a security fix.

## Reporting a vulnerability

Please use the repository's private security-advisory reporting channel. If it
is unavailable, open a minimal public issue asking for a private contact path;
do not include exploit details, data, routes, screenshots, credentials, or a
reproduction archive in that issue.

Include only the minimum information needed to assess impact: affected commit
or release, component, preconditions, concise reproduction steps using
synthetic input, and a proposed mitigation if one is known. Do not attach a
database, export, backup, browser trace, or an image built from a machine that
has handled private data.

The maintainers will acknowledge a report, assess severity and affected
releases, coordinate a fix and disclosure, and credit reporters only with their
permission. Response times are targets, not guarantees, while the project is
pre-1.0.

## Security boundaries

- Velograph is local-first. The supported API binds to loopback; LAN or
  internet exposure is unsupported because authentication is not implemented.
- The container deployment publishes only to host loopback and stores state in
  a local Docker volume. It does not mount source exports, Codex credentials,
  or host home directories.
- AI is disabled by default. When configured, it receives the reviewed,
  minimized payload rather than raw exports, route coordinates, local notes, or
  credentials.
- Public repository content, build artifacts, CI logs, and container layers are
  all privacy boundaries. Only synthetic fixtures are permitted.

## Sensitive-data incident

Treat any committed or published private data as exposed, even if it is later
deleted. Follow [the privacy incident response runbook](docs/privacy-incident-response.md)
immediately; do not paste the sensitive value into an issue, commit, CI log, or
chat transcript.
