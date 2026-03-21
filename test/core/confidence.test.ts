import { describe, it, expect } from 'vitest'
import { computeReviewScore, computeConfidence, computeMaturity, detectConfidenceLaundering, claimStalenessMultiplier, computeClaimScore } from '../../src/core/confidence.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'
import type { Review } from '../../src/core/ku.js'

function makeReview(did: string, verdict: Review['verdict'], weight: number): Review {
  return {
    id: uuidv7(),
    reviewerDid: did,
    reviewerType: 'agent',
    timestamp: new Date().toISOString(),
    verdict,
    scope: [],
    weight,
  }
}

describe('computeReviewScore', () => {
  it('returns 0 for empty reviews', () => {
    expect(computeReviewScore([])).toBe(0)
  })

  it('single confirmed review is dampened by diversity floor (< 3 reviewers)', () => {
    // 1 reviewer → diversityFactor = 1/3 ≈ 0.33; score cannot approach 1.0
    const reviews = [makeReview('did:key:a', 'confirmed', 1.0)]
    const score = computeReviewScore(reviews)
    expect(score).toBeCloseTo(1 / 3, 2)
  })

  it('returns full score with 3+ diverse reviewers', () => {
    const reviews = [
      makeReview('did:key:a', 'confirmed', 1.0),
      makeReview('did:key:b', 'confirmed', 1.0),
      makeReview('did:key:c', 'confirmed', 1.0),
    ]
    expect(computeReviewScore(reviews)).toBeCloseTo(1.0)
  })

  it('returns 0 for single rejected review', () => {
    const reviews = [makeReview('did:key:a', 'rejected', 1.0)]
    expect(computeReviewScore(reviews)).toBe(0)
  })

  it('applies anti-monopolization cap', () => {
    // One heavy reviewer (confirmed) gets capped at MAX_SINGLE_REVIEWER_WEIGHT (0.4)
    // 4 equal-weight disputed reviewers each contribute ~15% after cap
    // Without cap: whale (weight 10 / total 14) = 71% -> score would be ~0.76
    // With cap: whale capped at 40%, 4 disputed reviewers each ~15% -> score ~0.52
    const reviews = [
      makeReview('did:key:whale', 'confirmed', 10.0),
      makeReview('did:key:a', 'disputed', 1.0),
      makeReview('did:key:b', 'disputed', 1.0),
      makeReview('did:key:c', 'disputed', 1.0),
      makeReview('did:key:d', 'disputed', 1.0),
    ]
    const score = computeReviewScore(reviews)
    // Without cap: 10/14*1.0 + 4*(1/14)*0.2 = 0.714 + 0.057 = 0.771
    // With cap: whale=0.4, each disputed reviewer=(0.6/4)=0.15 -> 0.4*1.0 + 4*0.15*0.2 = 0.52
    // Cap brings score from ~0.77 down to ~0.52
    expect(score).toBeLessThan(0.7)
    expect(score).toBeGreaterThan(0.3)
  })
})

describe('computeMaturity', () => {
  it('returns draft for low confidence', () => {
    expect(computeMaturity(0.2, 0)).toBe('draft')
  })

  it('returns stable for high confidence and reviews', () => {
    expect(computeMaturity(0.9, 5)).toBe('stable')
  })
})

describe('detectConfidenceLaundering', () => {
  it('detects self-referential citations', () => {
    const kuId = 'ku-parent'
    const childId = 'ku-child'
    const lineage = new Map([[childId, [kuId]]])
    const { isLaundering } = detectConfidenceLaundering(kuId, [childId], lineage)
    expect(isLaundering).toBe(true)
  })

  it('allows legitimate citations', () => {
    const kuId = 'ku-a'
    const otherId = 'ku-b'
    const lineage = new Map<string, string[]>()
    const { isLaundering } = detectConfidenceLaundering(kuId, [otherId], lineage)
    expect(isLaundering).toBe(false)
  })
})

// ── Staleness decay ───────────────────────────────────────────────────────────

describe('claimStalenessMultiplier', () => {
  it('returns 1.0 when validUntil is null or undefined', () => {
    expect(claimStalenessMultiplier(null)).toBe(1.0)
    expect(claimStalenessMultiplier(undefined)).toBe(1.0)
  })

  it('returns 1.0 when validUntil is in the future', () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString()
    expect(claimStalenessMultiplier(future)).toBe(1.0)
  })

  it('returns ~0.97 one day past expiry', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    expect(claimStalenessMultiplier(yesterday)).toBeCloseTo(Math.exp(-1 / 30), 3)
  })

  it('returns ~0.37 thirty days past expiry', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
    expect(claimStalenessMultiplier(thirtyDaysAgo)).toBeCloseTo(Math.exp(-1), 2)
  })

  it('returns ~0.05 ninety days past expiry', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
    expect(claimStalenessMultiplier(ninetyDaysAgo)).toBeCloseTo(Math.exp(-3), 2)
  })
})

describe('computeClaimScore staleness', () => {
  function makeKuWithExpiredClaim(validUntil: string | undefined) {
    const prov = createProvenance({ did: 'did:key:za', type: 'agent', method: 'observation' })
    const ku = createKU({ domain: 'test', title: { en: 'T' }, provenance: prov })
    ku.structured.claims = [{
      id: uuidv7(), type: 'temporal', subject: 'x', predicate: 'version',
      object: '1.0', confidence: 1.0, provenanceRef: prov.id, replications: [],
      validUntil,
    }]
    return ku
  }

  it('fresh claim (no validUntil) scores at full claim confidence', () => {
    const ku = makeKuWithExpiredClaim(undefined)
    expect(computeClaimScore(ku)).toBeCloseTo(1.0, 5)
  })

  it('expired claim scores below its nominal confidence', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const ku = makeKuWithExpiredClaim(thirtyDaysAgo)
    expect(computeClaimScore(ku)).toBeLessThan(0.5)
  })
})

// ── Supersession confidence cap ───────────────────────────────────────────────

describe('computeConfidence supersession cap', () => {
  it('caps aggregate at 0.3 when KU has a superseded_by relation', () => {
    const prov = createProvenance({ did: 'did:key:za', type: 'agent', method: 'observation' })
    const ku = createKU({ domain: 'test', title: { en: 'Old' }, provenance: prov })
    ku.id  // use ku.id as both source and target for test
    ku.structured.relations.push({
      id: uuidv7(),
      type: 'superseded_by',
      sourceKuId: ku.id,
      targetKuId: uuidv7(),
      confidence: 1.0,
      confirmedBy: [],
    })
    ku.structured.claims = [{
      id: uuidv7(), type: 'factual', subject: 'x', predicate: 'y',
      object: true, confidence: 1.0, provenanceRef: prov.id, replications: [],
    }]

    const result = computeConfidence(ku, {
      stage1Score: 1, stage2Score: 1, coherenceScore: 1, hasConflicts: false,
    })
    expect(result.aggregate).toBeLessThanOrEqual(0.3)
    expect(result.breakdown.superseded).toBe(1)
  })

  it('does not cap a KU with no superseded_by relation', () => {
    const prov = createProvenance({ did: 'did:key:zb', type: 'agent', method: 'observation' })
    const ku = createKU({ domain: 'test', title: { en: 'Current' }, provenance: prov })
    ku.structured.claims = [{
      id: uuidv7(), type: 'factual', subject: 'x', predicate: 'y',
      object: true, confidence: 1.0, provenanceRef: prov.id, replications: [],
    }]

    const result = computeConfidence(ku, {
      stage1Score: 1, stage2Score: 1, coherenceScore: 1, hasConflicts: false,
    })
    expect(result.aggregate).toBeGreaterThan(0.3)
  })
})
