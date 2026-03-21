#!/usr/bin/env tsx
/**
 * run.ts — CLI runner for AKP multi-agent experiments.
 *
 * Usage:
 *   npx tsx src/experiments/run.ts [options]
 *
 * Options:
 *   --experiment <E1|E2|E3|E4|E5|all>   Which experiment(s) to run (default: all)
 *   --model <jan-model-id|auto>            Use Jan (localhost:1337) as LLM backend.
 *                                        Pass the Jan model ID or "auto" to use whatever Jan has loaded.
 *   --rounds <n>                         Override default round count
 *   --sybils <n>                         E3 only: number of Sybil agents (default: 10)
 *   --agents <n>                         E4 only: number of peer agents (default: 5)
 *   --verbose                            Log per-agent actions
 *   --json                               Output raw JSON summary instead of formatted table
 *
 * Examples:
 *   # Fast deterministic run (no LLM needed)
 *   npx tsx src/experiments/run.ts --experiment E1
 *
 *   # Run E2 with Jan (must have Jan open with a model loaded)
 *   npx tsx src/experiments/run.ts --model auto --experiment E2
 *
 *   # Run with a specific Jan model ID
 *   npx tsx src/experiments/run.ts --model llama3.1-8b-instruct --experiment E7
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
import {
  connectToJan,
  type LlamaCppServer,
} from '../pipeline/stage3-llamacpp.js'
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

// ── LLM setup ─────────────────────────────────────────────────────────────────

async function setupLlm(modelArg: string): Promise<{ server: LlamaCppServer; agent: LLMAgent }> {
  // modelArg is the Jan model ID (e.g. "llama3.1-8b-instruct").
  // Pass undefined to let Jan auto-detect the first loaded model.
  const modelId = modelArg === 'auto' ? undefined : modelArg
  console.log(`  Connecting to Jan at localhost:1337 (model: ${modelId ?? 'auto-detect'})`)
  const server = await connectToJan(modelId)
  const agent = server.createAgent('jan-reviewer')
  return { server, agent }
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()

  let llmServer: LlamaCppServer | undefined
  let llmAgent: LLMAgent | undefined

  if (args.model) {
    console.log(`\nInitializing llama.cpp with model: ${args.model}`)
    const setup = await setupLlm(args.model)
    llmServer = setup.server
    llmAgent = setup.agent
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
    await llmServer?.stop()
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
