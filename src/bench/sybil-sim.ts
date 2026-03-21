import { computeReviewScore } from '../core/confidence.js'
import type { Review } from '../core/ku.js'
import { v7 as uuidv7 } from 'uuid'

export interface SybilSimResult {
  honestAgents: number
  sybilAgents: number
  honestWins: boolean
  finalScore: number
  withCap: number
  withoutCap: number
}

function createReview(
  did: string,
  verdict: 'confirmed' | 'disputed',
  weight: number
): Review {
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

export function simulateSybilAttack(
  honestCount: number,
  sybilCount: number,
  honestAccuracy = 0.85,
  sybilAccuracy = 0.5
): SybilSimResult {
  const reviews: Review[] = []

  // Honest agents: high accuracy, varied weights
  for (let i = 0; i < honestCount; i++) {
    const isCorrect = Math.random() < honestAccuracy
    const verdict = isCorrect ? 'confirmed' : 'disputed'
    const weight = 0.7 + Math.random() * 0.25 // 0.7-0.95
    reviews.push(createReview(`did:key:honest-${i}`, verdict, weight))
  }

  // Sybil agents: from same controller, low weight but many
  const controllerDid = 'did:key:sybil-controller'
  for (let i = 0; i < sybilCount; i++) {
    const isCorrect = Math.random() < sybilAccuracy
    const verdict = isCorrect ? 'confirmed' : 'disputed'
    const weight = 0.1 + Math.random() * 0.1 // 0.1-0.2, low weight
    reviews.push(createReview(`${controllerDid}:${i}`, verdict, weight))
  }

  const finalScore = computeReviewScore(reviews)

  // Without cap: straight weighted average
  const totalWeight = reviews.reduce((s, r) => s + r.weight, 0)
  const withoutCap = reviews.reduce((s, r) => {
    const score = r.verdict === 'confirmed' ? 1 : 0
    return s + (r.weight / totalWeight) * score
  }, 0)

  return {
    honestAgents: honestCount,
    sybilAgents: sybilCount,
    honestWins: finalScore > 0.5,
    finalScore,
    withCap: finalScore,
    withoutCap,
  }
}
