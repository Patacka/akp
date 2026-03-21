# Contributing to AKP

Thanks for your interest. AKP is a research prototype — contributions that improve correctness, security, or experiment coverage are most welcome.

## Quick start

```bash
git clone <repo-url>
cd akp
npm run setup
npm test         # 266 tests, ~45s
```

## Before opening a PR

- **Tests must pass:** `npm test`
- **TypeScript must compile:** `npx tsc --noEmit`
- **New behaviour needs a test** — add it in `test/` next to the relevant module.

## Repository layout

```
src/
  cli/        CLI entry point (akp.ts)
  core/       KU store, graph, governance, confidence, identity
  pipeline/   Three-stage confidence pipeline (stage1–stage3)
  api/        JSON-RPC server, metrics, MCP transport
  sync/       WebSocket peer sync
  bench/      Benchmarks and calibration tools
  experiments/ E1–E9 experiment suite
test/         Mirrors src/ structure
ui/           React SPA (Vite, built to ../dist-ui/)
scripts/      setup.mjs, import-seed.ts
paper/        LaTeX source and PDFs
```

## Experiments

Experiments (E1–E9) live in `src/experiments/`. Each exports a `run(opts)` function returning `ExperimentResult`. To add a new experiment:

1. Create `src/experiments/eN-name.ts` following the pattern of an existing one.
2. Register it in `src/experiments/run.ts`.
3. Document it in the README experiments table.

Run with a real LLM:

```bash
npm run experiment -- --model auto   # requires Jan at localhost:1337
```

## Commit style

Plain imperative subject line, ≤72 chars:

```
fix: staleness detection prompt includes submission date
feat: add E10 cross-lingual claim consistency
```

## Opening issues

- **Bug:** include the experiment ID or test name and the full error output.
- **Research question:** describe the hypothesis and what measurement would confirm it.
- **Security:** see [SECURITY.md](SECURITY.md) — do not open a public issue.
