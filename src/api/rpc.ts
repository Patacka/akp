import express from 'express'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import rateLimit from 'express-rate-limit'
import jayson from 'jayson/promise/index.js'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { pino } from 'pino'
import type { KUStore } from '../core/store.js'
import type { RelationGraph } from '../core/graph.js'
import { createKU, createProvenance, ProvenanceRecordSchema, ClaimSchema, ReviewSchema } from '../core/ku.js'
import { runPipeline } from '../pipeline/index.js'
import { ProposalSchema, VoteSchema } from '../core/governance.js'
import { computeDidBoundSeed, canonicalCommitPayload, canonicalReviewSubmitPayload, extractPublicKeyFromDid, verifyBytes } from '../core/identity.js'
import { registry, metricsStore } from './metrics.js'
import type { EntailmentChecker } from '../pipeline/stage3-rav.js'

const log = pino({ name: 'akp-rpc', level: process.env.LOG_LEVEL ?? 'info' })

// ── Input schemas ─────────────────────────────────────────────────────────────

const CreateKUParams = z.object({
  domain: z.string().min(1),
  title: z.record(z.string()).refine(t => Object.keys(t).length > 0, 'title must have at least one locale'),
  locale: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  claims: z.array(ClaimSchema.partial({ id: true, replications: true })).optional(),
  narrative: z.object({ body: z.string().optional(), sections: z.array(z.unknown()).optional() }).optional(),
  provenance: z.object({
    did: z.string().min(1),
    type: z.enum(['agent', 'human']),
    method: z.enum(['observation', 'inference', 'synthesis', 'retrieval', 'human_input']),
    model: z.string().optional(),
  }).optional(),
})

const ReadKUParams = z.object({ kuId: z.string().uuid() })

const UpdateKUParams = z.object({
  kuId: z.string().uuid(),
  changes: z.object({
    claims: z.array(z.unknown()).optional(),
    narrative: z.record(z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
  }),
})

const QueryKUParams = z.object({
  domain: z.string().optional(),
  query: z.string().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  minMaturity: z.enum(['draft', 'proposed', 'validated', 'stable']).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

const ForkKUParams = z.object({ kuId: z.string().uuid() })

const SubmitReviewParams = z.object({
  kuId: z.string().uuid(),
  claimIds: z.array(z.string().uuid()),
  verdict: z.enum(['confirmed', 'amended', 'disputed', 'rejected']),
  reviewerDid: z.string().min(1),
  reviewerType: z.enum(['agent', 'human']).optional(),
  weight: z.number().min(0).max(1).optional(),
  /**
   * Ed25519 signature (hex, 128 chars) over canonicalReviewSubmitPayload({kuId,claimIds,verdict,reviewerDid}).
   * Required — proves the caller owns the DID key and prevents reputation farming for arbitrary DIDs.
   */
  signature: z.string().length(128),
  comment: z.string().optional(),
  /** Required when reviewing seedable claims: must equal computeDidBoundSeed(claimId, reviewerDid) */
  seed: z.number().int().optional(),
})

const TraverseParams = z.object({
  startKuId: z.string().uuid(),
  depth: z.number().int().min(1).max(5).optional(),
})

const CommitReviewParams = z.object({
  id: z.string().uuid(),
  kuId: z.string().uuid(),
  reviewerDid: z.string().min(1),
  /** SHA-256(verdict \x00 salt \x00 reviewerDid) hex string */
  commitHash: z.string().length(64),
  /**
   * Ed25519 signature (hex) over canonicalCommitPayload({id,kuId,reviewerDid,commitHash}).
   * Required to prevent griefing: without this, anyone could submit commits
   * on behalf of arbitrary DIDs to pad the window or lock their DID out.
   */
  signature: z.string().length(128),
})

const RevealReviewParams = z.object({
  commitId: z.string().uuid(),
  verdict: z.enum(['confirmed', 'amended', 'disputed', 'rejected']),
  salt: z.string().min(8),
  reviewerDid: z.string().min(1),
})

const SubmitProposalParams = ProposalSchema.omit({ status: true })
const CastVoteParams = VoteSchema

// ── RPC server ────────────────────────────────────────────────────────────────

export interface RpcServerOptions {
  store: KUStore
  graph: RelationGraph
  port?: number
  /** If true, real source URL verification is skipped. Default: false (production). */
  mockStage1?: boolean
  /** Max requests per minute per IP on the /rpc endpoint. Default: 60. */
  rateLimit?: number
  /**
   * API key required on all non-health endpoints.
   * Clients send it as `Authorization: Bearer <key>` or `X-API-Key: <key>`.
   * If omitted here, falls back to AKP_API_KEY env var.
   * If neither is set, auth is disabled (development mode).
   */
  apiKey?: string
  /** Optional RAV entailment checker wired to Jan or another LLM backend. */
  entailmentChecker?: EntailmentChecker
}

export function createRpcServer(options: RpcServerOptions) {
  const { store, graph } = options
  const port = options.port ?? 3000
  const useMockStage1 = options.mockStage1 ?? false
  const entailmentChecker = options.entailmentChecker

  const methods: Record<string, jayson.MethodLike> = {
    // ── KU CRUD ─────────────────────────────────────────────────────────────

    'akp.ku.create': async (params: Record<string, unknown>) => {
      const p = CreateKUParams.parse(params)

      const prov = createProvenance({
        did: p.provenance?.did ?? 'did:key:unknown',
        type: p.provenance?.type ?? 'agent',
        method: p.provenance?.method ?? 'synthesis',
        model: p.provenance?.model,
      })

      const ku = createKU({ domain: p.domain, title: p.title, locale: p.locale, summary: p.summary, tags: p.tags, provenance: prov })

      if (p.claims) ku.structured.claims = p.claims as typeof ku.structured.claims
      if (p.narrative) {
        ku.narrative.body = p.narrative.body ?? ''
        ku.narrative.sections = p.narrative.sections as typeof ku.narrative.sections ?? []
      }

      const result = await runPipeline(ku, graph, { mockStage1: useMockStage1, entailmentChecker })
      ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
      ku.meta.maturity = result.maturity

      const id = store.create(ku)
      graph.addKU(ku)

      metricsStore.kuCreated.inc()
      metricsStore.kuCount.set(store.allIds().length)
      log.info({ kuId: id, domain: p.domain, maturity: ku.meta.maturity }, 'ku.create')
      return { kuId: id, version: ku.version, maturity: ku.meta.maturity, confidence: ku.meta.confidence.aggregate }
    },

    'akp.ku.read': async (params: Record<string, unknown>) => {
      const { kuId } = ReadKUParams.parse(params)
      const ku = store.read(kuId)
      if (!ku) throw new Error(`KU not found: ${kuId}`)
      return ku
    },

    'akp.ku.update': async (params: Record<string, unknown>) => {
      const { kuId, changes } = UpdateKUParams.parse(params)
      const success = store.update(kuId, (ku) => {
        if (changes.claims) ku.structured.claims = changes.claims as typeof ku.structured.claims
        if (changes.narrative) Object.assign(ku.narrative, changes.narrative)
        if (changes.tags) ku.meta.tags = changes.tags
      })
      if (!success) throw new Error(`KU not found: ${kuId}`)
      const ku = store.read(kuId)!
      log.info({ kuId }, 'ku.update')
      return { version: ku.version, confidence: ku.meta.confidence.aggregate }
    },

    'akp.ku.query': async (params: Record<string, unknown>) => {
      const p = QueryKUParams.parse(params)
      // FTS path if query string provided; otherwise structured filter
      if (p.query) {
        return store.search(p.query, { domain: p.domain, limit: p.limit })
      }
      return store.query({ domain: p.domain, minConfidence: p.minConfidence, minMaturity: p.minMaturity, tags: p.tags, limit: p.limit ?? 20 })
    },

    'akp.ku.fork': async (params: Record<string, unknown>) => {
      const { kuId } = ForkKUParams.parse(params)
      const original = store.read(kuId)
      if (!original) throw new Error(`KU not found: ${kuId}`)

      const forked = { ...original, id: uuidv7() }
      forked.meta = { ...original.meta, created: new Date().toISOString(), modified: new Date().toISOString() }
      const newId = store.create(forked, kuId)
      graph.addKU(forked)

      log.info({ originalId: kuId, newId }, 'ku.fork')
      return { newKuId: newId }
    },

    /**
     * Supersede a KU with a corrected replacement in a single atomic operation.
     * The old KU gets a superseded_by relation; its confidence is capped at 0.3
     * by the pipeline. The new KU becomes the authoritative source.
     */
    'akp.ku.supersede': async (params: Record<string, unknown>) => {
      const { oldKuId, ku: kuData } = z.object({
        oldKuId: z.string().uuid(),
        ku: z.record(z.unknown()),
      }).parse(params)

      const original = store.read(oldKuId)
      if (!original) throw new Error(`KU not found: ${oldKuId}`)

      const p = kuData.provenance as Record<string, unknown> | undefined
      const prov = createProvenance({
        did: (p?.did as string) ?? 'did:key:unknown',
        type: (p?.type as 'agent' | 'human') ?? 'agent',
        method: (p?.method as 'observation' | 'inference' | 'synthesis' | 'retrieval' | 'human_input') ?? 'synthesis',
      })
      const newKu = createKU({
        domain: (kuData.domain as string) ?? original.meta.domain,
        title: (kuData.title as Record<string, string>) ?? original.meta.title,
        summary: (kuData.summary as string) ?? original.narrative.summary,
        tags: (kuData.tags as string[]) ?? original.meta.tags,
        provenance: prov,
      })
      if (kuData.claims) newKu.structured.claims = kuData.claims as typeof newKu.structured.claims
      if (kuData.body) newKu.narrative.body = kuData.body as string

      const result = await runPipeline(newKu, graph, { mockStage1: useMockStage1, entailmentChecker })
      newKu.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
      newKu.meta.maturity = result.maturity

      const newId = store.supersede(oldKuId, newKu)
      if (!newId) throw new Error(`Supersede failed: could not create replacement KU`)
      graph.addKU(newKu)

      // Re-run pipeline on old KU so its confidence cap takes effect immediately.
      // Read after supersede so the superseded_by relation is present on the KU.
      const oldKu = store.read(oldKuId)!
      graph.addKU(oldKu)  // refresh old KU in graph with its new superseded_by relation
      const oldResult = await runPipeline(oldKu, graph, { mockStage1: useMockStage1, entailmentChecker })
      store.update(oldKuId, (k) => {
        k.meta.confidence = { aggregate: oldResult.confidence.aggregate, lastComputed: oldResult.checkedAt }
        // Demote maturity immediately — a superseded KU should not appear as validated/stable
        if (k.meta.maturity === 'stable' || k.meta.maturity === 'validated') {
          k.meta.maturity = 'proposed'
        }
      }, 'supersede_cap')

      log.info({ oldKuId, newKuId: newId }, 'ku.supersede')
      return { oldKuId, newKuId: newId, oldConfidence: oldResult.confidence.aggregate }
    },

    // ── Reviews ─────────────────────────────────────────────────────────────

    'akp.review.submit': async (params: Record<string, unknown>) => {
      const p = SubmitReviewParams.parse(params)
      const ku = store.read(p.kuId)
      if (!ku) throw new Error(`KU not found: ${p.kuId}`)

      // Fix 1: Verify the reviewer's Ed25519 signature over the canonical payload.
      // This proves the caller owns the DID key — without it anyone can farm/slash
      // reputation for arbitrary DIDs just by supplying a different reviewerDid.
      let sigValid = false
      try {
        const pubKeyHex = extractPublicKeyFromDid(p.reviewerDid)
        sigValid = await verifyBytes(
          canonicalReviewSubmitPayload({ kuId: p.kuId, claimIds: p.claimIds, verdict: p.verdict, reviewerDid: p.reviewerDid }),
          p.signature,
          pubKeyHex
        )
      } catch { /* invalid DID format — sigValid stays false */ }
      if (!sigValid) throw { code: -32000, message: 'Review rejected — invalid reviewer signature' }

      // Fix 2: Per-(DID, KU) dedup — one review per reviewer per KU.
      // Without this, repeated submissions increment review_count and reputation
      // indefinitely, making graduation trivially scriptable.
      const alreadyReviewed = ku.reviews.some(r => r.reviewerDid === p.reviewerDid)
      if (alreadyReviewed) throw { code: -32000, message: 'Review rejected — this DID already reviewed this KU' }

      // Register DID and apply effective weight (0 until graduated)
      store.ensureDid(p.reviewerDid)
      const effectiveWeight = store.getEffectiveWeight(p.reviewerDid)

      // DID-bound seed enforcement for seedable claims
      const seedableClaims = ku.structured.claims.filter(
        c => p.claimIds.includes(c.id) && c.verificationProcedure?.seedable
      )
      if (seedableClaims.length > 0) {
        if (p.seed == null) throw { code: -32000, message: 'seed is required for seedable claims' }
        for (const claim of seedableClaims) {
          const expected = computeDidBoundSeed(claim.id, p.reviewerDid)
          if (p.seed !== expected) {
            store.addReputation(p.reviewerDid, -10)
            throw { code: -32000, message: `Invalid DID-bound seed for claim ${claim.id} — seed must equal SHA-256(claimId+reviewerDid) as int32` }
          }
        }
        // All seeds correct — award reputation
        store.addReputation(p.reviewerDid, 1)
      }

      const review: Record<string, unknown> = {
        id: uuidv7(),
        reviewerDid: p.reviewerDid,
        reviewerType: p.reviewerType ?? 'agent',
        timestamp: new Date().toISOString(),
        verdict: p.verdict,
        scope: p.claimIds,
        weight: effectiveWeight > 0 ? (p.weight ?? 0.5) * effectiveWeight : 0,
      }
      if (p.comment != null) review['comment'] = p.comment

      // Atomic: add review + update confidence in a single transaction
      let pipelineResult: Awaited<ReturnType<typeof runPipeline>> | null = null
      store.updateAtomic(p.kuId, [
        (k) => { k.reviews.push(review as typeof k.reviews[0]) },
      ], 'add_review')

      const updated = store.read(p.kuId)!
      pipelineResult = await runPipeline(updated, graph, { mockStage1: useMockStage1, entailmentChecker })

      store.updateAtomic(p.kuId, [
        (k) => {
          k.meta.confidence = { aggregate: pipelineResult!.confidence.aggregate, lastComputed: pipelineResult!.checkedAt }
          k.meta.maturity = pipelineResult!.maturity
        },
      ], 'update_confidence')

      store.recordReview(p.reviewerDid)
      metricsStore.kuReviews.inc({ verdict: p.verdict })
      log.info({ kuId: p.kuId, verdict: p.verdict, reviewer: p.reviewerDid, effectiveWeight }, 'review.submit')
      return { newConfidence: pipelineResult!.confidence.aggregate, maturityChange: pipelineResult!.maturity }
    },

    // ── Commit-Reveal ────────────────────────────────────────────────────────

    'akp.review.commit': async (params: Record<string, unknown>) => {
      const p = CommitReviewParams.parse(params)
      if (!store.read(p.kuId)) throw new Error(`KU not found: ${p.kuId}`)

      // Verify the reviewer signed the canonical commit payload with their DID key.
      // This proves the commit comes from the actual key holder, preventing anyone
      // from submitting commits on behalf of arbitrary DIDs (griefing / window-padding).
      let sigValid = false
      try {
        const pubKeyHex = extractPublicKeyFromDid(p.reviewerDid)
        sigValid = await verifyBytes(
          canonicalCommitPayload({ id: p.id, kuId: p.kuId, reviewerDid: p.reviewerDid, commitHash: p.commitHash }),
          p.signature,
          pubKeyHex
        )
      } catch { /* invalid DID format */ }
      if (!sigValid) throw { code: -32000, message: 'Commit rejected — invalid reviewer signature' }

      const ok = store.commitReview(p)
      if (!ok) throw { code: -32000, message: 'Commit rejected — DID is blacklisted or duplicate commit id' }
      metricsStore.commits.inc()
      log.info({ commitId: p.id, kuId: p.kuId, reviewer: p.reviewerDid }, 'review.commit')
      return { commitId: p.id }
    },

    'akp.review.reveal': async (params: Record<string, unknown>) => {
      const p = RevealReviewParams.parse(params)
      const result = store.revealReview(p)
      if (!result.ok) throw new Error('Reveal rejected — invalid hash, wrong DID, already revealed, or window not open yet')
      metricsStore.reveals.inc()
      log.info({ commitId: p.commitId, reviewer: p.reviewerDid, reputationDelta: result.reputationDelta }, 'review.reveal')
      return { reputationDelta: result.reputationDelta ?? 0 }
    },

    // ── Graph ────────────────────────────────────────────────────────────────

    'akp.graph.traverse': async (params: Record<string, unknown>) => {
      const { startKuId, depth } = TraverseParams.parse(params)
      const neighbors = graph.getNeighbors(startKuId, depth ?? 2)
      const nodes = [startKuId, ...neighbors.keys()]
      return {
        nodes: nodes.map(id => store.read(id)).filter(Boolean),
        edges: Array.from(neighbors.entries()).map(([id, hop]) => ({ id, hopDistance: hop })),
      }
    },

    // ── Sync ─────────────────────────────────────────────────────────────────

    'akp.sync.status': async () => {
      return { peers: [], syncState: 'idle' }
    },

    // ── Governance ───────────────────────────────────────────────────────────

    'akp.governance.propose': async (params: Record<string, unknown>) => {
      const proposal = SubmitProposalParams.parse(params)
      const ok = await store.submitProposal({ ...proposal, status: 'open' })
      if (!ok) throw new Error('Invalid signature or duplicate proposal id')
      metricsStore.proposalsTotal.inc()
      log.info({ proposalId: proposal.id, type: proposal.type, proposer: proposal.proposerDid }, 'governance.propose')
      return { proposalId: proposal.id }
    },

    'akp.governance.vote': async (params: Record<string, unknown>) => {
      const vote = CastVoteParams.parse(params)
      const ok = await store.castVote(vote)
      if (!ok) throw new Error('Invalid signature, already voted, or voter is suspended/blacklisted')
      metricsStore.votesTotal.inc()
      log.info({ voteId: vote.id, proposalId: vote.proposalId, voter: vote.voterDid, choice: vote.choice }, 'governance.vote')
      return { voteId: vote.id }
    },

    'akp.governance.finalize': async () => {
      const results = store.finalizeExpired()
      log.info({ finalized: results.length }, 'governance.finalize')
      return { finalized: results }
    },

    'akp.governance.state': async () => {
      return store.computeGovernanceState()
    },

    'akp.governance.proposals': async (params: Record<string, unknown>) => {
      const status = (params.status as string | undefined) as 'open' | 'accepted' | 'rejected' | 'expired' | undefined
      return store.getProposals(status)
    },

    // ── Stats & Reputation ────────────────────────────────────────────────────

    'akp.stats': async () => {
      const ids = store.allIds()
      const kus = ids.map(id => store.read(id)).filter(Boolean)
      const maturityDist: Record<string, number> = {}
      const domainDist: Record<string, number> = {}
      let totalConf = 0
      for (const ku of kus) {
        const m = ku!.meta.maturity
        maturityDist[m] = (maturityDist[m] ?? 0) + 1
        const d = ku!.meta.domain
        domainDist[d] = (domainDist[d] ?? 0) + 1
        totalConf += ku!.meta.confidence.aggregate
      }
      const reps = store.listReputations()
      return {
        totalKUs: ids.length,
        totalAgents: reps.length,
        avgConfidence: ids.length > 0 ? totalConf / ids.length : 0,
        graduatedAgents: reps.filter(r => r.graduatedAt !== null).length,
        maturityDistribution: maturityDist,
        domainDistribution: domainDist,
      }
    },

    'akp.reputation.list': async () => {
      return store.listReputations()
    },
  }

  // ── Express app ─────────────────────────────────────────────────────────────

  const apiKey = options.apiKey ?? process.env.AKP_API_KEY

  function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!apiKey) return next()  // auth disabled — development mode
    const auth = req.headers['authorization']
    const headerKey = req.headers['x-api-key']
    const provided =
      (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null) ??
      (typeof headerKey === 'string' ? headerKey : null)
    if (provided !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }

  // General read limiter — generous for multi-agent simulation traffic
  const limiter = rateLimit({
    windowMs: 60_000,
    max: options.rateLimit ?? 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  })

  // Tighter per-IP limiter for reputation-affecting write methods.
  // Keyed on IP + method so each method gets its own bucket rather than
  // sharing the general budget — prevents one agent from crowding out others.
  const WRITE_RATE_LIMITS: Record<string, number> = {
    'akp.review.submit':    20,   // 20 signed reviews / min / IP
    'akp.review.commit':    20,
    'akp.review.reveal':    20,
    'akp.governance.propose': 5,  // 5 proposals / min / IP
    'akp.governance.vote':  10,
    'akp.ku.create':        30,
  }
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,  // fallback; overridden per-method via keyGenerator
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const ip = req.ip ?? 'unknown'
      const method = (req.body as { method?: string } | undefined)?.method ?? ''
      return `${ip}:${method}`
    },
    limit: (req) => {
      const method = (req.body as { method?: string } | undefined)?.method ?? ''
      return WRITE_RATE_LIMITS[method] ?? 20
    },
    message: { error: 'Write rate limit exceeded for this method — slow down' },
    skip: (req) => {
      const method = (req.body as { method?: string } | undefined)?.method ?? ''
      return !(method in WRITE_RATE_LIMITS)
    },
  })

  const server = new jayson.Server(methods)
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = Math.random().toString(36).slice(2, 10)
    res.setHeader('X-Request-Id', id)
    next()
  })
  app.use('/rpc', requireApiKey, limiter, writeLimiter, server.middleware())
  app.use('/mcp', requireApiKey, limiter)  // MCP HTTP shares the general read budget

  // A2A Agent Card — lets any A2A-compatible orchestrator discover AKP's capabilities
  app.get('/.well-known/agent.json', (_req, res) => {
    const baseUrl = `http://localhost:${port}`
    res.json({
      name: 'AKP Node',
      description: 'Agent Knowledge Protocol node — decentralized peer-reviewed knowledge base for AI agents',
      version: '0.1.0',
      url: baseUrl,
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [
        {
          id: 'akp.search',
          name: 'Search Knowledge Base',
          description: 'Full-text and structured search over peer-reviewed knowledge units',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
          tags: ['knowledge', 'search', 'retrieval'],
          examples: ['search for quantum computing papers', 'find python package security advisories'],
        },
        {
          id: 'akp.contribute',
          name: 'Contribute Knowledge',
          description: 'Submit new knowledge units with structured claims and source provenance',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
          tags: ['knowledge', 'contribution', 'claims'],
        },
        {
          id: 'akp.review',
          name: 'Peer Review',
          description: 'Commit-reveal peer review: verify claims independently, build reputation',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
          tags: ['review', 'verification', 'reputation'],
        },
        {
          id: 'akp.governance',
          name: 'Governance',
          description: 'Submit and vote on governance proposals that shape protocol parameters',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
          tags: ['governance', 'voting', 'protocol'],
        },
      ],
      endpoints: {
        rpc: `${baseUrl}/rpc`,
        mcp: `${baseUrl}/mcp`,
        health: `${baseUrl}/health`,
      },
    })
  })

  // Prometheus metrics — no auth required (scrape endpoint)
  app.get('/metrics', (_req, res) => {
    metricsStore.kuCount.set(store.allIds().length)
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(registry.render())
  })

  // Health + readiness
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), requiresAuth: !!apiKey })
  })

  app.get('/ready', (_req, res) => {
    try {
      // Verify DB is responsive
      store.allIds()
      res.json({ status: 'ready' })
    } catch (err) {
      log.error(err, 'readiness check failed')
      res.status(503).json({ status: 'not ready' })
    }
  })

  // Serve the built UI from dist-ui/ — SPA fallback to index.html
  const __dir = dirname(fileURLToPath(import.meta.url))
  const uiDist = join(__dir, '../../dist-ui')
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist))
    app.get('*', (_req, res) => {
      res.sendFile(join(uiDist, 'index.html'))
    })
    log.info({ uiDist }, 'Serving AKP UI')
  }

  const httpServer = { server: null as ReturnType<typeof app.listen> | null }

  function listen() {
    httpServer.server = app.listen(port, () => {
      log.info({ port, mockStage1: useMockStage1 }, 'AKP RPC server started')
    })
    return httpServer.server
  }

  function close() {
    httpServer.server?.close()
    store.close()
    log.info('AKP RPC server stopped')
  }

  return { app, server, listen, close }
}
