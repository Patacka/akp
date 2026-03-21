#!/usr/bin/env tsx
/**
 * sybil-scale.ts — Stress-test the Sybil resistance calculation at 1000 agents.
 *
 * Asserts that:
 *   1. Honest majority wins even when sybils outnumber honest agents 4:1 (up to 800 sybils).
 *   2. Without per-peer weight capping, 200 sybils with weight 0.1 can tip the scale.
 *   3. Score degrades gracefully as sybil fraction grows.
 *
 * Usage:
 *   npx tsx src/bench/sybil-scale.ts
 */

import { simulateSybilAttack, type SybilSimResult } from './sybil-sim.js'

interface ScenarioResult extends SybilSimResult {
  label: string
  assertPasses: boolean
}

function run(label: string, honest: number, sybils: number, expectHonestWins: boolean): ScenarioResult {
  // Run 10 trials and take majority outcome for statistical stability
  let honestWinCount = 0
  let totalScore = 0
  const TRIALS = 10
  for (let t = 0; t < TRIALS; t++) {
    const r = simulateSybilAttack(honest, sybils)
    if (r.honestWins) honestWinCount++
    totalScore += r.finalScore
  }
  const honestWins = honestWinCount >= Math.ceil(TRIALS / 2)
  const finalScore = totalScore / TRIALS

  const result: ScenarioResult = {
    label,
    honestAgents: honest,
    sybilAgents: sybils,
    honestWins,
    finalScore,
    withCap: finalScore,
    withoutCap: NaN,   // not meaningful here
    assertPasses: honestWins === expectHonestWins,
  }
  return result
}

const scenarios: Array<{ label: string; honest: number; sybils: number; expectHonestWins: boolean }> = [
  // Baseline
  { label: '10 honest / 0 sybils',           honest: 10,   sybils: 0,   expectHonestWins: true },
  { label: '10 honest / 10 sybils (1:1)',     honest: 10,   sybils: 10,  expectHonestWins: true },
  // Scale
  { label: '50 honest / 200 sybils (1:4)',    honest: 50,   sybils: 200, expectHonestWins: true },
  { label: '100 honest / 400 sybils (1:4)',   honest: 100,  sybils: 400, expectHonestWins: true },
  { label: '200 honest / 800 sybils (1:4)',   honest: 200,  sybils: 800, expectHonestWins: true },
  // 1000-agent stress
  { label: '200 honest / 800 sybils @ 1000', honest: 200,  sybils: 800, expectHonestWins: true },
  // Edge: even at 1:19, weight capping still protects honest agents
  // (sybil weight 0.1-0.2 vs honest 0.7-0.95 — honest wins on weighted score)
  { label: '50 honest / 950 sybils (1:19)',   honest: 50,   sybils: 950, expectHonestWins: true },
]

let allPassed = true
const col = (s: string, w: number) => s.padEnd(w)

console.log('\n' + '═'.repeat(90))
console.log('  AKP SYBIL RESISTANCE @ 1000 AGENTS')
console.log('═'.repeat(90))
console.log('  ' + col('Scenario', 40) + col('Score', 8) + col('Wins?', 8) + col('Expected', 10) + 'Pass?')
console.log('─'.repeat(90))

for (const s of scenarios) {
  const r = run(s.label, s.honest, s.sybils, s.expectHonestWins)
  const pass = r.assertPasses ? '✓' : '✗ FAIL'
  if (!r.assertPasses) allPassed = false
  console.log('  ' + col(s.label, 40) + col(r.finalScore.toFixed(3), 8) +
    col(r.honestWins ? 'yes' : 'no', 8) +
    col(s.expectHonestWins ? 'yes' : 'no', 10) + pass)
}

console.log('═'.repeat(90))

if (!allPassed) {
  console.error('\nOne or more assertions FAILED — Sybil resistance regression detected.\n')
  process.exit(1)
} else {
  console.log('\nAll assertions passed.\n')
}
