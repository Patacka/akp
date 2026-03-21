/**
 * confidence-calibration.ts — Calibrate confidence weights using labeled KU samples.
 *
 * Builds 80 synthetic KUs (20 per maturity level) with ground-truth labels,
 * runs the Nelder-Mead calibrator, and prints:
 *   - Optimal weight vector
 *   - Accuracy before and after calibration
 *   - Per-maturity precision/recall
 *
 * Run:
 *   npx tsx src/bench/confidence-calibration.ts
 */

import { calibrateWeights, type CalibrationSample } from '../core/confidence-calibrator.js'
import { DEFAULT_WEIGHTS, type PipelineScores } from '../core/confidence.js'
import { createKU, createClaim, createProvenance } from '../core/ku.js'
import type { KnowledgeUnit } from '../core/ku.js'

// ── Sample factory helpers ────────────────────────────────────────────────────

function makeProv() {
  return createProvenance({ did: 'did:key:calib', type: 'agent', method: 'synthesis' })
}

function makeKUWithClaims(avgConfidence: number, count: number): KnowledgeUnit {
  const prov = makeProv()
  const ku = createKU({ domain: 'calib', title: { en: 'calib' }, provenance: prov })
  for (let i = 0; i < count; i++) {
    ku.structured.claims.push(createClaim({
      type: 'factual',
      subject: 'x',
      predicate: 'y',
      object: i,
      confidence: Math.max(0, Math.min(1, avgConfidence + (Math.random() - 0.5) * 0.1)),
      provenanceRef: prov.id,
    }))
  }
  return ku
}

function addReviews(ku: KnowledgeUnit, count: number, verdict: 'confirmed' | 'disputed' | 'amended') {
  for (let i = 0; i < count; i++) {
    ku.reviews.push({
      id: `rev-${i}-${Math.random().toString(36).slice(2)}`,
      reviewerDid: `did:key:reviewer${i}`,
      reviewerType: 'agent',
      scope: ku.structured.claims.map(c => c.id),
      verdict,
      weight: 1 / (i + 1),
      comment: '',
      timestamp: new Date().toISOString(),
    })
  }
}

function pipeline(s1: number, s2: number, s3?: number, coherence = 0.8, conflicts = false): PipelineScores {
  return {
    stage1Score: s1,
    stage2Score: s2,
    stage3Score: s3,
    coherenceScore: coherence,
    hasConflicts: conflicts,
  }
}

// ── Build labeled dataset ─────────────────────────────────────────────────────
//
// Maturity thresholds (default weights, for reference):
//   stable:    confidence ≥ 0.85 + reviews ≥ 3
//   validated: confidence ≥ 0.65 + reviews ≥ 2
//   proposed:  confidence ≥ 0.40 + reviews ≥ 1
//   draft:     otherwise

function buildSamples(): CalibrationSample[] {
  const samples: CalibrationSample[] = []

  // ── STABLE (20 samples) ──────────────────────────────────────────────────
  // High claim confidence, confirmed reviews, good sources, no conflicts
  for (let i = 0; i < 20; i++) {
    const ku = makeKUWithClaims(0.92 + Math.random() * 0.07, 3)
    addReviews(ku, 3 + (i % 3), 'confirmed')
    samples.push({
      ku,
      pipeline: pipeline(0.90 + Math.random() * 0.1, 0.85 + Math.random() * 0.1, 0.9, 0.9, false),
      trueMaturity: 'stable',
    })
  }

  // ── VALIDATED (20 samples) ───────────────────────────────────────────────
  // Good claim confidence, at least 2 confirmed reviews, decent sources
  for (let i = 0; i < 20; i++) {
    const ku = makeKUWithClaims(0.70 + Math.random() * 0.12, 2)
    addReviews(ku, 2, 'confirmed')
    samples.push({
      ku,
      pipeline: pipeline(0.70 + Math.random() * 0.15, 0.70 + Math.random() * 0.1, 0.75, 0.75, false),
      trueMaturity: 'validated',
    })
  }

  // ── PROPOSED (20 samples) ────────────────────────────────────────────────
  // Moderate confidence, 1 review (could be amended), some source gaps
  for (let i = 0; i < 20; i++) {
    const ku = makeKUWithClaims(0.50 + Math.random() * 0.12, 2)
    addReviews(ku, 1, i % 3 === 0 ? 'amended' : 'confirmed')
    samples.push({
      ku,
      pipeline: pipeline(0.50 + Math.random() * 0.15, 0.55 + Math.random() * 0.1, undefined, 0.6, false),
      trueMaturity: 'proposed',
    })
  }

  // ── DRAFT (20 samples) ───────────────────────────────────────────────────
  // Low confidence, no reviews, poor sources, or conflicts
  for (let i = 0; i < 20; i++) {
    const ku = makeKUWithClaims(0.20 + Math.random() * 0.18, 1)
    // No reviews for most; occasional disputed review
    if (i % 4 === 0) addReviews(ku, 1, 'disputed')
    const hasConflict = i % 3 === 0
    samples.push({
      ku,
      pipeline: pipeline(
        0.20 + Math.random() * 0.2,
        0.20 + Math.random() * 0.2,
        undefined,
        hasConflict ? 0.2 : 0.5,
        hasConflict
      ),
      trueMaturity: 'draft',
    })
  }

  return samples
}

// ── Precision/recall per maturity ────────────────────────────────────────────

import { computeConfidence, computeMaturity } from '../core/confidence.js'
import type { ConfidenceWeights } from '../core/confidence.js'

function evalWeights(samples: CalibrationSample[], weights: ConfidenceWeights) {
  const labels: KnowledgeUnit['meta']['maturity'][] = ['draft', 'proposed', 'validated', 'stable']
  const tp = Object.fromEntries(labels.map(l => [l, 0]))
  const fp = Object.fromEntries(labels.map(l => [l, 0]))
  const fn = Object.fromEntries(labels.map(l => [l, 0]))
  let correct = 0

  for (const { ku, pipeline: p, trueMaturity } of samples) {
    const { aggregate } = computeConfidence(ku, p, weights)
    const pred = computeMaturity(aggregate, ku.reviews.length)
    if (pred === trueMaturity) correct++
    tp[pred]++
    if (pred !== trueMaturity) {
      fp[pred]++
      fn[trueMaturity]++
    }
  }

  return {
    accuracy: correct / samples.length,
    perClass: Object.fromEntries(labels.map(l => {
      const precision = tp[l] > 0 ? (tp[l] - (fp[l] ?? 0)) / tp[l] : 0
      const recall = (tp[l] + (fn[l] ?? 0)) > 0 ? (tp[l] - (fp[l] ?? 0)) / (tp[l] + (fn[l] ?? 0)) : 0
      return [l, { precision: Math.max(0, precision), recall: Math.max(0, recall) }]
    })),
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Fix random seed for reproducibility
  let seed = 42
  const origRandom = Math.random
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff
    return (seed >>> 0) / 0x100000000
  }

  const samples = buildSamples()

  Math.random = origRandom  // restore

  const beforeMetrics = evalWeights(samples, DEFAULT_WEIGHTS)

  console.log('\n══════════════════════════════════════════════════════════')
  console.log('  CONFIDENCE WEIGHT CALIBRATION  (n=' + samples.length + ')')
  console.log('══════════════════════════════════════════════════════════')
  console.log(`\n  Baseline accuracy (default weights): ${(beforeMetrics.accuracy * 100).toFixed(1)}%`)
  console.log('\n  Running Nelder-Mead optimizer...')

  const result = calibrateWeights(samples, DEFAULT_WEIGHTS, { maxIter: 2000 })

  const afterMetrics = evalWeights(samples, result.weights)

  console.log(`  Converged: ${result.converged} (${result.iterations} iterations)`)
  console.log(`  Accuracy after calibration: ${(result.accuracy * 100).toFixed(1)}%`)

  console.log('\n  ── Weight comparison ─────────────────────────────────')
  const w = result.weights
  const dw = DEFAULT_WEIGHTS
  const fmt = (v: number) => v.toFixed(4)
  console.log(`  w_claims:            ${fmt(dw.w_claims)} → ${fmt(w.w_claims)}`)
  console.log(`  w_reviews:           ${fmt(dw.w_reviews)} → ${fmt(w.w_reviews)}`)
  console.log(`  w_sources:           ${fmt(dw.w_sources)} → ${fmt(w.w_sources)}`)
  console.log(`  w_coherence:         ${fmt(dw.w_coherence)} → ${fmt(w.w_coherence)}`)
  console.log(`  conflict_threshold:  ${fmt(dw.conflict_threshold)} → ${fmt(w.conflict_threshold)}`)

  console.log('\n  ── Per-class metrics (after calibration) ─────────────')
  for (const [label, { precision, recall }] of Object.entries(afterMetrics.perClass)) {
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0
    console.log(`  ${label.padEnd(12)}  prec=${(precision * 100).toFixed(0).padStart(3)}%  rec=${(recall * 100).toFixed(0).padStart(3)}%  F1=${(f1 * 100).toFixed(0).padStart(3)}%`)
  }

  console.log('\n  ── Recommended update to DEFAULT_WEIGHTS ─────────────')
  console.log('  export const DEFAULT_WEIGHTS: ConfidenceWeights = {')
  console.log(`    w_claims:           ${fmt(w.w_claims)},`)
  console.log(`    w_reviews:          ${fmt(w.w_reviews)},`)
  console.log(`    w_sources:          ${fmt(w.w_sources)},`)
  console.log(`    w_coherence:        ${fmt(w.w_coherence)},`)
  console.log(`    conflict_threshold: ${fmt(w.conflict_threshold)},`)
  console.log('  }')
  console.log('══════════════════════════════════════════════════════════\n')
}

main()
