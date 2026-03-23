#!/usr/bin/env tsx
/**
 * cap-analysis.ts — Rigorous analysis of AKP's two-layer Sybil defence.
 *
 * Layer 1 — Per-reviewer monopoly cap (40%):
 *   Prevents any single high-weight DID from dominating outcomes.
 *   Cap binds when one reviewer's share of the total weight pool exceeds 40%.
 *   For small individual weights (typical Sybils w=0.10–0.20) the cap NEVER
 *   binds per-reviewer, so it provides NO protection against a cluster attack.
 *
 * Layer 2 — Graduation threshold:
 *   Ungraduated DIDs have effective weight = 0.  A cluster of S Sybils can
 *   only vote after each member earns graduationThreshold reputation, costing
 *   at least (d_min × τ + r_min × ε) real resources per DID.
 *   This is the primary cluster defence.
 *
 * This benchmark:
 *   A. Shows the cap's monopoly-protection property (layer 1 in isolation)
 *   B. Shows that cluster attacks are unbounded by the cap alone (layer 1 failure mode)
 *   C. Quantifies the graduation-threshold breakeven: min S for cluster to flip votes
 *   D. Computes attack cost(N) = N × (d_min × τ + r_min × ε) for realistic parameters
 *
 * Usage:
 *   npx tsx src/bench/cap-analysis.ts
 */

import { computeReviewScore } from '../core/confidence.js'
import type { Review } from '../core/ku.js'
import { v7 as uuidv7 } from 'uuid'

// ── Layer 1: per-reviewer monopoly cap ───────────────────────────────────────

export interface MonopolyCapResult {
  reviewerWeight: number      // raw weight of the single dominant reviewer
  poolWeight: number          // total weight of remaining reviewers
  rawShare: number            // share before cap
  cappedShare: number         // share after cap (= min(rawShare, 0.40))
  capBinding: boolean
}

export function analyseMonopolyCap(
  dominantWeight: number,
  numOthers: number,
  otherWeightMean = 0.3,
): MonopolyCapResult {
  const poolWeight = numOthers * otherWeightMean
  const total = dominantWeight + poolWeight
  const rawShare = dominantWeight / total
  const cappedShare = Math.min(rawShare, 0.40)
  return { reviewerWeight: dominantWeight, poolWeight, rawShare, cappedShare, capBinding: rawShare > 0.40 }
}

// ── Layer 2: graduation threshold breakeven ───────────────────────────────────

/**
 * Minimum Sybil cluster size S_crit that can overturn an honest majority of H agents,
 * assuming all Sybils have passed graduation (worst case — fully graduated attackers).
 *
 * After graduation each Sybil has weight w_s; each honest has weight w_h.
 * Honest vote score = confirmed (1.0), Sybil vote score = disputed (0.2).
 *
 * Score = h × 1.0 + (1−h) × v_s  where h = H×w_h / (H×w_h + S×w_s)
 * Honest wins when score > T (threshold = 0.5):
 *   h × 1.0 + (1−h) × v_s > T
 *   h(1 − v_s) > T − v_s
 *   h > (T − v_s) / (1 − v_s)
 *
 * h_crit = (T − v_s) / (1 − v_s) = (0.5 − 0.2) / (1 − 0.2) = 0.375
 *
 * S_crit = ceil(H × w_h × (1 − h_crit) / (h_crit × w_s))
 *        = ceil((1−T)/(T−v_s) × H × w_h / w_s)
 *        = ceil(5/3 × H × w_h / w_s)  for T=0.5, v_s=0.2
 *
 * Note: 'disputed' scoring 0.2 (not 0) gives extra resilience over a naive threshold.
 */
export function clusterBreakevenSize(
  H: number,
  w_h = 0.825,
  w_s = 0.15,
  threshold = 0.5,
  sybilVerdictScore = 0.2,   // verdictToScore('disputed')
): number {
  const h_crit = (threshold - sybilVerdictScore) / (1 - sybilVerdictScore)
  return Math.ceil(H * w_h * (1 - h_crit) / (h_crit * w_s))
}

/** Attack cost to graduate S Sybils given governance parameters */
export function attackCost(
  S: number,
  d_min: number,   // minAgeDays
  r_min: number,   // minReviewCount
  tau = 1.0,       // $ per DID-day (infrastructure/opportunity cost)
  epsilon = 0.10,  // $ per review submission effort
): number {
  return S * (d_min * tau + r_min * epsilon)
}

// ── Empirical Monte-Carlo ─────────────────────────────────────────────────────

function makeReview(did: string, verdict: 'confirmed' | 'disputed', weight: number): Review {
  return { id: uuidv7(), reviewerDid: did, reviewerType: 'agent',
           timestamp: new Date().toISOString(), verdict, scope: [], weight }
}

export interface CapAnalysisResult {
  H: number; S: number
  capBindsForAnySybil: boolean  // whether any individual Sybil hits the 40% cap
  perSybilRawShare: number      // each Sybil's raw share of total weight
  clusterRawShare: number       // S × perSybilRawShare (uncapped aggregate)
  honestWinRate: number
  trials: number
}

function runTrials(H: number, S: number, trials = 200): CapAnalysisResult {
  let honestWins = 0
  let totalClusterShare = 0

  for (let t = 0; t < trials; t++) {
    const reviews: Review[] = []
    for (let i = 0; i < H; i++)
      reviews.push(makeReview(`did:honest-${i}`, 'confirmed', 0.7 + Math.random() * 0.25))
    for (let i = 0; i < S; i++)
      reviews.push(makeReview(`did:sybil-${i}`, 'disputed', 0.1 + Math.random() * 0.1))

    const score = computeReviewScore(reviews)
    if (score > 0.5) honestWins++

    const totalW = reviews.reduce((s, r) => s + r.weight, 0)
    const sybilW = reviews.filter(r => r.reviewerDid.startsWith('did:sybil')).reduce((s, r) => s + r.weight, 0)
    totalClusterShare += sybilW / totalW
  }

  const meanTotalW = H * 0.825 + S * 0.15  // analytical approximation
  const perSybilRawShare = 0.15 / meanTotalW
  return {
    H, S,
    capBindsForAnySybil: perSybilRawShare > 0.40,
    perSybilRawShare,
    clusterRawShare: totalClusterShare / trials,
    honestWinRate: honestWins / trials,
    trials,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function benchmarkCapAnalysis(): Promise<{
  monopoly: MonopolyCapResult[]
  cluster: CapAnalysisResult[]
}> {
  // Layer 1: monopoly cap — vary single dominant reviewer weight with 4 peers
  const monopoly = [0.50, 0.70, 0.85, 0.90, 0.95, 0.99].map(w =>
    analyseMonopolyCap(w, 4, 0.30))

  // Layer 2: cluster — vary S with H=10 honest agents
  const sybilCounts = [1, 5, 10, 25, 50, 55, 60, 100, 200, 500]
  const cluster = sybilCounts.map(S => runTrials(10, S, 200))

  return { monopoly, cluster }
}

if (process.argv[1]?.endsWith('cap-analysis.ts') || process.argv[1]?.endsWith('cap-analysis.js')) {
  const { monopoly, cluster } = await benchmarkCapAnalysis()
  const H = 10
  const S_crit = clusterBreakevenSize(H)

  // ── Part A: monopoly cap ───────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(75))
  console.log('  LAYER 1: Per-Reviewer Monopoly Cap  (4 peers at mean weight 0.30)')
  console.log('  Cap binds when a single reviewer\'s raw share exceeds 40%')
  console.log('═'.repeat(75))
  console.log('  Dominant weight | Raw share | Capped share | Cap binding?')
  console.log('─'.repeat(75))
  for (const r of monopoly) {
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`
    console.log(`  ${r.reviewerWeight.toFixed(2).padEnd(16)} | ${pct(r.rawShare).padEnd(9)} | ${pct(r.cappedShare).padEnd(12)} | ${r.capBinding ? 'YES — capped to 40%' : 'no'}`)
  }

  // ── Part B: cluster attack ─────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(75))
  console.log(`  LAYER 2: Graduated Cluster Attack  (H=${H} honest agents, w_h=0.825, w_s=0.15)`)
  console.log(`  Breakeven cluster size S_crit = ceil(H × w_h / w_s) = ${S_crit}`)
  console.log('  Per-reviewer cap does NOT bind (individual Sybil share << 40%)')
  console.log('═'.repeat(75))
  console.log('  Sybils | Per-DID share | Cluster share | Honest win%  | Cap binds?')
  console.log('─'.repeat(75))
  for (const r of cluster) {
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`
    const marker = r.S >= S_crit ? ' ← cluster majority' : ''
    console.log(`  ${r.S.toString().padEnd(7)}| ${pct(r.perSybilRawShare).padEnd(13)} | ${pct(r.clusterRawShare).padEnd(13)} | ${pct(r.honestWinRate).padEnd(12)} | ${r.capBindsForAnySybil ? 'yes' : 'no'}${marker}`)
  }

  // ── Part C: attack cost ────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(75))
  console.log('  LAYER 2: Attack Cost to Graduate S_crit Sybils')
  console.log(`  Breakeven: S_crit = ceil((1−T)/(T−v_s) × H×w_h/w_s) = ${S_crit}`)
  console.log('  (T=0.5 threshold; v_s=0.2 disputed score — adds ~67% resilience vs naive 0-score)')
  console.log('  cost(N) = N × (d_min × τ + r_min × ε)  where τ=$1/DID-day, ε=$0.10/review')
  console.log('═'.repeat(75))
  const configs = [
    { d_min: 0,  r_min: 0,  label: 'Default (gates off)' },
    { d_min: 7,  r_min: 5,  label: 'Light gates' },
    { d_min: 30, r_min: 10, label: 'Moderate gates' },
    { d_min: 90, r_min: 25, label: 'Strong gates' },
  ]
  console.log('  Config                | S_crit | Cost at S_crit | Cost at 10×S_crit')
  console.log('─'.repeat(75))
  for (const c of configs) {
    const cost1 = attackCost(S_crit, c.d_min, c.r_min)
    const cost10 = attackCost(S_crit * 10, c.d_min, c.r_min)
    console.log(`  ${c.label.padEnd(22)}| ${S_crit.toString().padEnd(6)} | $${cost1.toFixed(0).padEnd(14)} | $${cost10.toFixed(0)}`)
  }
  console.log()
  console.log('  Summary: per-reviewer cap prevents monopoly (single trusted reviewer).')
  console.log(`  Cluster resistance requires graduation gates. With moderate gates,`)
  console.log(`  attacking ${S_crit} Sybils past the threshold costs $${attackCost(S_crit, 30, 10).toFixed(0)}+\n`)
}
