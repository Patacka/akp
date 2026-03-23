import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Express } from 'express'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KUStore } from '../core/store.js'
import type { RelationGraph } from '../core/graph.js'
import { createKU, createProvenance } from '../core/ku.js'
import { runPipeline } from '../pipeline/index.js'
import {
  ProposalSchema,
  VoteSchema,
  canonicalProposalPayload,
  canonicalVotePayload,
  signGovernancePayload,
} from '../core/governance.js'
import {
  generateIdentity,
  type Identity,
  canonicalCommitPayload,
  signBytes,
} from '../core/identity.js'
import { createHash, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'

export interface McpServerOptions {
  store: KUStore
  graph: RelationGraph
  serverName?: string
  /**
   * Path to a JSON file holding the agent's Ed25519 identity { did, publicKeyHex, privateKeyHex }.
   * If the file does not exist a new identity is generated and saved there.
   * This identity is used for all commit-reveal commits and governance signatures,
   * so the agent accumulates real reputation across sessions.
   *
   * Default: ~/.akp/mcp-identity.json
   */
  identityPath?: string
}

// ── Identity persistence ───────────────────────────────────────────────────────

const DEFAULT_IDENTITY_DIR = join(process.env.HOME ?? process.cwd(), '.akp')
const DEFAULT_IDENTITY_PATH = join(DEFAULT_IDENTITY_DIR, 'mcp-identity.json')

async function loadOrCreateIdentity(path: string): Promise<Identity> {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as Identity
  } catch {
    // File doesn't exist — generate and persist
    mkdirSync(join(path, '..'), { recursive: true })
    const identity = await generateIdentity()
    writeFileSync(path, JSON.stringify(identity, null, 2))
    return identity
  }
}

// ── Commit hash (null-byte delimited, matches store implementation) ────────────

function makeCommitHash(verdict: string, salt: string, did: string): string {
  return createHash('sha256')
    .update(verdict).update('\x00')
    .update(salt).update('\x00')
    .update(did)
    .digest('hex')
}

// ── Server builder ─────────────────────────────────────────────────────────────

/** Build a fresh McpServer with all tools registered against the given store/graph/identity. */
function buildMcpServer(
  store: KUStore,
  graph: RelationGraph,
  name: string,
  identity: Identity
): McpServer {
  const server = new McpServer({ name, version: '0.1.0' })

  // ── Identity ─────────────────────────────────────────────────────────────────

  server.tool(
    'akp_my_identity',
    'Return this agent\'s DID, reputation score, and effective review weight in the AKP network',
    {},
    async () => {
      store.ensureDid(identity.did)
      const rep = store.getReputation(identity.did)
      const weight = store.getEffectiveWeight(identity.did)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            did: identity.did,
            reputation: rep?.reputation ?? 0,
            reviewCount: rep?.reviewCount ?? 0,
            blacklisted: rep?.blacklisted ?? false,
            graduatedAt: rep?.graduatedAt ?? null,
            effectiveWeight: weight,
          }, null, 2),
        }],
      }
    }
  )

  // ── Skills ────────────────────────────────────────────────────────────────────

  server.tool(
    'akp_skills',
    'List peer-reviewed skill KUs (domain="skill") — tools, MCP servers, and workflows contributed by other agents. Each skill KU contains claims describing serverUrl, toolSchema, and usage. Only returns KUs at or above minConfidence (default 0.7).',
    {
      minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold (default 0.7)'),
    },
    async ({ minConfidence }) => {
      const skills = store.query({ domain: 'skill', minConfidence: minConfidence ?? 0.7 })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            skills.map(ku => ({
              id: ku.id,
              title: ku.meta.title,
              maturity: ku.meta.maturity,
              confidence: ku.meta.confidence.aggregate,
              claims: ku.structured.claims.map(c => ({
                subject: c.subject,
                predicate: c.predicate,
                object: c.object,
              })),
            })),
            null, 2
          ),
        }],
      }
    }
  )

  // ── Search ────────────────────────────────────────────────────────────────────

  server.tool(
    'akp_search',
    'Search the AKP knowledge base for relevant knowledge units',
    {
      query: z.string().describe('Search query text'),
      domain: z.string().optional().describe('Filter by domain'),
      minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum results to return'),
    },
    async ({ query, domain, minConfidence, limit }) => {
      const results = query
        ? store.search(query, { domain, limit: limit ?? 10 })
        : store.query({ domain, minConfidence, limit: limit ?? 10 })

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            results.map(ku => ({
              id: ku.id,
              title: ku.meta.title,
              domain: ku.meta.domain,
              maturity: ku.meta.maturity,
              confidence: ku.meta.confidence.aggregate,
              summary: ku.narrative.summary,
              claimCount: ku.structured.claims.length,
            })),
            null, 2
          ),
        }],
      }
    }
  )

  // ── Read ──────────────────────────────────────────────────────────────────────

  server.tool(
    'akp_read',
    'Read a specific knowledge unit by ID',
    {
      kuId: z.string().uuid().describe('Knowledge Unit ID'),
      fields: z.array(z.string()).optional().describe('Fields to include (defaults to all)'),
    },
    async ({ kuId, fields }) => {
      const ku = store.read(kuId)
      if (!ku) return { content: [{ type: 'text', text: `Error: KU not found: ${kuId}` }], isError: true }

      const result = fields
        ? Object.fromEntries(fields.map(f => [f, (ku as Record<string, unknown>)[f]]))
        : ku

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // ── Graph traversal ───────────────────────────────────────────────────────────

  server.tool(
    'akp_traverse',
    'Traverse the knowledge graph from a starting KU to find related knowledge units',
    {
      kuId: z.string().uuid().describe('Starting Knowledge Unit ID'),
      depth: z.number().int().min(1).max(4).optional().describe('Hop depth (default: 2)'),
    },
    async ({ kuId, depth }) => {
      const ku = store.read(kuId)
      if (!ku) return { content: [{ type: 'text', text: `Error: KU not found: ${kuId}` }], isError: true }

      const neighbors = graph.getNeighbors(kuId, depth ?? 2)
      const nodeIds = [kuId, ...neighbors.keys()]
      const nodes = nodeIds.map(id => {
        const k = store.read(id)
        if (!k) return null
        return {
          id: k.id,
          title: k.meta.title,
          domain: k.meta.domain,
          maturity: k.meta.maturity,
          confidence: k.meta.confidence.aggregate,
          hopDistance: neighbors.get(id) ?? 0,
        }
      }).filter(Boolean)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ startKuId: kuId, nodes, totalFound: nodes.length }, null, 2),
        }],
      }
    }
  )

  // ── Contribute ────────────────────────────────────────────────────────────────

  server.tool(
    'akp_contribute',
    'Contribute a new knowledge unit to the AKP. Uses this agent\'s persistent DID for provenance.',
    {
      domain: z.string().describe('Knowledge domain (e.g. science, medicine, technology)'),
      title: z.string().describe('Title of the knowledge unit'),
      summary: z.string().describe('Brief summary of the knowledge'),
      body: z.string().optional().describe('Full markdown body'),
      claims: z.array(z.object({
        type: z.enum(['factual', 'quantitative', 'temporal']),
        subject: z.string(),
        predicate: z.string(),
        object: z.unknown(),
        confidence: z.number().min(0).max(1),
        validUntil: z.string().optional(),
      })).optional().describe('Structured claims'),
      sources: z.array(z.object({
        type: z.enum(['doi', 'url', 'pubmed', 'rfc', 'arxiv', 'isbn', 'other']),
        value: z.string(),
        title: z.string().optional(),
      })).optional().describe('Source references'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    async ({ domain, title, summary, body, claims, sources, tags }) => {
      const prov = createProvenance({
        did: identity.did,
        type: 'agent',
        method: 'synthesis',
        sources: sources?.map(s => ({ id: uuidv7(), ...s })),
      })

      const ku = createKU({ domain, title: { en: title }, summary, tags, provenance: prov })
      if (body) ku.narrative.body = body
      if (claims) {
        ku.structured.claims = claims.map(c => ({ replications: [], id: uuidv7(), provenanceRef: prov.id, ...c }))
      }

      const result = await runPipeline(ku, graph, { mockStage1: true })
      ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
      ku.meta.maturity = result.maturity

      const id = store.create(ku)
      graph.addKU(ku)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            kuId: id,
            agentDid: identity.did,
            maturity: ku.meta.maturity,
            confidence: ku.meta.confidence.aggregate,
            contradictions: result.stage2.contradictions.length,
          }, null, 2),
        }],
      }
    }
  )

  // ── Supersede ─────────────────────────────────────────────────────────────────

  server.tool(
    'akp_supersede',
    'Replace a stale or incorrect KU with a corrected version. The old KU gets a superseded_by relation and its confidence is capped.',
    {
      oldKuId: z.string().uuid().describe('ID of the KU being replaced'),
      domain: z.string().describe('Domain (usually same as old KU)'),
      title: z.string().describe('Title for the replacement KU'),
      summary: z.string().describe('Updated summary'),
      claims: z.array(z.object({
        type: z.enum(['factual', 'quantitative', 'temporal']),
        subject: z.string(),
        predicate: z.string(),
        object: z.unknown(),
        confidence: z.number().min(0).max(1),
        validUntil: z.string().optional(),
      })).describe('Corrected claims'),
    },
    async ({ oldKuId, domain, title, summary, claims }) => {
      const old = store.read(oldKuId)
      if (!old) return { content: [{ type: 'text', text: `Error: KU not found: ${oldKuId}` }], isError: true }

      const prov = createProvenance({ did: identity.did, type: 'agent', method: 'synthesis' })
      const newKu = createKU({ domain, title: { en: title }, summary, provenance: prov })
      newKu.structured.claims = claims.map(c => ({ replications: [], id: uuidv7(), provenanceRef: prov.id, ...c }))

      const result = await runPipeline(newKu, graph, { mockStage1: true })
      newKu.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
      newKu.meta.maturity = result.maturity

      const newId = store.supersede(oldKuId, newKu)
      if (!newId) return { content: [{ type: 'text', text: 'Error: supersede failed' }], isError: true }
      graph.addKU(newKu)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ oldKuId, newKuId: newId, agentDid: identity.did, newMaturity: newKu.meta.maturity }, null, 2),
        }],
      }
    }
  )

  // ── Commit-reveal review ──────────────────────────────────────────────────────

  server.tool(
    'akp_commit_review',
    'Phase 1 of commit-reveal peer review. Independently verify the KU\'s claims, decide your verdict, then commit (the verdict is hidden until reveal). Returns a commitId you must save for the reveal step.',
    {
      kuId: z.string().uuid().describe('ID of the KU to review'),
      verdict: z.enum(['confirmed', 'amended', 'disputed', 'rejected']).describe(
        'Your verdict after independently verifying all claims. confirmed=all correct, amended=details wrong, disputed=materially false, rejected=fabricated/spam'
      ),
      comment: z.string().optional().describe('Optional explanation (required for amended/disputed)'),
    },
    async ({ kuId, verdict, comment }) => {
      const ku = store.read(kuId)
      if (!ku) return { content: [{ type: 'text', text: `Error: KU not found: ${kuId}` }], isError: true }

      store.ensureDid(identity.did)

      const commitId = uuidv7()
      const salt = randomBytes(16).toString('hex')
      const hash = makeCommitHash(verdict, salt, identity.did)

      // Sign the commit payload with the agent's Ed25519 key
      const payload = canonicalCommitPayload({ id: commitId, kuId, reviewerDid: identity.did, commitHash: hash })
      const signature = await signBytes(payload, identity.privateKeyHex)

      // Store the commit (bypasses HTTP layer — uses store directly for MCP)
      const committed = store.commitReview({ id: commitId, kuId, reviewerDid: identity.did, commitHash: hash })
      if (!committed) {
        return {
          content: [{ type: 'text', text: 'Commit rejected — DID is blacklisted or duplicate commit id' }],
          isError: true,
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            commitId,
            salt,           // ⚠️ save this — you need it to reveal
            verdict,        // ⚠️ save this — you need it to reveal
            kuId,
            agentDid: identity.did,
            comment,
            instruction: 'Save commitId, salt, and verdict. Call akp_reveal_review once the reveal window opens (when enough commits exist for this KU).',
          }, null, 2),
        }],
      }
    }
  )

  server.tool(
    'akp_reveal_review',
    'Phase 2 of commit-reveal peer review. Reveal your previously committed verdict. The hash is verified; if correct and matching consensus you earn +1 reputation. Wrong verdict costs -10 and blacklists you.',
    {
      commitId: z.string().uuid().describe('The commitId returned by akp_commit_review'),
      verdict: z.enum(['confirmed', 'amended', 'disputed', 'rejected']).describe('Your verdict — must match what you committed'),
      salt: z.string().describe('The salt returned by akp_commit_review'),
    },
    async ({ commitId, verdict, salt }) => {
      const result = store.revealReview({ commitId, verdict, salt, reviewerDid: identity.did })

      if (!result.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              reason: 'Reveal rejected — hash mismatch, wrong DID, already revealed, or reveal window not open yet',
            }, null, 2),
          }],
          isError: true,
        }
      }

      // Recompute confidence now that the review is written into the KU document
      const commitRow = store['db'].prepare(
        'SELECT ku_id FROM review_commits WHERE id = ?'
      ).get(commitId) as { ku_id: string } | undefined
      if (commitRow) {
        const ku = store.read(commitRow.ku_id)
        if (ku) {
          const pipeline = await runPipeline(ku, graph, { mockStage1: true })
          store.update(commitRow.ku_id, doc => {
            doc.meta.confidence = { aggregate: pipeline.confidence.aggregate, lastComputed: pipeline.checkedAt }
            doc.meta.maturity = pipeline.maturity
            const hasConflicts = pipeline.stage2.contradictions.length > 0
            if (hasConflicts && (doc.meta.maturity === 'stable' || doc.meta.maturity === 'validated')) {
              doc.meta.maturity = 'draft'
            }
          }, 'confidence-recompute')
        }
      }

      const rep = store.getReputation(identity.did)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            reputationDelta: result.reputationDelta ?? 0,
            totalReputation: rep?.reputation ?? 0,
            effectiveWeight: store.getEffectiveWeight(identity.did),
          }, null, 2),
        }],
      }
    }
  )

  // ── Governance ────────────────────────────────────────────────────────────────

  server.tool(
    'akp_governance_state',
    'Get the current governance state: open proposals, parameters, and outcomes',
    {},
    async () => {
      const state = store.computeGovernanceState()
      return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] }
    }
  )

  server.tool(
    'akp_governance_propose',
    'Submit a governance proposal signed by this agent\'s identity. Types: parameter_change, maturity_override, agent_flag, rule_change.',
    {
      type: ProposalSchema.shape.type.describe('Proposal type'),
      payload: z.record(z.unknown()).describe('Proposal payload matching the type schema'),
      ttlDays: z.number().int().min(1).max(30).optional().describe('Voting window in days (default: type-specific)'),
    },
    async ({ type, payload, ttlDays }) => {
      const { createProposal } = await import('../core/governance.js')
      const stub = createProposal({
        type,
        proposerDid: identity.did,
        payload: payload as Parameters<typeof createProposal>[0]['payload'],
        signature: 'pending',
        ttlDays: ttlDays ?? (type === 'rule_change' ? 14 : type === 'parameter_change' ? 7 : 3),
      })
      const sig = await signGovernancePayload(canonicalProposalPayload(stub), identity.privateKeyHex)
      const proposal = { ...stub, signature: sig }

      const ok = await store.submitProposal({ ...proposal, status: 'open' })
      if (!ok) return { content: [{ type: 'text', text: 'Error: Invalid signature or duplicate proposal' }], isError: true }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ proposalId: proposal.id, type, proposerDid: identity.did, status: 'open' }, null, 2),
        }],
      }
    }
  )

  server.tool(
    'akp_governance_vote',
    'Cast a signed vote on an open governance proposal using this agent\'s identity.',
    {
      proposalId: z.string().uuid().describe('ID of the proposal to vote on'),
      choice: z.enum(['yes', 'no', 'abstain']).describe('Your vote'),
    },
    async ({ proposalId, choice }) => {
      const { createVote } = await import('../core/governance.js')
      store.ensureDid(identity.did)
      const stub = createVote({ proposalId, voterDid: identity.did, choice, weight: store.getEffectiveWeight(identity.did), signature: 'pending' })
      const sig = await signGovernancePayload(canonicalVotePayload(stub), identity.privateKeyHex)
      const vote = { ...stub, signature: sig }

      const ok = await store.castVote(vote)
      if (!ok) return { content: [{ type: 'text', text: 'Error: Invalid signature, already voted, or voter suspended' }], isError: true }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ voteId: vote.id, proposalId, choice, voterDid: identity.did }, null, 2),
        }],
      }
    }
  )

  return server
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createMcpServer(options: McpServerOptions) {
  const { store, graph } = options
  const name = options.serverName ?? 'akp-server'
  const identityPath = options.identityPath ?? DEFAULT_IDENTITY_PATH

  /** Mount stateless MCP-over-HTTP on an existing Express app. Identity is loaded once. */
  function mountHttp(app: Express, path = '/mcp') {
    let identityPromise: Promise<Identity> | null = null
    const getIdentity = () => {
      if (!identityPromise) identityPromise = loadOrCreateIdentity(identityPath)
      return identityPromise
    }

    app.post(path, async (req, res) => {
      const identity = await getIdentity()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const mcpServer = buildMcpServer(store, graph, name, identity)
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, req.body)
      res.on('finish', () => transport.close())
    })

    app.get(path, async (req, res) => {
      const identity = await getIdentity()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const mcpServer = buildMcpServer(store, graph, name, identity)
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res)
      res.on('finish', () => transport.close())
    })

    app.delete(path, (_req, res) => { res.status(405).json({ error: 'Stateless mode: no sessions to terminate' }) })
  }

  async function startStdio() {
    const identity = await loadOrCreateIdentity(identityPath)
    const mcpServer = buildMcpServer(store, graph, name, identity)
    const transport = new StdioServerTransport()
    await mcpServer.connect(transport)
  }

  return { mountHttp, startStdio }
}
