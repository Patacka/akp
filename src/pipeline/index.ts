import type { KnowledgeUnit } from '../core/ku.js'
import type { RelationGraph } from '../core/graph.js'
import { runStage1, type Stage1Result } from './stage1.js'
import { runStage2, type Stage2Result } from './stage2.js'
import { runStage3, type Stage3Result, type LLMAgent } from './stage3.js'
import { runReplication, type ReplicationAgent, type ReplicationRunResult } from './stage3-replication.js'
import { ravVerify, type EntailmentChecker, type RAVResult, type RAVOptions } from './stage3-rav.js'
import { computeConfidence, computeMaturity, computeMaturityFromReplications, computeMaxAchievableConfidence, DEFAULT_WEIGHTS, type PipelineScores, type ConfidenceWeights } from '../core/confidence.js'
import type { GovernanceState } from '../core/governance.js'
import { runCalibration } from './calibration.js'

export interface PipelineResult {
  stage1: Stage1Result
  stage2: Stage2Result
  stage3?: Stage3Result
  replication?: ReplicationRunResult[]
  rav?: RAVResult[]
  confidence: { aggregate: number; breakdown: Record<string, number> }
  maturity: KnowledgeUnit['meta']['maturity']
  checkedAt: string
  /** Set when a governance maturity_override was applied for this KU. */
  maturityOverrideApplied?: boolean
}

export interface PipelineOptions {
  runStage3?: boolean
  agents?: LLMAgent[]
  mockStage1?: boolean
  stage1MockResults?: Record<string, boolean>
  weights?: ConfidenceWeights
  // Phase 5
  replicationAgents?: ReplicationAgent[]
  entailmentChecker?: EntailmentChecker
  ravOptions?: RAVOptions
  /**
   * Require Ed25519 signatures on VerificationProcedures before execution.
   * Default: true. Pass false only in test/dev environments using unsigned mock procedures.
   */
  requireSignature?: boolean
  /**
   * Optional governance state. When provided:
   *  - confidence weights may be overridden by accepted parameter_change proposals
   *  - maturity overrides from accepted maturity_override proposals are applied
   *  - suspended/blacklisted agent DIDs are noted in the result
   */
  governance?: GovernanceState
}

export async function runPipeline(
  ku: KnowledgeUnit,
  graph: RelationGraph,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  // Stage 1: Source verification
  const stage1 = await runStage1(ku, {
    mockMode: options.mockStage1,
    mockResults: options.stage1MockResults,
  })

  // Stage 2: Graph consistency
  const stage2 = await runStage2(ku, graph)

  // Stage 3: Independent corroboration (optional, LLM-opinion path)
  let stage3: Stage3Result | undefined
  if (options.runStage3 && options.agents && options.agents.length > 0) {
    const minAccuracy = options.governance?.parameters?.minCalibrationAccuracy ?? 0
    let eligibleAgents = options.agents
    if (minAccuracy > 0) {
      const results = await Promise.all(
        options.agents.map(agent => runCalibration(agent, minAccuracy))
      )
      eligibleAgents = options.agents.filter((_, i) => results[i].passesThreshold)
    }
    if (eligibleAgents.length > 0) {
      stage3 = await runStage3(ku, eligibleAgents)
    }
  }

  // Phase 5: Replication-based verification
  let replication: ReplicationRunResult[] | undefined
  if (options.replicationAgents && options.replicationAgents.length > 0) {
    replication = await runReplication(ku, options.replicationAgents, {
      requireSignature: options.requireSignature,
    })
  }

  // Phase 5: Retrieval-Augmented Verification
  let rav: RAVResult[] | undefined
  if (options.entailmentChecker) {
    rav = await ravVerify(ku, options.entailmentChecker, options.ravOptions)
  }

  // Governance: resolve weight overrides from accepted parameter_change proposals
  const effectiveWeights = options.governance
    ? resolveGovernanceWeights(options.weights, options.governance)
    : options.weights

  // Compute confidence
  const pipelineScores: PipelineScores = {
    stage1Score: stage1.stage1Score,
    stage2Score: stage2.stage2Score,
    stage3Score: stage3?.stage3Score,
    coherenceScore: stage2.coherenceScore,
    hasConflicts: stage2.contradictions.length > 0 ||
      stage2.consilienceViolations.some(v => v.severity === 'reject'),
  }

  const confidence = computeConfidence(ku, pipelineScores, effectiveWeights)

  // Maturity: use replication-based path if any claim has a VerificationProcedure
  const hasVerifiableClaims = ku.structured.claims.some(c => c.verificationProcedure != null)
  const maxAchievable = computeMaxAchievableConfidence(
    effectiveWeights ?? DEFAULT_WEIGHTS,
    !options.mockStage1 && stage1.stage1Score > 0,
    stage3 !== undefined,
  )
  let maturity = hasVerifiableClaims
    ? computeMaturityFromReplications(ku)
    : computeMaturity(confidence.aggregate, ku.reviews.length, maxAchievable)

  // Governance: apply maturity override if one exists for this KU
  let maturityOverrideApplied = false
  if (options.governance?.maturityOverrides[ku.id] != null) {
    maturity = options.governance.maturityOverrides[ku.id]
    maturityOverrideApplied = true
  }

  return {
    stage1,
    stage2,
    stage3,
    replication,
    rav,
    confidence,
    maturity,
    checkedAt: new Date().toISOString(),
    maturityOverrideApplied,
  }
}

/**
 * Extract confidence weight overrides from governance parameter_change outcomes.
 * Only dot-paths under "weights." are applied; others are silently ignored.
 * Note: this reads accepted outcomes stored in governance state — the caller
 * should call store.computeGovernanceState() to get an up-to-date snapshot.
 */
function resolveGovernanceWeights(
  base: ConfidenceWeights | undefined,
  state: GovernanceState
): ConfidenceWeights | undefined {
  const weightOverrides: Record<string, number> = {}

  for (const outcome of state.outcomes) {
    if (outcome.verdict !== 'accepted') continue
    // We only have outcomes here; to apply parameter changes we need the original
    // proposal payload. GovernanceState doesn't store closed proposals inline,
    // so weight overrides must be pre-applied into governance.parameters by
    // GovernanceEngine.applyParameterChange() at finalization time.
    // This is a no-op guard; the real override path is via GovernanceParameters.
  }

  // The primary mechanism: governance.parameters may carry already-applied weight
  // values via paramPath "weights.*" applied at finalization.
  // For now, forward any explicit base weights and return unchanged.
  if (Object.keys(weightOverrides).length === 0) return base

  const merged: ConfidenceWeights = { ...DEFAULT_WEIGHTS, ...base }
  for (const [k, v] of Object.entries(weightOverrides)) {
    (merged as unknown as Record<string, unknown>)[k] = v
  }
  return merged
}
