# Privacy incident response

Use this runbook when restricted data, a credential, or an unsafe artifact may
have entered a commit, pull request, CI log, release, package, container image,
backup, or public link. A deletion is not remediation: treat the item as
exposed as required by PRD §12.2.

## Immediate containment

1. Stop publication and disable any affected CI/release workflow. Do not run a
   broad cleanup that could overwrite evidence.
2. Restrict access to the affected artifact or registry tag if possible. Record
   only opaque identifiers, timestamps, and hashes in the incident record;
   never repeat private content in tickets or chat.
3. Revoke or rotate exposed credentials and invalidate sessions, bridge tokens,
   signing material, or provider access as applicable.
4. Preserve a minimal private evidence record: discovery time, discovery
   channel, affected commit/artifact identifiers, classification, and actions
   taken. Keep it outside the public repository.

## Scope and eradicate

1. Audit every relevant ref, release asset, container digest, CI artifact/log,
   package registry version, cache, and fork or mirror under maintainer
   control. Use the history/artifact/container workflow in
   `docs/release-privacy-audit.md`; do not paste matched values into its output.
2. Identify whether data was merely local, committed, uploaded, released, or
   accessed. Assume any public or third-party copy is a disclosure.
3. Remove current working-tree copies and revoke public distribution. For Git,
   use a reviewed history-rewrite plan only after preserving the private
   incident evidence; coordinate force-pushes with repository administrators.
4. Invalidate affected release tags, images, packages, SBOMs, checksums, and
   download links. Publish a new version rather than silently replacing a
   released artifact.

## Notify and recover

1. Notify affected people and required authorities according to the nature of
   the data and applicable obligations. State what is known, what was removed,
   what cannot be recalled, and which credentials were rotated.
2. Publish a minimal security notice when it is safe to do so. Never include
   the leaked value, a real route, sample records, or a link to retained
   sensitive content.
3. Add a regression test or scanner rule using an invented marker, not the
   original data. Re-run privacy scans over the repaired history, exact
   artifacts, and exact container image before resuming publication.
4. Record root cause and preventive action in the private incident record, then
   update public process documentation only with non-sensitive lessons.

## Escalation rule

If you cannot prove an artifact is clean, do not publish it. If you cannot
prove the scope of a credential exposure, rotate it. If you cannot purge an
external copy, say so plainly in the incident record and notification plan.
