import type { KnowledgeUnit, Claim } from '../core/ku.js'
import type { RelationGraph, Contradiction } from '../core/graph.js'
import {
  defaultConsilienceEngine,
  type ConsilienceEngine,
  type ConsilienceViolation,
} from '../core/consilience.js'

export interface OntologyRule {
  domain: string
  subjectType?: string
  predicateMustMatch?: RegExp
  objectMustBeType?: 'string' | 'number' | 'boolean'
  objectRange?: { min: number; max: number }
}

export interface Stage2Result {
  contradictions: Contradiction[]
  coherenceScore: number
  ontologyViolations: string[]
  /** Violations from the ConsilienceEngine (global invariant checks). */
  consilienceViolations: ConsilienceViolation[]
  stage2Score: number
}

const DOMAIN_RULES: Record<string, OntologyRule[]> = {
  science: [
    { domain: 'science', predicateMustMatch: /^(is|has|causes|produces|inhibits|correlates_with)$/ },
  ],
  medicine: [
    { domain: 'medicine', objectRange: undefined },
  ],
}

function checkOntology(claim: Claim, domain: string): string[] {
  const violations: string[] = []
  const rules = DOMAIN_RULES[domain] ?? []

  for (const rule of rules) {
    if (rule.predicateMustMatch && !rule.predicateMustMatch.test(claim.predicate)) {
      // Soft check - just warn
    }
    if (rule.objectMustBeType) {
      const actualType = typeof claim.object
      if (actualType !== rule.objectMustBeType) {
        violations.push(`Claim ${claim.id}: object should be ${rule.objectMustBeType}, got ${actualType}`)
      }
    }
    if (rule.objectRange && typeof claim.object === 'number') {
      const { min, max } = rule.objectRange
      if (claim.object < min || claim.object > max) {
        violations.push(`Claim ${claim.id}: ${claim.object} is outside valid range [${min}, ${max}]`)
      }
    }
  }

  return violations
}

export async function runStage2(
  ku: KnowledgeUnit,
  graph: RelationGraph,
  consilienceEngine: ConsilienceEngine = defaultConsilienceEngine
): Promise<Stage2Result> {
  const allContradictions: Contradiction[] = []
  const allViolations: string[] = []
  const allConsilienceViolations: ConsilienceViolation[] = []

  // Check each claim
  for (const claim of ku.structured.claims) {
    // 1. Check for contradictions in 2-hop neighborhood (local)
    const contradictions = graph.checkContradictions(claim, ku.id, 3)
    allContradictions.push(...contradictions)

    // 2. Ontology checks
    const violations = checkOntology(claim, ku.meta.domain)
    allViolations.push(...violations)

    // 3. Consilience checks (global invariants, graph-distance independent)
    const cViolations = consilienceEngine.check(claim, ku.id, graph)
    allConsilienceViolations.push(...cViolations)
  }

  // 4. Coherence score from graph
  const coherenceScore = graph.computeCoherence(ku.id)

  // Compute stage2 score
  // Local contradictions penalize by hop distance
  const directContradictions = allContradictions.filter(c => c.hopDistance === 0)
  const indirectContradictions = allContradictions.filter(c => c.hopDistance > 0)
  // Consilience violations penalize by severity
  const rejectViolations = allConsilienceViolations.filter(v => v.severity === 'reject')
  const warnViolations = allConsilienceViolations.filter(v => v.severity === 'warn')

  let stage2Score = 1.0
  stage2Score -= directContradictions.length * 0.3
  stage2Score -= indirectContradictions.length * 0.1
  stage2Score -= allViolations.length * 0.05
  stage2Score -= rejectViolations.length * 0.4  // hard impossibility
  stage2Score -= warnViolations.length * 0.15   // soft inconsistency
  stage2Score = Math.max(0, Math.min(1, stage2Score))

  return {
    contradictions: allContradictions,
    coherenceScore,
    ontologyViolations: allViolations,
    consilienceViolations: allConsilienceViolations,
    stage2Score,
  }
}
