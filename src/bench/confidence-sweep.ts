import type { KnowledgeUnit } from '../core/ku.js'
import { createKU, createProvenance, createClaim } from '../core/ku.js'
import { computeConfidence, computeMaturity, type ConfidenceWeights } from '../core/confidence.js'
import type { PipelineScores } from '../core/confidence.js'
import { v7 as uuidv7 } from 'uuid'

export interface SweepResult {
  weights: ConfidenceWeights
  accuracy: number       // fraction of KUs where computed maturity matches expected
  avgConfidence: number
}

interface TestKU {
  ku: KnowledgeUnit
  expectedMaturity: KnowledgeUnit['meta']['maturity']
  pipeline: PipelineScores
}

function buildTestSet(size = 100): TestKU[] {
  const prov = createProvenance({ did: 'did:key:sweep', type: 'agent', method: 'synthesis' })
  const items: TestKU[] = []

  for (let i = 0; i < size; i++) {
    const ku = createKU({
      domain: 'sweep',
      title: { en: `Sweep KU ${i}` },
      provenance: prov,
    })

    // Vary claim quality
    const claimConf = 0.3 + (i / size) * 0.7
    ku.structured.claims.push(createClaim({
      type: 'factual',
      subject: `entity-${i}`,
      predicate: 'hasValue',
      object: i,
      confidence: claimConf,
      provenanceRef: prov.id,
    }))

    // Add reviews for higher-index KUs (simulating progressive validation)
    const reviewCount = Math.floor((i / size) * 4)
    for (let r = 0; r < reviewCount; r++) {
      ku.reviews.push({
        id: uuidv7(),
        reviewerDid: `did:key:reviewer-${r}`,
        reviewerType: 'agent',
        timestamp: new Date().toISOString(),
        verdict: claimConf > 0.6 ? 'confirmed' : 'disputed',
        scope: [],
        weight: 0.5 + r * 0.1,
      })
    }

    // Pipeline scores proportional to position
    const quality = i / size
    const pipeline: PipelineScores = {
      stage1Score: quality,
      stage2Score: quality,
      coherenceScore: quality * 0.8,
      hasConflicts: quality < 0.2,
    }

    // Determine "ground truth" expected maturity
    let expectedMaturity: KnowledgeUnit['meta']['maturity']
    if (quality >= 0.85 && reviewCount >= 3) expectedMaturity = 'stable'
    else if (quality >= 0.65 && reviewCount >= 2) expectedMaturity = 'validated'
    else if (quality >= 0.4 && reviewCount >= 1) expectedMaturity = 'proposed'
    else expectedMaturity = 'draft'

    items.push({ ku, expectedMaturity, pipeline })
  }

  return items
}

export async function benchmarkConfidenceSweep(testSetSize = 100): Promise<SweepResult[]> {
  const testSet = buildTestSet(testSetSize)
  const results: SweepResult[] = []

  // Parameter sweep ranges
  const w_claims_values = [0.2, 0.3, 0.35, 0.4, 0.5]
  const w_reviews_values = [0.2, 0.3, 0.35, 0.4]
  const conflict_threshold_values = [0.1, 0.2, 0.3, 0.4]

  for (const w_claims of w_claims_values) {
    for (const w_reviews of w_reviews_values) {
      for (const conflict_threshold of conflict_threshold_values) {
        const w_sources = Math.max(0.05, 1 - w_claims - w_reviews - 0.1)
        const w_coherence = Math.max(0.05, 1 - w_claims - w_reviews - w_sources)

        // Normalize to sum to 1
        const total = w_claims + w_reviews + w_sources + w_coherence
        const weights: ConfidenceWeights = {
          w_claims: w_claims / total,
          w_reviews: w_reviews / total,
          w_sources: w_sources / total,
          w_coherence: w_coherence / total,
          conflict_threshold,
        }

        let correct = 0
        let totalConfidence = 0

        for (const { ku, expectedMaturity, pipeline } of testSet) {
          const { aggregate } = computeConfidence(ku, pipeline, weights)
          const computed = computeMaturity(aggregate, ku.reviews.length)
          if (computed === expectedMaturity) correct++
          totalConfidence += aggregate
        }

        results.push({
          weights,
          accuracy: correct / testSet.length,
          avgConfidence: totalConfidence / testSet.length,
        })
      }
    }
  }

  return results
}
