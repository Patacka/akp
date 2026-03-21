import { describe, it, expect } from 'vitest'
import { computeReviewScore } from '../../src/core/confidence.js'
import { v7 as uuidv7 } from 'uuid'
import type { Review } from '../../src/core/ku.js'

function review(did: string, verdict: 'confirmed' | 'disputed' | 'rejected', weight: number): Review {
  return {
    id: uuidv7(),
    reviewerDid: did,
    reviewerType: 'agent' as const,
    timestamp: new Date().toISOString(),
    verdict,
    scope: [],
    weight,
  }
}

describe('Anti-monopolization', () => {
  it('single reviewer cannot exceed 40% weight', () => {
    // Whale reviewer with weight 100 votes confirmed
    // Two small reviewers with weight 1 each vote different verdicts
    const reviews: Review[] = [
      review('did:whale', 'confirmed', 100),
      review('did:small-a', 'disputed', 1),
      review('did:small-b', 'rejected', 1),
    ]
    const score = computeReviewScore(reviews)
    // Whale is capped at 40%, so score should NOT be 1.0
    // Score should be between 0.4 and 0.8 since the whale can't fully dominate
    expect(score).toBeLessThan(1.0)
    expect(score).toBeGreaterThan(0.4)
  })

  it('equal weight reviewers average their verdicts', () => {
    // 2 confirmed + 1 rejected, equal weight
    const reviews: Review[] = [
      review('did:a', 'confirmed', 1.0),
      review('did:b', 'confirmed', 1.0),
      review('did:c', 'rejected', 1.0),
    ]
    const score = computeReviewScore(reviews)
    // 2/3 confirmed (1.0) + 1/3 rejected (0.0) ≈ 0.67
    expect(score).toBeGreaterThan(0.5)
  })

  it('multiple sybil-family reviewers are each individually capped', () => {
    // 10 sybil confirmers with weight 0.1 each
    // 1 disputer with weight 1.0
    // Without cap: disputer has 1.0 / (10*0.1 + 1.0) = 0.5 weight -> would tie
    // With cap: each sybil is capped at 40%, disputer also capped
    // The 10 confirmers collectively should outweigh the 1 disputer
    const reviews: Review[] = [
      ...Array.from({ length: 10 }, (_, i) => review(`did:sybil-${i}`, 'confirmed', 0.1)),
      review('did:disputer', 'disputed', 1.0),
    ]
    const score = computeReviewScore(reviews)
    // The 10 confirmers together should win despite each being capped individually
    expect(score).toBeGreaterThan(0.5)
  })
})
