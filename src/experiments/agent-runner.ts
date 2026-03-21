/**
 * agent-runner.ts — A single AKP agent with its own identity, commit-reveal
 * state, and LLM backend.
 *
 * Each AgentRunner represents one autonomous participant in the AKP network.
 * It can:
 *  - Contribute new KUs (with live claim verification)
 *  - Review existing KUs via commit-reveal (Phase 1 + Phase 2)
 *  - Participate in governance
 *
 * For experiments the LLM reasoning is optional — if no LLM agent is provided
 * the runner falls back to the provided `fallbackVerdict` (useful for
 * simulating honest/adversarial behaviour deterministically).
 */

import { createHash, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { generateIdentity, type Identity } from '../core/identity.js'
import type { KUStore } from '../core/store.js'
import type { RelationGraph } from '../core/graph.js'
import { createKU, createProvenance, type KnowledgeUnit } from '../core/ku.js'
import { runPipeline } from '../pipeline/index.js'
import type { LLMAgent } from '../pipeline/stage3.js'
import type { MetricsCollector, Verdict } from './metrics.js'

export interface PendingCommit {
  commitId: string
  kuId: string
  verdict: Verdict
  salt: string
}

export interface AgentRunnerOptions {
  /** Human-readable label, used in logs and metrics */
  id: string
  identity: Identity
  store: KUStore
  graph: RelationGraph
  metrics: MetricsCollector
  /**
   * Optional LLM backend. When provided, the agent asks the LLM to reason
   * about verification output and choose a verdict.
   * When absent, `fallbackVerdict` is used every time.
   */
  llm?: LLMAgent
  /**
   * Verdict returned when no LLM is available, or when the LLM call fails.
   * Use 'confirmed' for honest agents, 'disputed' for adversarial ones.
   * Default: 'confirmed'
   */
  fallbackVerdict?: Verdict
  /** Whether to log individual actions to stdout. Default: false */
  verbose?: boolean
}

export class AgentRunner {
  readonly id: string
  readonly did: string
  private identity: Identity
  private store: KUStore
  private graph: RelationGraph
  private metrics: MetricsCollector
  private llm?: LLMAgent
  private fallbackVerdict: Verdict
  private verbose: boolean

  /** Commits not yet revealed, indexed by kuId for easy lookup */
  private pendingCommits: Map<string, PendingCommit> = new Map()

  /** KU IDs that received a new review this round and need confidence recompute */
  dirtyKuIds: Set<string> = new Set()

  constructor(opts: AgentRunnerOptions) {
    this.id = opts.id
    this.identity = opts.identity
    this.did = opts.identity.did
    this.store = opts.store
    this.graph = opts.graph
    this.metrics = opts.metrics
    this.llm = opts.llm
    this.fallbackVerdict = opts.fallbackVerdict ?? 'confirmed'
    this.verbose = opts.verbose ?? false

    this.store.ensureDid(this.did)
  }

  // ── Commit-reveal ────────────────────────────────────────────────────────────

  /**
   * Phase 1: examine a KU's claims, run verification if possible, decide
   * verdict, and commit.  Does NOT reveal yet.
   *
   * @param kuId           - KU to review
   * @param round          - current experiment round (for metrics)
   * @param groundTruth    - expected correct verdict (for accuracy metrics)
   * @param verdictOverride - if provided, skip LLM/fallback and use this verdict directly.
   *                         Use this in experiments to give agents per-KU correct behaviour
   *                         (e.g. all agents confirm the anchor KU; sybils confirm false KUs).
   */
  async commitReview(kuId: string, round: number, groundTruth?: Verdict, verdictOverride?: Verdict): Promise<boolean> {
    if (this.pendingCommits.has(kuId)) {
      this.log(`already committed on ${kuId.slice(0, 8)} — skipping`)
      return false
    }

    const ku = this.store.read(kuId)
    if (!ku) return false

    const verdict = verdictOverride ?? await this.decideVerdict(ku)
    const salt = randomBytes(16).toString('hex')
    const commitId = uuidv7()
    const hash = this.makeCommitHash(verdict, salt, this.did)

    const ok = this.store.commitReview({ id: commitId, kuId, reviewerDid: this.did, commitHash: hash })
    if (!ok) {
      this.log(`commit rejected for ${kuId.slice(0, 8)} (blacklisted?)`)
      return false
    }

    this.pendingCommits.set(kuId, { commitId, kuId, verdict, salt })
    this.metrics.recordCommit({
      round,
      agentId: this.id,
      kuId,
      verdict,
      isGroundTruth: groundTruth !== undefined ? verdict === groundTruth : true,
      timestampMs: Date.now(),
    })
    this.log(`committed [${verdict}] on ${kuId.slice(0, 8)}`)
    return true
  }

  /**
   * Phase 2: reveal all pending commits whose kuId has enough commits
   * to open the reveal window.
   */
  async revealPending(round: number): Promise<number> {
    let revealed = 0
    for (const [kuId, pending] of this.pendingCommits) {
      const result = this.store.revealReview({
        commitId: pending.commitId,
        verdict: pending.verdict,
        salt: pending.salt,
        reviewerDid: this.did,
      })

      if (result.ok) {
        this.pendingCommits.delete(kuId)
        this.metrics.recordReveal({
          round,
          agentId: this.id,
          kuId,
          verdict: pending.verdict,
          reputationDelta: result.reputationDelta ?? 0,
          ok: true,
          timestampMs: Date.now(),
        })
        this.log(`revealed [${pending.verdict}] on ${kuId.slice(0, 8)} → Δrep=${result.reputationDelta ?? 0}`)
        revealed++
        this.dirtyKuIds.add(kuId)
      }
      // If not ok (window not open yet) — leave in pending, try next round
    }
    return revealed
  }

  /**
   * Recompute confidence for all KUs that received new reviews this round.
   * Call once per round after all agents have revealed, not once per reveal.
   */
  async recomputeDirty(): Promise<void> {
    for (const kuId of this.dirtyKuIds) {
      const ku = this.store.read(kuId)
      if (ku) {
        const pipeline = await runPipeline(ku, this.graph, { mockStage1: true })
        this.store.update(kuId, doc => {
          doc.meta.confidence = { aggregate: pipeline.confidence.aggregate, lastComputed: pipeline.checkedAt }
          doc.meta.maturity = pipeline.maturity
          const hasConflicts = pipeline.stage2.contradictions.length > 0
          if (hasConflicts && (doc.meta.maturity === 'stable' || doc.meta.maturity === 'validated')) {
            doc.meta.maturity = 'draft'
          }
        }, 'confidence-recompute')
      }
    }
    this.dirtyKuIds.clear()
  }

  /** Snapshot current reputation state into metrics */
  snapshotReputation(round: number) {
    const rep = this.store.getReputation(this.did)
    const weight = this.store.getEffectiveWeight(this.did)
    this.metrics.recordReputation({
      round,
      agentId: this.id,
      reputation: rep?.reputation ?? 0,
      effectiveWeight: weight,
      blacklisted: rep?.blacklisted ?? false,
      graduated: rep?.graduatedAt !== null && rep?.graduatedAt !== undefined,
    })
  }

  // ── Contribution ─────────────────────────────────────────────────────────────

  /**
   * Contribute a new KU. The agent generates the KU content (optionally via LLM)
   * or uses the provided structured content directly.
   */
  async contribute(
    content: {
      domain: string
      title: string
      summary: string
      claims: Array<{
        type: 'factual' | 'quantitative' | 'temporal'
        subject: string
        predicate: string
        object: unknown
        confidence: number
        validUntil?: string
      }>
    },
    round: number
  ): Promise<string> {
    const prov = createProvenance({ did: this.did, type: 'agent', method: 'observation' })
    const ku = createKU({
      domain: content.domain,
      title: { en: content.title },
      summary: content.summary,
      provenance: prov,
    })
    ku.structured.claims = content.claims.map(c => ({
      id: uuidv7(),
      provenanceRef: prov.id,
      replications: [],
      ...c,
    }))

    const result = await runPipeline(ku, this.graph, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity

    const id = this.store.create(ku)
    this.graph.addKU(ku)

    this.metrics.recordContribution({
      round,
      agentId: this.id,
      kuId: id,
      domain: content.domain,
      claimCount: ku.structured.claims.length,
      timestampMs: Date.now(),
    })
    this.log(`contributed KU ${id.slice(0, 8)} (${content.claims.length} claims)`)
    return id
  }

  // ── KU confidence snapshot ───────────────────────────────────────────────────

  snapshotKuConfidence(kuId: string, round: number) {
    const ku = this.store.read(kuId)
    if (!ku) return
    this.metrics.recordConfidence({
      round,
      kuId,
      confidence: ku.meta.confidence.aggregate,
      maturity: ku.meta.maturity,
      reviewCount: ku.reviews.length,
    })
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  get reputation(): number {
    return this.store.getReputation(this.did)?.reputation ?? 0
  }

  get effectiveWeight(): number {
    return this.store.getEffectiveWeight(this.did)
  }

  get isBlacklisted(): boolean {
    return this.store.getReputation(this.did)?.blacklisted ?? false
  }

  private async decideVerdict(ku: KnowledgeUnit): Promise<Verdict> {
    if (!this.llm) return this.fallbackVerdict

    // Run any available verification procedures to get ground data
    const verificationOutputs: string[] = []
    for (const claim of ku.structured.claims) {
      if (claim.verificationProcedure?.executable) {
        try {
          const { execSync } = await import('node:child_process')
          const out = execSync(claim.verificationProcedure.executable, {
            timeout: (claim.verificationProcedure.timeoutSeconds ?? 10) * 1000,
            encoding: 'utf8',
          }).trim()
          verificationOutputs.push(
            `Claim "${claim.subject} ${claim.predicate} ${JSON.stringify(claim.object)}":\n  Procedure output: ${out}`
          )
        } catch {
          verificationOutputs.push(
            `Claim "${claim.subject} ${claim.predicate} ${JSON.stringify(claim.object)}":\n  Verification failed (timeout or error)`
          )
        }
      } else {
        verificationOutputs.push(
          `Claim "${claim.subject} ${claim.predicate} ${JSON.stringify(claim.object)}" (no verification procedure — use your knowledge)`
        )
      }
    }

    const systemPrompt = `You are an AKP peer reviewer. You independently verify knowledge claims and issue a verdict.
Your reputation is on the line — a wrong verdict costs you -10 reputation and blacklists you.
Be accurate. If verification output matches the claim, say confirmed. If it contradicts, say disputed. If partially wrong, say amended.`

    const userPrompt = `KU Domain: ${ku.meta.domain}
Title: ${Object.values(ku.meta.title)[0]}
Summary: ${ku.narrative.summary}

Verification results:
${verificationOutputs.join('\n\n')}

Issue a verdict.`

    try {
      const raw = await this.llm.call(systemPrompt, userPrompt)
      const parsed = JSON.parse(raw) as { verdict?: string }
      const v = parsed.verdict
      if (v === 'confirmed' || v === 'disputed' || v === 'amended' || v === 'rejected') {
        return v as Verdict
      }
    } catch {
      this.log(`LLM call failed — falling back to ${this.fallbackVerdict}`)
    }

    return this.fallbackVerdict
  }

  private makeCommitHash(verdict: string, salt: string, did: string): string {
    return createHash('sha256')
      .update(verdict).update('\x00')
      .update(salt).update('\x00')
      .update(did)
      .digest('hex')
  }

  private log(msg: string) {
    if (this.verbose) console.log(`  [${this.id}] ${msg}`)
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createAgentRunner(
  id: string,
  opts: Omit<AgentRunnerOptions, 'id' | 'identity'>
): Promise<AgentRunner> {
  const identity = await generateIdentity()
  return new AgentRunner({ ...opts, id, identity })
}
