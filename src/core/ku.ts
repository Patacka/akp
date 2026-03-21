import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'

// --- Zod Schemas ---

// --- Replication types (Phase 5: autoresearch + replication-based verification) ---

export const VerificationProcedureSchema = z.object({
  type: z.enum(['code', 'simulation', 'query', 'protocol']),
  executable: z.string().min(1),       // code, shell command, SPARQL, or checklist
  runtime: z.string().min(1),          // e.g. "node@22", "python@3.11+torch@2.3"
  entrypoint: z.string().optional(),   // file/function if multi-file
  expectedResult: z.unknown(),         // what the original experiment produced
  tolerancePct: z.number().min(0).max(100).optional().default(15),
  timeoutSeconds: z.number().int().min(1).optional().default(120),
  seedable: z.boolean().optional().default(false),
  // Ed25519 authorship proof (Phase 5 security hardening)
  authorDid: z.string().optional(),    // did:key:z<hex> of the agent that authored this procedure
  signature: z.string().optional(),    // hex Ed25519 sig over canonical procedure fields
})

export const ReplicationResultSchema = z.object({
  replicatorDid: z.string().min(1),
  runtime: z.string().min(1),          // actual runtime used
  seed: z.number().int().optional(),
  result: z.unknown(),                 // raw output
  verdict: z.enum(['reproduced', 'failed', 'partial']),
  deviationPct: z.number().optional(), // for quantitative: % deviation from expected
  executedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
})

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['factual', 'quantitative', 'temporal', 'causal', 'contested']),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown(),
  confidence: z.number().min(0).max(1),
  provenanceRef: z.string().uuid(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  // Phase 5: optional — claims without a procedure are capped at "draft"
  verificationProcedure: VerificationProcedureSchema.optional(),
  replications: z.array(ReplicationResultSchema).optional().default([]),
})

export const EntitySchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  label: z.string(),
  externalIds: z.record(z.string()).optional(),
})

export const RelationSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  sourceKuId: z.string().uuid(),
  targetKuId: z.string().uuid(),
  confidence: z.number().min(0).max(1),
  confirmedBy: z.array(z.string()).default([]),
})

export const NarrativeSectionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  order: z.number().int(),
})

export const SourceSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['doi', 'url', 'pubmed', 'rfc', 'arxiv', 'isbn', 'other']),
  value: z.string(),
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  accessedAt: z.string().datetime().optional(),
})

export const ProvenanceRecordSchema = z.object({
  id: z.string().uuid(),
  agent: z.object({
    did: z.string(),
    type: z.enum(['agent', 'human']),
    model: z.string().optional(),
  }),
  method: z.enum(['observation', 'inference', 'synthesis', 'retrieval', 'human_input']),
  sources: z.array(SourceSchema).default([]),
  generatedAt: z.string().datetime(),
})

export const ReviewSchema = z.object({
  id: z.string().uuid(),
  reviewerDid: z.string(),
  reviewerType: z.enum(['agent', 'human']),
  timestamp: z.string().datetime(),
  verdict: z.enum(['confirmed', 'amended', 'disputed', 'rejected']),
  scope: z.array(z.string().uuid()),
  weight: z.number().min(0).max(1),
  comment: z.string().optional(),
  signature: z.string().optional(),
})

export const KnowledgeUnitSchema = z.object({
  id: z.string().uuid(),
  version: z.object({
    semver: z.string(),
    vectorClock: z.record(z.number()),
    automergeHeads: z.array(z.string()),
  }),
  meta: z.object({
    title: z.record(z.string()),
    domain: z.string(),
    tags: z.array(z.string()),
    maturity: z.enum(['draft', 'proposed', 'validated', 'stable']),
    confidence: z.object({
      aggregate: z.number().min(0).max(1),
      lastComputed: z.string().datetime(),
    }),
    created: z.string().datetime(),
    modified: z.string().datetime(),
  }),
  structured: z.object({
    claims: z.array(ClaimSchema),
    relations: z.array(RelationSchema),
    entities: z.array(EntitySchema),
  }),
  narrative: z.object({
    format: z.literal('markdown'),
    locale: z.string(),
    summary: z.string(),
    body: z.string(),
    sections: z.array(NarrativeSectionSchema),
  }),
  provenance: z.array(ProvenanceRecordSchema),
  reviews: z.array(ReviewSchema),
})

// --- TypeScript types ---

export type VerificationProcedure = z.infer<typeof VerificationProcedureSchema>
export type ReplicationResult = z.infer<typeof ReplicationResultSchema>
export type Claim = z.infer<typeof ClaimSchema>
export type Entity = z.infer<typeof EntitySchema>
export type Relation = z.infer<typeof RelationSchema>
export type NarrativeSection = z.infer<typeof NarrativeSectionSchema>
export type Source = z.infer<typeof SourceSchema>
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>
export type Review = z.infer<typeof ReviewSchema>
export type KnowledgeUnit = z.infer<typeof KnowledgeUnitSchema>

// --- Factory functions ---

export function createKU(params: {
  domain: string
  title: Record<string, string>
  locale?: string
  summary?: string
  tags?: string[]
  provenance: ProvenanceRecord
}): KnowledgeUnit {
  const now = new Date().toISOString()
  return {
    id: uuidv7(),
    version: {
      semver: '1.0.0',
      vectorClock: {},
      automergeHeads: [],
    },
    meta: {
      title: params.title,
      domain: params.domain,
      tags: params.tags ?? [],
      maturity: 'draft',
      confidence: {
        aggregate: 0,
        lastComputed: now,
      },
      created: now,
      modified: now,
    },
    structured: {
      claims: [],
      relations: [],
      entities: [],
    },
    narrative: {
      format: 'markdown',
      locale: params.locale ?? 'en',
      summary: params.summary ?? '',
      body: '',
      sections: [],
    },
    provenance: [params.provenance],
    reviews: [],
  }
}

export function createClaim(
  params: Omit<Claim, 'id' | 'replications'> & { replications?: ReplicationResult[] }
): Claim {
  return { replications: [], ...params, id: uuidv7() }
}

export function createProvenance(params: {
  did: string
  type: 'agent' | 'human'
  method: ProvenanceRecord['method']
  model?: string
  sources?: Source[]
}): ProvenanceRecord {
  return {
    id: uuidv7(),
    agent: { did: params.did, type: params.type, model: params.model },
    method: params.method,
    sources: params.sources ?? [],
    generatedAt: new Date().toISOString(),
  }
}

export function createReplicationResult(params: Omit<ReplicationResult, 'executedAt'>): ReplicationResult {
  return { ...params, executedAt: new Date().toISOString() }
}

export function validateKU(data: unknown): KnowledgeUnit {
  return KnowledgeUnitSchema.parse(data)
}
