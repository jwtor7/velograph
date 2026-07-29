# Third-party licence and notices gate

Velograph does not currently have a project licence. The third-party notices
described here preserve upstream terms for distributed dependencies; they do
not grant any right to use Velograph itself.

## Canonical evidence

[`third-party-licenses.json`](../third-party-licenses.json) is the reviewed,
machine-readable inventory. Each entry pins the package or embedded component
name, exact version, declared and selected SPDX identifiers, runtime scope,
authoritative source file, normalized text byte count, and SHA-256. The
deduplicated normalized texts live in
[`third_party_licenses/`](../third_party_licenses/), and
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) is generated
deterministically from those two inputs.

The web package inventory deliberately covers its complete production
dependency graph. This includes a facade or transitive module even when the
current Rollup build tree-shakes all of its bytes. Two contributions require
additional evidence:

- Vite injects its module-preload polyfill into the browser bundle even though
  Vite is a build dependency. The builder records every contributing package
  module, rejects unknown virtual modules and unreviewed public assets, and
  hashes every emitted JavaScript, stylesheet, font, and HTML file. The
  artifact gate verifies that complete file set plus the compiled polyfill and
  includes Vite's authoritative installed notice file.
- `better-sqlite3` embeds SQLite. The workspace gate extracts SQLite's
  `blessing` text and exact version from the installed amalgamation header. The
  production-deployment gate also verifies that the retained native addon
  loads and reports the reviewed SQLite version.

## Required checks

Run the workspace gate after every dependency or lockfile change:

```sh
pnpm license:check
```

It fails when a runtime dependency is unreviewed or missing, a version or SPDX
declaration changes, a selected licence is outside the allowlist, an installed
or checked licence text changes, embedded evidence drifts, the canonical
notice is stale, or a project-level `LICENSE`/root `package.json` licence
appears without a policy change.

Build a distributable browser artifact with:

```sh
pnpm package:web
```

That command builds the client, copies the exact canonical notice into
`apps/web/dist`, and verifies the notice, exact output hashes, package-module
provenance, locally bundled font provenance, and Vite's injected-code
evidence. The container build separately copies the same notice into the API
deployment, follows nested package links, verifies every physically retained
production package and the native SQLite evidence, then reconstructs the final
web artifact from image layers and requires exact notices at both
`/app/api/THIRD_PARTY_NOTICES.md` and
`/app/web/dist/THIRD_PARTY_NOTICES.md` in each final image platform.

The canonical notice covers application-owned dependencies. The final image
also retains the official Node distribution licence at `/usr/local/LICENSE`
and Debian's `tini` copyright file at `/usr/share/doc/tini/copyright`; the
image audit requires both. The pinned base digest and per-platform SBOM remain
the inventory evidence for the rest of the operating-system layer.

## Reviewing a dependency change

1. Install from the frozen lockfile and inspect the complete web and API
   production closures. For the API, also inspect the physical output of
   `pnpm deploy --prod`; package-manager install helpers may remain there.
2. Review the dependency's installed `package.json` SPDX field and
   authoritative installed licence file. For an `OR` expression, record the
   licence actually selected and the file that supports that choice.
3. Update the sorted manifest with exact versions, hashes, sizes, and scopes.
   Add explicit embedded-component evidence for code not represented by the
   production package graph.
4. Regenerate checked texts and notices only from reviewed installed sources:

   ```sh
   node scripts/third-party-license-gate.mjs --sync-notices
   ```

   A pre-reviewed conditional dependency that is not installed in the current
   checkout must be supplied explicitly with `--package-root`; the command
   fails rather than inventing or silently retaining source evidence.

5. Review the complete diff. Run `pnpm license:check`, `pnpm package:web`, the
   production-deploy gate, privacy checks, and the exact container/OCI audits
   before release.

Do not weaken the allowlist, mark a dependency conditional, or change an
authoritative source path merely to make the gate pass. Those are review
decisions and must be justified in the pull request.
