import type { KnowledgeUnit, Review } from './ku.js'

export interface ConfidenceWeights {
  w_claims: number      // 0.2-0.5, weight of claim quality
  w_reviews: number     // 0.1-0.5, weight of review scores
  w_sources: number     // 0.1-0.4, weight of source accessibility
  w_coherence: number   // 0.1-0.3, weight of graph coherence
  conflict_threshold: number  // 0.1-0.5, threshold for conflict penalty
}

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  w_claims: 0.25,
  w_reviews: 0.25,
  w_sources: 0.40,
  w_coherence: 0.10,
  conflict_threshold: 0.15,
}

export interface PipelineScores {
  stage1Score: number   // 0-1: source accessibility
  stage2Score: number   // 0-1: graph consistency
  stage3Score?: number  // 0-1: independent corroboration
  coherenceScore: number
  hasConflicts: boolean
}

// Anti-monopolization cap: no single reviewer can dominate
const MAX_SINGLE_REVIEWER_WEIGHT = 0.4

/**
 * Diversity floor: review score is dampened when fewer than this many
 * distinct reviewers have contributed. Limits Sybil impact even after
 * renormalization (a single reviewer gets score × 0.33 not × 1.0).
 *
 *   1 reviewer → × 0.33
 *   2 reviewers → × 0.67
 *   3+ reviewers → × 1.0  (full weight)
 *
 * Coordinated pools of 3+ DIDs still reach full score — deeper Sybil
 * resistance requires an identity/reputation layer outside this module.
 */
const DIVERSITY_FLOOR = 3

export function computeReviewScore(reviews: Review[]): number {
  if (reviews.length === 0) return 0

  // Group by reviewer
  const byReviewer = new Map<string, Review[]>()
  for (const r of reviews) {
    const existing = byReviewer.get(r.reviewerDid) ?? []
    existing.push(r)
    byReviewer.set(r.reviewerDid, existing)
  }

  // Compute raw weights per reviewer (use their latest review)
  const reviewerWeights: Array<{ did: string; weight: number; verdict: string }> = []
  for (const [did, rs] of byReviewer) {
    const latest = rs.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
    reviewerWeights.push({ did, weight: latest.weight, verdict: latest.verdict })
  }

  // Apply anti-monopolization cap
  const totalRawWeight = reviewerWeights.reduce((s, r) => s + r.weight, 0)
  if (totalRawWeight === 0) return 0
  const cappedWeights = reviewerWeights.map(r => ({
    ...r,
    cappedWeight: Math.min(r.weight / totalRawWeight, MAX_SINGLE_REVIEWER_WEIGHT),
  }))

  // Renormalize
  const totalCapped = cappedWeights.reduce((s, r) => s + r.cappedWeight, 0)

  let score = 0
  for (const r of cappedWeights) {
    const normalized = r.cappedWeight / totalCapped
    const verdictScore = verdictToScore(r.verdict)
    score += normalized * verdictScore
  }

  // Diversity dampening: require DIVERSITY_FLOOR distinct reviewers for full weight
  const diversityFactor = Math.min(1.0, reviewerWeights.length / DIVERSITY_FLOOR)
  return Math.max(0, Math.min(1, score * diversityFactor))
}

function verdictToScore(verdict: string): number {
  switch (verdict) {
    case 'confirmed': return 1.0
    case 'amended': return 0.6
    case 'disputed': return 0.2
    case 'rejected': return 0.0
    default: return 0.5
  }
}

/**
 * Staleness multiplier for a claim based on its validUntil date.
 * Returns 1.0 before expiry, then decays exponentially:
 *   exp(-daysPastExpiry / 30)
 * A claim 30 days past validUntil retains ~37% confidence.
 * A claim 90 days past retains ~5%.
 */
export function claimStalenessMultiplier(validUntil: string | undefined | null, now = new Date()): number {
  if (!validUntil) return 1.0
  const expiry = new Date(validUntil)
  if (isNaN(expiry.getTime())) return 1.0
  const daysPast = (now.getTime() - expiry.getTime()) / 86_400_000
  if (daysPast <= 0) return 1.0
  return Math.exp(-daysPast / 30)
}

export function computeClaimScore(ku: KnowledgeUnit, now = new Date()): number {
  const claims = ku.structured.claims
  if (claims.length === 0) return 0
  const avg = claims.reduce((s, c) => {
    const staleness = claimStalenessMultiplier(c.validUntil, now)
    return s + c.confidence * staleness
  }, 0) / claims.length
  return Math.max(0, Math.min(1, avg))
}

export function computeConfidence(
  ku: KnowledgeUnit,
  pipeline: PipelineScores,
  weights: ConfidenceWeights = DEFAULT_WEIGHTS
): { aggregate: number; breakdown: Record<string, number> } {
  const claimScore = computeClaimScore(ku)
  const reviewScore = computeReviewScore(ku.reviews)

  // Supersession cap: if this KU has a superseded_by relation, its confidence
  // is capped at 0.3 to signal it is no longer the authoritative source.
  const isSuperseded = ku.structured.relations.some(r =>
    r.type === 'superseded_by' && r.sourceKuId === ku.id
  )
  if (isSuperseded) {
    return {
      aggregate: Math.min(0.3, claimScore * weights.w_claims),
      breakdown: { claimScore, reviewScore, sourceScore: 0, coherenceScore: 0,
        stage1: 0, stage2: 0, stage3: -1, coherencePenalty: 0, superseded: 1 },
    }
  }

  // Apply conflict penalty
  let coherencePenalty = 0
  if (pipeline.hasConflicts && pipeline.stage2Score < weights.conflict_threshold) {
    coherencePenalty = 0.3
  }

  // Stage 3 boosts the source score if available
  const sourceScore = pipeline.stage3Score != null
    ? (pipeline.stage1Score * 0.5 + pipeline.stage3Score * 0.5)
    : pipeline.stage1Score

  const aggregate = Math.max(
    0,
    weights.w_claims * claimScore +
    weights.w_reviews * reviewScore +
    weights.w_sources * sourceScore +
    weights.w_coherence * pipeline.coherenceScore -
    coherencePenalty
  )

  return {
    aggregate: Math.min(1, aggregate),
    breakdown: {
      claimScore,
      reviewScore,
      sourceScore,
      coherenceScore: pipeline.coherenceScore,
      stage1: pipeline.stage1Score,
      stage2: pipeline.stage2Score,
      stage3: pipeline.stage3Score ?? -1,
      coherencePenalty,
    },
  }
}

/**
 * Compute the theoretical maximum confidence achievable given which pipeline
 * stages are active.  Used to normalise maturity thresholds so a node running
 * with mock stage-1 (stage1Score=0) doesn't freeze every KU at 'draft'.
 *
 *   Full pipeline (stage1 live + stage3 available):  ~1.0
 *   Mock stage-1, no stage-3:                        w_claims + w_reviews + w_coherence*0.5
 *                                                   = 0.35 + 0.35 + 0.05 = 0.75
 */
export function computeMaxAchievableConfidence(weights: ConfidenceWeights, hasStage1: boolean, hasStage3: boolean): number {
  const sourceMax = hasStage1 ? (hasStage3 ? 1.0 : 0.75) : 0
  return Math.min(1,
    weights.w_claims * 1.0 +
    weights.w_reviews * 1.0 +
    weights.w_sources * sourceMax +
    weights.w_coherence * 1.0
  )
}

export function computeMaturity(
  confidence: number,
  reviewCount: number,
  maxAchievable = 1.0
): KnowledgeUnit['meta']['maturity'] {
  // 'stable' and 'validated' use absolute thresholds — these must reflect genuine
  // multi-component confidence (claims + reviews + sources) and must NOT be
  // lowered for nodes running with mock stage-1, otherwise laundering attacks can
  // push false claims to stable without real source verification.
  //
  // Only the 'proposed' threshold scales with maxAchievable — this lets early-network
  // KUs clear the first rung of the ladder even when stage-1 is mocked,
  // without compromising the upper tiers.
  if (confidence >= 0.85 && reviewCount >= 3) return 'stable'
  if (confidence >= 0.65 && reviewCount >= 2) return 'validated'
  if (confidence >= 0.40 * maxAchievable && reviewCount >= 1) return 'proposed'
  return 'draft'
}

/**
 * Phase 5: replication-count-based maturity for claims with VerificationProcedures.
 *
 * Rules:
 *   draft   → at least 1 claim has a verificationProcedure (but no replications yet)
 *   proposed → ≥1 'reproduced' replication across all procedures
 *   validated → ≥3 'reproduced' replications, 0 'failed'
 *   stable   → ≥5 'reproduced' replications, 0 'failed'
 *
 * If no claim has a verificationProcedure, falls back to confidence-based maturity.
 * Claims with a verificationProcedure are NEVER promoted above their replication ceiling.
 */
export function computeMaturityFromReplications(ku: KnowledgeUnit): KnowledgeUnit['meta']['maturity'] {
  const claims = ku.structured.claims
  const procedureClaims = claims.filter(c => c.verificationProcedure != null)

  if (procedureClaims.length === 0) {
    // No verification procedures — use legacy confidence path
    const reviewCount = ku.reviews.length
    const confidence = ku.meta.confidence.aggregate
    return computeMaturity(confidence, reviewCount)
  }

  // Aggregate replication verdicts across all procedure-bearing claims
  let reproduced = 0
  let failed = 0
  for (const c of procedureClaims) {
    for (const r of (c.replications ?? [])) {
      if (r.verdict === 'reproduced') reproduced++
      else if (r.verdict === 'failed') failed++
    }
  }

  if (reproduced >= 5 && failed === 0) return 'stable'
  if (reproduced >= 3 && failed === 0) return 'validated'
  if (reproduced >= 1) return 'proposed'
  return 'draft'
}

// Confidence laundering detection:
// A KU that only cites itself or its children should not gain from those citations
export function detectConfidenceLaundering(
  kuId: string,
  supportingKuIds: string[],
  kuLineage: Map<string, string[]>  // kuId -> ancestor kuIds
): { isLaundering: boolean; suspiciousRefs: string[] } {
  const suspicious: string[] = []
  for (const refId of supportingKuIds) {
    // A citation is suspicious if the referenced KU is a descendant of this KU
    const ancestors = kuLineage.get(refId) ?? []
    if (ancestors.includes(kuId)) {
      suspicious.push(refId)
    }
  }
  return { isLaundering: suspicious.length > 0, suspiciousRefs: suspicious }
}
