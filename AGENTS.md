# Repository Guidelines

## Project Structure & Module Organization

Velograph is in Phase 0: the repository contains the source-of-truth `Velograph-PRD.md`, `CLAUDE.md`, a default-deny `.gitignore`, and cover artwork. No application or test tree exists yet. When scaffolding the TypeScript/pnpm monorepo, place the React client and loopback Node.js API under `apps/`, reusable code under `packages/`, and invented test inputs under `fixtures/synthetic/`. Keep analytics free of framework, database, network, and LLM dependencies. Define module ownership before concurrent work.

## Build, Test, and Development Commands

There is no package manifest or build system yet. For documentation-only changes, run:

- `git diff --check` — detect whitespace errors.
- `git status --short` — review exactly what will be committed.

Once `package.json` exists, document standard scripts such as `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`. Run only declared scripts.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, and small modules with explicit boundaries. Use `camelCase` for values/functions, `PascalCase` for components and exported types, and descriptive kebab-case filenames. Store canonical data in SI units and absolute instants; convert only for display. AI may explain deterministic results but must never calculate metrics, charts, or route geometry.

## Testing Guidelines

No test framework or numeric coverage threshold is selected. Add proportionate unit, parser contract, ordered migration, deterministic golden, offline end-to-end, and accessibility tests. Use invented values, dates, filenames, and routes only beneath `fixtures/synthetic/`. Never use real exports, health data, GPS traces, or credentials.

## Commit & Pull Request Guidelines

There is no commit history from which to infer a convention. Start from a typed, prioritized issue; reference relevant PRD requirement IDs; and use `<agent>/<issue>-<short-description>` branches. Write imperative, issue-linked squash titles. Pull requests must state scope, tests and evidence, privacy/data-handling impact, dependency/licence impact, and migration rollback notes. Include synthetic-only UI screenshots and attest that no real health, location, account, credential, or user data is present. Never push directly or force-push to `main`.

## Security & Local-First Boundaries

This is a public repository. Keep `VELO_DATA_DIR` outside the checkout, bind to `127.0.0.1` by default, and preserve offline operation. Never bypass `.gitignore` with `git add -f`; avoid committing logs, databases, archives, environment files, or local absolute paths.
