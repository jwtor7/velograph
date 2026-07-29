# CI supply-chain: pinned action SHAs

PRD §14 (supply chain) and §16.3 (required merge gates) require every
third-party GitHub Action used in `.github/workflows/` to be pinned to a
full 40-character commit SHA, not a floating tag (`@v4`) or even an
immutable-looking release tag (`@v4.4.0`). Tags can be moved by the
upstream maintainer (accidentally or maliciously) to point at different
code without any change in this repository; a commit SHA cannot.

## Current pins

| Action                       | Pinned SHA                                 | Release tag |
| ---------------------------- | ------------------------------------------ | ----------- |
| `actions/checkout`           | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0      |
| `pnpm/action-setup`          | `fc06bc1257f339d1d5d8b3a19a8cae5388b55320` | v4.4.0      |
| `actions/setup-node`         | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0      |
| `gitleaks/gitleaks-action`   | `ff98106e4c7b2bc287b24eaf42907196329070c7` | v2.3.9      |
| `docker/setup-qemu-action`   | `96fe6ef7f33517b61c61be40b68a1882f3264fb8` | v4.0.0      |
| `docker/setup-buildx-action` | `bb05f3f5519dd87d3ba754cc423b652a5edd6d2c` | v4.0.0      |
| `docker/build-push-action`   | `53b7df96c91f9c12dcc8a07bcb9ccacbed38856a` | v7.0.0      |
| `actions/upload-artifact`    | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | v7.0.1      |

Each `uses:` line in `.github/workflows/` carries the SHA plus a
trailing `# vX.Y.Z` comment with the human-readable tag it corresponds to,
e.g.:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

The comment is documentation only — GitHub Actions always resolves and
runs the SHA, never the comment text.

## How to review and update a pin

1. **Identify the new release** you want to move to (from the action's
   GitHub releases page or its `CHANGELOG`). Read the diff/release notes
   before updating — this step is the actual security review; the SHA
   pin only makes that review durable.
2. **Resolve the tag to a commit SHA** using the GitHub API rather than
   trusting a copy-pasted value from a blog post or README:

   ```sh
   gh api repos/<owner>/<repo>/git/ref/tags/<tag>
   ```

   The response's `object.sha` is the commit if `object.type` is
   `"commit"`. If `object.type` is `"tag"` instead, the tag is
   **annotated** and must be dereferenced one more step to reach the
   commit it actually points at:

   ```sh
   gh api repos/<owner>/<repo>/git/tags/<object.sha-from-previous-step>
   ```

   That response's `object.sha` (with `object.type: "commit"`) is the
   value to pin. `pnpm/action-setup` uses annotated tags and needs this second
   step; `actions/checkout`, `actions/setup-node`, `gitleaks/gitleaks-action`,
   and the Docker actions currently use lightweight tags that resolve directly
   to a commit.

3. **Update the affected `.github/workflows/` file**: replace the SHA and the trailing
   `# vX.Y.Z` comment together so they never drift out of sync. Update the
   table in this document to match.
4. **Open a normal reviewed PR** with the diff (old SHA/tag → new SHA/tag)
   and let CI run against the new pin before merging. Never pin to a SHA
   that hasn't actually run green in this repository's CI at least once.

## Adding a new third-party action

Follow the same steps above for the new action, add both a table row here
and the pinned `uses:` line with its trailing tag comment, and note in the
PR description why the action is needed and what permissions/secrets it
touches.

## Container and runtime verification

`ci.yml` retains the primary Node 22 checks and also performs separate clean,
frozen-lockfile installs on Node 20.19 (the supported minimum) and Node 26.
Both runtime lanes build the API and CLI from the complete audited web artifact,
verify deterministic checked-in outputs, and clean-install both tarballs. The
release-governance workflow audits the worktree and all reachable Git blobs,
builds and layer-audits a native container, smoke-tests its published loopback
ingress with an empty synthetic data mount, verifies clean shutdown, then
creates and audits one exact OCI image index for `linux/amd64` and `linux/arm64`
with BuildKit SBOM and provenance attestations enabled for both platforms. CI
retains that audited OCI archive, its SHA-256, and its image index together for
14 days so review and any later publication refer to the same bytes and
digests. The workflow has read-only repository permission and never logs in to
a registry, mounts credentials, or publishes an image.

The Dockerfile also pins its official Node base-image tag to a reviewed
multi-architecture digest. Its runtime stage copies only the built web client
inside the API production deployment; build tooling, repository fixtures, and
development dependency trees remain in the discarded build stage. A
fail-closed pruning step removes reviewed install-only package material after
native lifecycle scripts run, and the resulting deployment is privacy-scanned
before the runtime copy. Update the human-readable base tag and digest
together, then re-run the exact OCI privacy audit and SBOM build before
publishing.

Dependency metadata and generated SBOMs are not the licence authority on their
own. `pnpm license:check` compares the exact web/API/CLI production closures with
the reviewed manifest, installed SPDX metadata, and hashed authoritative
licence texts. It also covers Vite's injected browser polyfill and SQLite
embedded in the native addon. The Docker build verifies the physical API
deployment and browser artifact. The native/OCI audits reconstruct and
re-verify the final web file hashes and package evidence, require byte-exact
canonical notices in both final application paths, and require the native Node
and `tini` notice files on every platform. The pinned image digest and
per-platform SBOM cover the remaining operating-system inventory. See the
[third-party licence guide](third-party-licences.md).
