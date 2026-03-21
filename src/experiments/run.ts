#!/usr/bin/env tsx
/**
 * run.ts — CLI runner for AKP multi-agent experiments.
 *
 * Usage:
 *   npx tsx src/experiments/run.ts [options]
 *
 * Options:
 *   --experiment <E1-E9|all>    Which experiment(s) to run (default: all)
 *   --provider <name>           LLM backend: jan|claude|openai|gemini|openrouter
 *                               Defaults to auto-detect from env vars, then jan.
 *   --model <id|auto>           Model ID for the chosen provider (default: provider default)
 *   --rounds <n>                Override default round count
 *   --sybils <n>                E3/E6: number of Sybil agents (default: 10)
 *   --agents <n>                E4: number of peer agents (default: 5)
 *   --verbose                   Log per-agent actions
 *   --json                      Output raw JSON summary instead of formatted table
 *
 * Examples:
 *   # Fast deterministic run (no LLM needed)
 *   npx tsx src/experiments/run.ts
 *
 *   # Jan (local, OpenAI-compatible)
 *   npx tsx src/experiments/run.ts --provider jan --model auto
 *
 *   # Claude
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/experiments/run.ts --provider claude
 *
 *   # OpenAI
 *   OPENAI_API_KEY=sk-... npx tsx src/experiments/run.ts --provider openai --model gpt-4o-mini
 *
 *   # Gemini
 *   GEMINI_API_KEY=... npx tsx src/experiments/run.ts --provider gemini
 *
 *   # OpenRouter (free models)
 *   OPENROUTER_API_KEY=... npx tsx src/experiments/run.ts --provider openrouter
 */

import {
  EXPERIMENTS,
  experimentE1ConsensusFormation,
  experimentE2AdversarialDetection,
  experimentE3SybilResistance,
  experimentE4KnowledgeQualityEvolution,
  experimentE5StalenessDetection,
  experimentE6LargeScaleSybil,
  experimentE7ContradictionInjection,
  experimentE8CrossArchitecture,
  experimentE9TemporalDecay,
  type ExperimentKey,
} from './experiments.js'
import type { MetricsCollector, ExperimentSummary } from './metrics.js'
import { resolveBackend, detectProvider, type Provider } from '../pipeline/stage3-backends.js'
import type { LLMAgent } from '../pipeline/stage3.js'

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
  }
  const has = (flag: string) => args.includes(flag)

  return {
    experiment: (get('--experiment', 'all') as ExperimentKey | 'all'),
    provider: get('--provider') as Provider | undefined,
    model: get('--model'),
    rounds: get('--rounds') ? parseInt(get('--rounds')!) : undefined,
    sybils: get('--sybils') ? parseInt(get('--sybils')!) : undefined,
    agents: get('--agents') ? parseInt(get('--agents')!) : undefined,
    verbose: has('--verbose'),
    json: has('--json'),
  }
}

// ── Table printer ─────────────────────────────────────────────────────────────

function printSummaryTable(results: Array<{ key: string; name: string; summary: ExperimentSummary }>) {
  const pct = (v: number) => isNaN(v) ? '  n/a' : `${(v * 100).toFixed(1)}%`
  const f2  = (v: number) => isNaN(v) ? '  n/a' : v.toFixed(2)

  console.log('\n' + '═'.repeat(110))
  console.log('  AKP MULTI-AGENT EXPERIMENT RESULTS')
  console.log('═'.repeat(110))
  console.log(
    '  ' +
    'Exp'.padEnd(5) +
    'Name'.padEnd(32) +
    'Rounds'.padEnd(8) +
    'Commits'.padEnd(10) +
    'Accuracy'.padEnd(11) +
    'Consensus'.padEnd(12) +
    'Gini'.padEnd(8) +
    'Blacklist'.padEnd(11) +
    'Confidence'
  )
  console.log('─'.repeat(110))

  for (const { key, name, summary: s } of results) {
    console.log(
      '  ' +
      key.padEnd(5) +
      name.padEnd(32) +
      String(s.rounds).padEnd(8) +
      String(s.totalCommits).padEnd(10) +
      pct(s.verdictAccuracyRate).padEnd(11) +
      `${f2(s.meanConsensusLatencyRounds)} rds`.padEnd(12) +
      f2(s.reputationGini).padEnd(8) +
      pct(s.blacklistRate).padEnd(11) +
      f2(s.meanFinalConfidence)
    )
  }
  console.log('═'.repeat(110))
  console.log()
}


// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()

  let stopBackend: (() => Promise<void>) | undefined
  let llmAgent: LLMAgent | undefined

  // Activate LLM backend if --provider or --model is given, or if an API key is set
  const explicitProvider = args.provider ?? (args.model ? 'jan' : undefined)
  const provider = explicitProvider ?? (
    process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY
      ? detectProvider()
      : undefined
  )

  if (provider) {
    console.log(`\nInitializing LLM backend: ${provider}`)
    const backend = await resolveBackend({ provider, model: args.model })
    llmAgent = backend.agent
    stopBackend = backend.stop
    console.log(`  Ready: ${backend.label}`)
  }

  // Select experiments to run
  const toRun: ExperimentKey[] = args.experiment === 'all'
    ? ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9']
    : [args.experiment as ExperimentKey]

  const commonOpts = {
    llmAgent,
    rounds: args.rounds,
    verbose: args.verbose,
  }

  const results: Array<{ key: string; name: string; summary: ExperimentSummary; metrics: MetricsCollector }> = []

  try {
    for (const key of toRun) {
      const exp = EXPERIMENTS[key]
      console.log(`\nRunning ${key}: ${exp.name}...`)
      const start = Date.now()

      let metrics: MetricsCollector

      switch (key) {
        case 'E1': metrics = await experimentE1ConsensusFormation(commonOpts); break
        case 'E2': metrics = await experimentE2AdversarialDetection(commonOpts); break
        case 'E3': metrics = await experimentE3SybilResistance({ ...commonOpts, sybilCount: args.sybils }); break
        case 'E4': metrics = await experimentE4KnowledgeQualityEvolution({ ...commonOpts, agentCount: args.agents }); break
        case 'E5': metrics = await experimentE5StalenessDetection(commonOpts); break
        case 'E6': metrics = await experimentE6LargeScaleSybil({ rounds: args.rounds, sybilCount: args.sybils, verbose: args.verbose }); break
        case 'E7': metrics = await experimentE7ContradictionInjection(commonOpts); break
        case 'E8': metrics = await experimentE8CrossArchitecture(commonOpts); break
        case 'E9': metrics = await experimentE9TemporalDecay({ rounds: args.rounds, verbose: args.verbose }); break
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`  Done in ${elapsed}s`)

      results.push({ key, name: exp.name, summary: metrics.summary(), metrics })
    }
  } finally {
    await stopBackend?.()
  }

  // Output
  if (args.json) {
    console.log(JSON.stringify(results.map(r => r.summary), null, 2))
  } else {
    printSummaryTable(results)
    for (const { metrics } of results) {
      metrics.printSummary()
    }
  }
}

main().catch(err => {
  console.error('Experiment failed:', err)
  process.exit(1)
})
