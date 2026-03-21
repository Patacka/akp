/**
 * metrics.ts — In-memory metrics collector for AKP network experiments.
 *
 * Collects per-round, per-agent, and per-KU events and computes:
 *  - Verdict accuracy rate
 *  - Consensus accuracy and latency
 *  - Reputation Gini coefficient
 *  - Confidence trajectory per KU
 *  - Blacklist / graduation rates
 */

export type Verdict = 'confirmed' | 'amended' | 'disputed' | 'rejected'

export interface CommitEvent {
  round: number
  agentId: string
  kuId: string
  verdict: Verdict
  isGroundTruth: boolean   // does verdict match the known-correct answer?
  timestampMs: number
}

export interface RevealEvent {
  round: number
  agentId: string
  kuId: string
  verdict: Verdict
  reputationDelta: number
  ok: boolean
  timestampMs: number
}

export interface ConfidenceSnapshot {
  round: number
  kuId: string
  confidence: number
  maturity: string
  reviewCount: number
}

export interface ReputationSnapshot {
  round: number
  agentId: string
  reputation: number
  effectiveWeight: number
  blacklisted: boolean
  graduated: boolean
}

export interface ContributionEvent {
  round: number
  agentId: string
  kuId: string
  domain: string
  claimCount: number
  timestampMs: number
}

export class MetricsCollector {
  readonly experimentId: string
  readonly startMs: number

  commits: CommitEvent[] = []
  reveals: RevealEvent[] = []
  confidenceSnapshots: ConfidenceSnapshot[] = []
  reputationSnapshots: ReputationSnapshot[] = []
  contributions: ContributionEvent[] = []

  constructor(experimentId: string) {
    this.experimentId = experimentId
    this.startMs = Date.now()
  }

  recordCommit(e: CommitEvent) { this.commits.push(e) }
  recordReveal(e: RevealEvent) { this.reveals.push(e) }
  recordConfidence(e: ConfidenceSnapshot) { this.confidenceSnapshots.push(e) }
  recordReputation(e: ReputationSnapshot) { this.reputationSnapshots.push(e) }
  recordContribution(e: ContributionEvent) { this.contributions.push(e) }

  // ── Derived metrics ──────────────────────────────────────────────────────────

  /** % of commits where the agent's verdict matches known ground truth */
  verdictAccuracyRate(): number {
    const withGroundTruth = this.commits.filter(c => c.isGroundTruth !== undefined)
    if (withGroundTruth.length === 0) return NaN
    return withGroundTruth.filter(c => c.isGroundTruth).length / withGroundTruth.length
  }

  /** % of reveals that were accepted (ok=true) */
  revealSuccessRate(): number {
    if (this.reveals.length === 0) return NaN
    return this.reveals.filter(r => r.ok).length / this.reveals.length
  }

  /** Rounds until a KU first has ≥2 reveals (consensus can form) */
  consensusLatencyByKu(): Map<string, number> {
    const revealsByKu = new Map<string, RevealEvent[]>()
    for (const r of this.reveals.filter(r => r.ok)) {
      const list = revealsByKu.get(r.kuId) ?? []
      list.push(r)
      revealsByKu.set(r.kuId, list)
    }
    const result = new Map<string, number>()
    for (const [kuId, events] of revealsByKu) {
      if (events.length >= 2) {
        const sorted = events.sort((a, b) => a.round - b.round)
        result.set(kuId, sorted[1].round)  // round of second reveal
      }
    }
    return result
  }

  /** Mean rounds to first consensus across all KUs that reached it */
  meanConsensusLatency(): number {
    const latencies = Array.from(this.consensusLatencyByKu().values())
    if (latencies.length === 0) return NaN
    return latencies.reduce((s, v) => s + v, 0) / latencies.length
  }

  /**
   * Gini coefficient of the final reputation distribution.
   * 0 = perfectly equal, 1 = one agent holds all reputation.
   *
   * Blacklisted agents have negative reputation; we shift all values up by
   * |min| so the distribution is non-negative before applying the formula.
   */
  reputationGini(): number {
    const finalReps = new Map<string, number>()
    for (const s of this.reputationSnapshots) {
      finalReps.set(s.agentId, s.reputation)
    }
    let values = Array.from(finalReps.values())
    if (values.length === 0) return NaN
    // Shift to non-negative
    const min = Math.min(...values)
    if (min < 0) values = values.map(v => v - min)
    values.sort((a, b) => a - b)
    const n = values.length
    const sum = values.reduce((s, v) => s + v, 0)
    if (sum === 0) return 0
    let gini = 0
    for (let i = 0; i < n; i++) {
      gini += (2 * (i + 1) - n - 1) * values[i]
    }
    return Math.max(0, Math.min(1, gini / (n * sum)))
  }

  /** % of agents that are blacklisted at experiment end */
  blacklistRate(): number {
    const finalByAgent = new Map<string, ReputationSnapshot>()
    for (const s of this.reputationSnapshots) finalByAgent.set(s.agentId, s)
    const all = Array.from(finalByAgent.values())
    if (all.length === 0) return NaN
    return all.filter(s => s.blacklisted).length / all.length
  }

  /** % of agents that graduated (effectiveWeight > 0) at experiment end */
  graduationRate(): number {
    const finalByAgent = new Map<string, ReputationSnapshot>()
    for (const s of this.reputationSnapshots) finalByAgent.set(s.agentId, s)
    const all = Array.from(finalByAgent.values())
    if (all.length === 0) return NaN
    return all.filter(s => s.graduated).length / all.length
  }

  /** Confidence trajectory for a given KU: array of [round, confidence] */
  confidenceTrajectory(kuId: string): Array<[number, number]> {
    return this.confidenceSnapshots
      .filter(s => s.kuId === kuId)
      .sort((a, b) => a.round - b.round)
      .map(s => [s.round, s.confidence])
  }

  /** Mean final confidence across all KUs that have at least one snapshot */
  meanFinalConfidence(): number {
    const finalByKu = new Map<string, ConfidenceSnapshot>()
    for (const s of this.confidenceSnapshots) {
      const prev = finalByKu.get(s.kuId)
      if (!prev || s.round > prev.round) finalByKu.set(s.kuId, s)
    }
    const values = Array.from(finalByKu.values()).map(s => s.confidence)
    if (values.length === 0) return NaN
    return values.reduce((s, v) => s + v, 0) / values.length
  }

  /** Reputation delta awarded per reveal, split by correct vs incorrect verdict */
  reputationByAccuracy(): { correctMean: number; incorrectMean: number } {
    const correct = this.reveals.filter(r => r.ok && r.reputationDelta > 0)
    const incorrect = this.reveals.filter(r => r.ok && r.reputationDelta < 0)
    const mean = (arr: RevealEvent[]) =>
      arr.length === 0 ? NaN : arr.reduce((s, r) => s + r.reputationDelta, 0) / arr.length
    return { correctMean: mean(correct), incorrectMean: mean(incorrect) }
  }

  // ── Summary report ───────────────────────────────────────────────────────────

  summary(): ExperimentSummary {
    const durationMs = Date.now() - this.startMs
    return {
      experimentId: this.experimentId,
      durationMs,
      rounds: Math.max(0, ...this.commits.map(c => c.round), ...this.reveals.map(r => r.round)),
      totalCommits: this.commits.length,
      totalReveals: this.reveals.length,
      totalContributions: this.contributions.length,
      verdictAccuracyRate: this.verdictAccuracyRate(),
      revealSuccessRate: this.revealSuccessRate(),
      meanConsensusLatencyRounds: this.meanConsensusLatency(),
      reputationGini: this.reputationGini(),
      blacklistRate: this.blacklistRate(),
      graduationRate: this.graduationRate(),
      meanFinalConfidence: this.meanFinalConfidence(),
      reputationByAccuracy: this.reputationByAccuracy(),
    }
  }

  printSummary() {
    const s = this.summary()
    const pct = (v: number) => isNaN(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`
    const f2 = (v: number) => isNaN(v) ? 'n/a' : v.toFixed(2)
    console.log('\n' + '═'.repeat(60))
    console.log(`  EXPERIMENT: ${s.experimentId}`)
    console.log('═'.repeat(60))
    console.log(`  Duration          : ${(s.durationMs / 1000).toFixed(1)}s`)
    console.log(`  Rounds            : ${s.rounds}`)
    console.log(`  Commits / Reveals : ${s.totalCommits} / ${s.totalReveals}`)
    console.log(`  Contributions     : ${s.totalContributions} KUs`)
    console.log('─'.repeat(60))
    console.log(`  Verdict accuracy  : ${pct(s.verdictAccuracyRate)}`)
    console.log(`  Reveal success    : ${pct(s.revealSuccessRate)}`)
    console.log(`  Mean consensus    : ${f2(s.meanConsensusLatencyRounds)} rounds`)
    console.log('─'.repeat(60))
    console.log(`  Reputation Gini   : ${f2(s.reputationGini)}  (0=equal, 1=monopoly)`)
    console.log(`  Blacklist rate    : ${pct(s.blacklistRate)}`)
    console.log(`  Graduation rate   : ${pct(s.graduationRate)}`)
    console.log(`  Mean confidence   : ${f2(s.meanFinalConfidence)}`)
    console.log('═'.repeat(60) + '\n')
  }
}

export interface ExperimentSummary {
  experimentId: string
  durationMs: number
  rounds: number
  totalCommits: number
  totalReveals: number
  totalContributions: number
  verdictAccuracyRate: number
  revealSuccessRate: number
  meanConsensusLatencyRounds: number
  reputationGini: number
  blacklistRate: number
  graduationRate: number
  meanFinalConfidence: number
  reputationByAccuracy: { correctMean: number; incorrectMean: number }
}
