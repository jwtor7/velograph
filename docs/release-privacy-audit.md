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
node scripts/privacy-audit-release.mjs --oci-image path/to/velograph-multiarch.oci.tar
```

The artifact command accepts a file or an already-extracted artifact directory.
It intentionally fails closed for archive/database/data-shaped formats; do not
put restricted data into a release archive merely to make the scanner pass.
History, artifact, and container entries larger than 64 MiB fail closed instead
of being skipped or buffered without a limit.

The native-image command streams layers from `docker image save` without
extracting their paths into the checkout. It scans the application-owned
payload (`/app` plus the checked-in entrypoint and relay) in every layer. The
pinned upstream base image is covered separately by the generated SBOM and
digest review. The OCI command validates both required platforms, verifies
every consumed blob digest, scans the same application payload in the exact
multi-architecture output, and requires both SBOM and provenance attestations
for each platform. Reports contain only a rule and opaque audit identifier,
never a matched value or host path.

During the image build, the API deployment is audited before it enters the
runtime stage. The build removes only reviewed install-time material: the
`tar-fs` invalid-archive fixture, package-manager metadata/source backlink, and
the native addon's compiler sources/tests/docs after its lifecycle build has
completed. Any different archive or development package fails the build. One
locked public `bindings@1.5.0` source comment has a hash-gated false-positive
waiver; changed bytes are scanned normally.

The history command walks all refs available locally. CI checks out complete
history before running it. For a full forensic audit, fetch every retained
branch/tag and audit the repository mirror; refs deleted from every available
remote cannot be rediscovered by a normal checkout.

## CI workflow

`release-governance.yml` performs the worktree/history audit, a native image
build followed by application-layer audit, and an independent
multi-architecture Buildx build with SBOM/provenance attestations. CI audits
that exact OCI archive, records its SHA-256 plus image index, and retains the
three files together for 14 days. CI does not publish an image or mount source
exports. Any publication step must use the audited output and run only after a
maintainer reviews its digests and SBOM.

## Operator checklist

1. Build from a clean checkout using the checked-in `.dockerignore`.
2. Inspect the generated SBOM, provenance, and dependency/licence changes.
3. Audit the exact OCI archive that will be published, verify its recorded
   SHA-256, and review the platform manifest digests in its retained index.
4. Confirm no Compose override mounts a source export, credential cache, home
   directory, or path inside the checkout.
5. Retain only safe evidence: commit, OCI archive checksum, platform image
   digests, attestations, scanner result, and CI run link. If the audit fails,
   follow
   `docs/privacy-incident-response.md`.
