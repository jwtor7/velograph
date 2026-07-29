# Release privacy audit

Public delivery has more surfaces than the checked-out files. PRD §18 requires
the public Git history, CI artifacts, release assets, and container layers to
be clean. Run the following checks against the exact commit and image intended
for publication; a prior green run does not qualify a later build.

## Required commands

```sh
node scripts/privacy-audit-release.mjs --working-tree
node scripts/privacy-audit-release.mjs --history
node scripts/privacy-audit-release.mjs --artifact path/to/extracted-release-output
node scripts/privacy-audit-release.mjs --image velograph:local
```

The artifact command accepts a file or an already-extracted artifact directory.
It intentionally fails closed for archive/database/data-shaped formats; do not
put restricted data into a release archive merely to make the scanner pass. The
container command streams image layers from `docker image save` without
extracting their paths into the checkout. It scans every regular file in each
layer and reports only a rule and synthetic audit path, never a matched value.

The history command walks all refs available locally. CI checks out complete
history before running it. For a full forensic audit, fetch every retained
branch/tag and audit the repository mirror; refs deleted from every available
remote cannot be rediscovered by a normal checkout.

## CI workflow

`release-governance.yml` performs the worktree/history audit, a native image
build followed by image-layer audit, and an independent multi-architecture
Buildx verification with SBOM/provenance attestations. CI does not publish an
image, upload a private artifact, or mount source exports. Any publication step
must run only after a maintainer reviews the exact image digest and SBOM.

## Operator checklist

1. Build from a clean checkout using the checked-in `.dockerignore`.
2. Inspect the generated SBOM and dependency/licence changes.
3. Audit the exact image tag/digest that will be published, not an earlier
   local tag.
4. Confirm no Compose override mounts a source export, credential cache, home
   directory, or path inside the checkout.
5. Retain only safe evidence: commit, image digest, SBOM digest, scanner result,
   and CI run link. If the audit fails, follow
   `docs/privacy-incident-response.md`.
