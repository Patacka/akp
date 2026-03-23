#!/usr/bin/env tsx
/**
 * multi-model-sweep.ts — Run E1, E2, E7 with a specific Jan model and save results.
 *
 * Usage (load the target model in Jan first, then):
 *
 *   npx tsx src/experiments/multi-model-sweep.ts \
 *     --model Mistral-7B-Instruct-v0_3_IQ4_XS \
 *     --label "Mistral-7B"
 *
 *   # Use auto-detected model (whatever is loaded in Jan):
 *   npx tsx src/experiments/multi-model-sweep.ts --label "Llama-3.1-8B"
 *
 * Results are written to results/sweep-<safe-label>.json.
 * Run once per model, then use multi-model-report.ts to aggregate.
 *
 * Experiments run:
 *   E1 — Consensus Formation      (tests LLM verdict quality in a cooperative setting)
 *   E2 — Adversarial Detection    (tests LLM resilience when 2/5 agents are adversarial)
 *   E7 — Contradiction Injection  (tests LLM ability to detect a deliberately wrong claim)
 *
 * These three are chosen because they are the most sensitive to LLM reasoning quality.
 * E3/E6 (Sybil) and E9 (Temporal) use deterministic fallback logic independent of LLM.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  experimentE1ConsensusFormation,
  experimentE2AdversarialDetection,
  experimentE7ContradictionInjection,
} from './experiments.js'
import { resolveBackend } from '../pipeline/stage3-backends.js'
import type { ExperimentSummary } from './metrics.js'

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
  }
  return {
    model:   get('--model'),                    // Jan model ID, undefined = auto-detect
    label:   get('--label') ?? get('--model') ?? 'unknown',
    rounds:  get('--rounds') ? parseInt(get('--rounds')!) : undefined,
    verbose: args.includes('--verbose'),
  }
}

function safeName(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').toLowerCase()
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()

  console.log('\n══════════════════════════════════════════════════════════')
  console.log(`  AKP Multi-Model Sweep — ${args.label}`)
  console.log('══════════════════════════════════════════════════════════')
  console.log(`  Jan model  : ${args.model ?? '(auto-detect)'}`)
  console.log(`  Experiments: E1, E2, E7`)
  console.log()

  // Connect to Jan
  const backend = await resolveBackend({ provider: 'jan', model: args.model })
  console.log(`  Backend ready: ${backend.label}\n`)

  const llmAgent = backend.agent
  const commonOpts = { llmAgent, rounds: args.rounds, verbose: args.verbose }

  const results: Record<string, ExperimentSummary> = {}

  try {
    for (const [key, fn] of [
      ['E1', () => experimentE1ConsensusFormation(commonOpts)],
      ['E2', () => experimentE2AdversarialDetection(commonOpts)],
      ['E7', () => experimentE7ContradictionInjection(commonOpts)],
    ] as Array<[string, () => Promise<{ summary(): ExperimentSummary }>]>) {
      console.log(`Running ${key}...`)
      const start = Date.now()
      const metrics = await fn()
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const s = metrics.summary()
      results[key] = s
      const pct = (v: number) => isNaN(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`
      console.log(`  Done in ${elapsed}s  |  accuracy=${pct(s.verdictAccuracyRate)}  conf=${s.meanFinalConfidence.toFixed(2)}  gini=${s.reputationGini.toFixed(2)}`)
    }
  } finally {
    await backend.stop()
  }

  // Save results
  const output = {
    label: args.label,
    janModelId: backend.label.replace('jan/', ''),
    timestamp: new Date().toISOString(),
    results,
  }

  mkdirSync('results', { recursive: true })
  const outPath = join('results', `sweep-${safeName(args.label)}.json`)
  writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`\nSaved → ${outPath}`)

  // Quick summary
  const pct = (v: number) => isNaN(v) ? ' n/a ' : `${(v * 100).toFixed(1)}%`
  console.log('\n  ┌──────┬───────────┬───────────┬───────────┬──────────┐')
  console.log('  │ Exp  │ Accuracy  │  RevealOK │  Conf     │  Gini    │')
  console.log('  ├──────┼───────────┼───────────┼───────────┼──────────┤')
  for (const [key, s] of Object.entries(results)) {
    console.log(
      `  │ ${key.padEnd(4)} │ ${pct(s.verdictAccuracyRate).padStart(7)}   │` +
      ` ${pct(s.revealSuccessRate).padStart(7)}   │` +
      ` ${s.meanFinalConfidence.toFixed(2).padStart(7)}   │` +
      ` ${s.reputationGini.toFixed(2).padStart(6)}   │`
    )
  }
  console.log('  └──────┴───────────┴───────────┴───────────┴──────────┘\n')
}

main().catch(err => {
  console.error('Sweep failed:', err)
  process.exit(1)
})
