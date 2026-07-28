<p align="center">
  <img src="velograph_cover_art.png" alt="Velograph — turn Apple Health cycling data into clear visuals and AI-powered insights" width="100%">
</p>

# Velograph

**Turn Apple Health cycling data into clear visuals and AI-powered insights that help you understand every ride.**

Velograph is an open-source, local-first web app for cyclists. It imports Apple Health cycling exports (via [Health Auto Export](https://www.healthyapps.dev/) CSV/GPX/ZIP), stores them in a local SQLite database, calculates deterministic ride and conditioning metrics, reconstructs your routes entirely offline, and — optionally — generates evidence-linked AI narratives through a locally installed Codex CLI or Ollama.

## Privacy stance

Your health data never leaves your machine unless you explicitly send it somewhere.

- **Local first.** All data lives in a local data directory (`VELO_DATA_DIR`) outside the source checkout, in SQLite you can inspect, back up, and delete.
- **Offline by default.** No telemetry, CDNs, remote fonts, map tiles, or geocoding. The app binds to `127.0.0.1` and renders every chart and route view without a network connection.
- **AI explains; it does not calculate.** Every number comes from the deterministic analytics engine. AI is disabled by default, never required, and receives only a versioned, minimized JSON payload — never raw time-series, coordinates, or source files.
- **Public repo, zero personal data.** Only synthetic fixtures (invented values, invented dates, invented routes) may enter this repository, enforced by a default-deny `.gitignore`, a pre-commit privacy scanner, and blocking CI checks.

## Quick start

> Velograph is under active development; the build system is landing now. Once scaffolding is complete:

```bash
pnpm install
pnpm dev        # starts the local API (127.0.0.1) and web client
pnpm test       # run the full test suite
```

Then open the printed local URL in your browser and import a Health Auto Export folder, files, or ZIP.

## Documentation

- [Product requirements (PRD)](Velograph-PRD.md) — the source of truth for all requirements
- [Repository guidelines](AGENTS.md) — structure, workflow, and privacy boundaries for contributors
- [Design system](docs/design-system.md) — palette, typography, and visual language

## License

License to be determined (Apache-2.0 recommended; see PRD §20). Until a license is published, all rights reserved.
