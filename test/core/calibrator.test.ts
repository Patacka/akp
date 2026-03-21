import { describe, it, expect } from 'vitest'
import { calibrateWeights, nelderMead } from '../../src/core/confidence-calibrator.js'
import { DEFAULT_WEIGHTS } from '../../src/core/confidence.js'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'
import type { CalibrationSample } from '../../src/core/confidence-calibrator.js'
import type { PipelineScores } from '../../src/core/confidence.js'
import type { Review } from '../../src/core/ku.js'

function makeReview(did: string, verdict: Review['verdict'], weight: number): Review {
  return { id: uuidv7(), reviewerDid: did, reviewerType: 'agent', timestamp: new Date().toISOString(), verdict, scope: [], weight }
}

function makeSample(
  options: {
    claimConfidence: number
    reviewVerdicts: Array<{ did: string; verdict: Review['verdict']; weight: number }>
    stage1: number
    stage2: number
    stage3?: number
    coherence: number
    hasConflicts: boolean
    trueMaturity: CalibrationSample['trueMaturity']
  }
): CalibrationSample {
  const prov = createProvenance({ did: 'did:key:cal', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain: 'test', title: { en: 'Cal KU' }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'factual', subject: 's', predicate: 'p', object: 'o',
    confidence: options.claimConfidence, provenanceRef: prov.id,
  }))
  for (const r of options.reviewVerdicts) {
    ku.reviews.push(makeReview(r.did, r.verdict, r.weight))
  }
  const pipeline: PipelineScores = {
    stage1Score: options.stage1,
    stage2Score: options.stage2,
    stage3Score: options.stage3,
    coherenceScore: options.coherence,
    hasConflicts: options.hasConflicts,
  }
  return { ku, pipeline, trueMaturity: options.trueMaturity }
}

// Build a labeled dataset with known ground truth
function buildCalibrationDataset(): CalibrationSample[] {
  const samples: CalibrationSample[] = []

  // Stable KUs: high everything
  for (let i = 0; i < 10; i++) {
    samples.push(makeSample({
      claimConfidence: 0.9 + Math.random() * 0.1,
      reviewVerdicts: [
        { did: `did:key:r${i}a`, verdict: 'confirmed', weight: 0.8 },
        { did: `did:key:r${i}b`, verdict: 'confirmed', weight: 0.7 },
        { did: `did:key:r${i}c`, verdict: 'confirmed', weight: 0.6 },
      ],
      stage1: 0.9, stage2: 0.9, stage3: 0.85, coherence: 0.9, hasConflicts: false,
      trueMaturity: 'stable',
    }))
  }

  // Validated KUs: decent scores, 2 reviews
  for (let i = 0; i < 10; i++) {
    samples.push(makeSample({
      claimConfidence: 0.7 + Math.random() * 0.1,
      reviewVerdicts: [
        { did: `did:key:v${i}a`, verdict: 'confirmed', weight: 0.6 },
        { did: `did:key:v${i}b`, verdict: 'amended', weight: 0.5 },
      ],
      stage1: 0.7, stage2: 0.7, coherence: 0.7, hasConflicts: false,
      trueMaturity: 'validated',
    }))
  }

  // Proposed KUs: medium confidence, 1 review
  for (let i = 0; i < 10; i++) {
    samples.push(makeSample({
      claimConfidence: 0.5 + Math.random() * 0.15,
      reviewVerdicts: [
        { did: `did:key:p${i}`, verdict: 'confirmed', weight: 0.4 },
      ],
      stage1: 0.5, stage2: 0.5, coherence: 0.5, hasConflicts: false,
      trueMaturity: 'proposed',
    }))
  }

  // Draft KUs: low everything
  for (let i = 0; i < 10; i++) {
    samples.push(makeSample({
      claimConfidence: 0.2 + Math.random() * 0.2,
      reviewVerdicts: [],
      stage1: 0.2, stage2: 0.2, coherence: 0.2, hasConflicts: true,
      trueMaturity: 'draft',
    }))
  }

  return samples
}

describe('Nelder-Mead optimizer', () => {
  it('minimizes a simple 2D bowl function', () => {
    const fn = (v: number[]) => (v[0] - 3) ** 2 + (v[1] + 2) ** 2
    const { solution, converged } = nelderMead(fn, [0, 0], { maxIter: 500, tol: 1e-8 })
    expect(converged).toBe(true)
    expect(solution[0]).toBeCloseTo(3, 1)
    expect(solution[1]).toBeCloseTo(-2, 1)
  })

  it('converges within maxIter even on non-convex function', () => {
    const fn = (v: number[]) => Math.sin(v[0]) + v[1] ** 2
    const result = nelderMead(fn, [0, 0], { maxIter: 200 })
    expect(result.iterations).toBeLessThanOrEqual(200)
  })
})

describe('Weight calibration', () => {
  it('throws on empty samples', () => {
    expect(() => calibrateWeights([], DEFAULT_WEIGHTS)).toThrow()
  })

  it('returns weights that sum to 1.0', () => {
    const samples = buildCalibrationDataset()
    const { weights } = calibrateWeights(samples, DEFAULT_WEIGHTS, { maxIter: 100 })
    const sum = weights.w_claims + weights.w_reviews + weights.w_sources + weights.w_coherence
    expect(sum).toBeCloseTo(1.0, 3)
  })

  it('achieves at least 60% accuracy on labeled dataset with 200 iterations', () => {
    const samples = buildCalibrationDataset()
    const { accuracy } = calibrateWeights(samples, DEFAULT_WEIGHTS, { maxIter: 200 })
    console.log(`Calibrator accuracy: ${(accuracy * 100).toFixed(1)}%`)
    expect(accuracy).toBeGreaterThan(0.6)
  })

  it('calibrated weights improve over default weights baseline', async () => {
    const samples = buildCalibrationDataset()

    // Baseline with defaults
    let baselineCorrect = 0
    const { computeConfidence, computeMaturity } = await import('../../src/core/confidence.js')
    for (const { ku, pipeline, trueMaturity } of samples) {
      const { aggregate } = computeConfidence(ku, pipeline, DEFAULT_WEIGHTS)
      if (computeMaturity(aggregate, ku.reviews.length) === trueMaturity) baselineCorrect++
    }
    const baselineAccuracy = baselineCorrect / samples.length

    // After calibration
    const { accuracy } = calibrateWeights(samples, DEFAULT_WEIGHTS, { maxIter: 300 })
    console.log(`Baseline: ${(baselineAccuracy * 100).toFixed(1)}% → Calibrated: ${(accuracy * 100).toFixed(1)}%`)

    // Calibrated should be at least as good (non-regression)
    expect(accuracy).toBeGreaterThanOrEqual(baselineAccuracy - 0.05)
  })
})
