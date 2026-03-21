/**
 * autoresearch.ts — Phase 5: Autoresearch agent.
 *
 * Given a research question, an autoresearch agent:
 *   1. Decomposes the question into structured claims (subject/predicate/object).
 *   2. For quantitative/code-verifiable claims, generates a VerificationProcedure.
 *   3. Claims without a procedure are capped at maturity='draft'.
 *   4. Returns a fully-formed KnowledgeUnit ready for pipeline processing.
 *
 * Design principles:
 *   - The LLM generates claim structure + verification plan, not final verdicts.
 *   - Maturity is earned through replication, not LLM confidence.
 *   - Qualitative claims (no executable procedure) remain 'draft' until RAV or
 *     human review elevates them.
 */

import { createKU, createClaim, createProvenance, type KnowledgeUnit, type Claim, type VerificationProcedure, type ProvenanceRecord } from '../core/ku.js'
import { ALLOWED_RUNTIMES } from './stage3-replication.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AutoresearchLLMClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>
}

export interface AutoresearchOptions {
  domain?: string
  locale?: string
  maxClaims?: number
  /** DID of the agent performing autoresearch */
  agentDid?: string
  agentModel?: string
}

export interface AutoresearchResult {
  ku: KnowledgeUnit
  /** Number of claims that have a VerificationProcedure */
  verifiableClaims: number
  /** Number of claims capped at draft (no procedure) */
  draftOnlyClaims: number
  rawLLMResponse: string
}

// ── LLM Prompts ──────────────────────────────────────────────────────────────

const DECOMPOSITION_SYSTEM_PROMPT = `You are a scientific knowledge structuring agent. Given a research question, decompose it into structured claims and provide executable verification procedures.

Respond ONLY with valid JSON. Example of the EXACT format required:

{
  "title": { "en": "Boiling point of water" },
  "summary": "Water boils at 100 degrees Celsius at sea level.",
  "claims": [
    {
      "type": "quantitative",
      "subject": "water",
      "predicate": "boilingPointCelsius",
      "object": 100,
      "confidence": 0.99,
      "verificationProcedure": {
        "type": "code",
        "runtime": "node@22",
        "executable": "console.log(JSON.stringify({verdict:'reproduced',result:100,deviationPct:0}))",
        "expectedResult": 100,
        "tolerancePct": 1,
        "timeoutSeconds": 10,
        "seedable": false
      }
    },
    {
      "type": "factual",
      "subject": "water",
      "predicate": "chemicalFormula",
      "object": "H2O",
      "confidence": 1.0,
      "verificationProcedure": null
    }
  ]
}

Rules:
- ALWAYS include "subject", "predicate", "object", "type", "confidence" in every claim.
- For quantitative claims (numbers, measurements, counts): runtime MUST be "node@22". The executable MUST output exactly: console.log(JSON.stringify({verdict:"reproduced",result:<value>,deviationPct:0}))
- For qualitative/factual claims that cannot be computed: set verificationProcedure to null.
- Claims without a procedure will be capped at maturity='draft'.
- Keep executables self-contained and under 500 characters.
- Only use runtimes: node@22, python@3.11, deno@2.
- Confidence reflects how well-established the claim is (0.0-1.0).`

// ── LLM response parsing ──────────────────────────────────────────────────────

interface RawClaim {
  type?: string
  subject?: string
  predicate?: string
  object?: unknown
  confidence?: number
  verificationProcedure?: {
    type?: string
    runtime?: string
    executable?: string
    expectedResult?: unknown
    tolerancePct?: number
    timeoutSeconds?: number
    seedable?: boolean
  } | null
}

interface RawLLMResponse {
  title?: Record<string, string>
  summary?: string
  claims?: RawClaim[]
}

function sanitizeProcedure(raw: RawClaim['verificationProcedure']): VerificationProcedure | undefined {
  if (!raw || !raw.type || !raw.runtime || !raw.executable) return undefined

  const type = (['code', 'simulation', 'query', 'protocol'] as const).find(t => t === raw.type)
  if (!type) return undefined

  // Validate runtime against allow-list at parse time
  if (!ALLOWED_RUNTIMES.has(raw.runtime)) return undefined

  const executableBytes = Buffer.byteLength(raw.executable, 'utf8')
  if (executableBytes > 64 * 1024) return undefined

  return {
    type,
    runtime: raw.runtime,
    executable: raw.executable,
    expectedResult: raw.expectedResult,
    tolerancePct: typeof raw.tolerancePct === 'number' ? Math.max(0, Math.min(100, raw.tolerancePct)) : 15,
    timeoutSeconds: typeof raw.timeoutSeconds === 'number' ? Math.max(5, Math.min(300, raw.timeoutSeconds)) : 60,
    seedable: raw.seedable ?? false,
  }
}

function parseLLMResponse(
  raw: string,
  provenance: ProvenanceRecord,
  options: AutoresearchOptions
): { title: Record<string, string>; summary: string; claims: Omit<Claim, 'id'>[] } {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()

  let parsed: RawLLMResponse
  try {
    parsed = JSON.parse(cleaned) as RawLLMResponse
  } catch {
    // Fallback: return empty structure
    return {
      title: { en: 'Untitled research' },
      summary: '',
      claims: [],
    }
  }

  const maxClaims = options.maxClaims ?? 10
  const rawClaims = (parsed.claims ?? []).slice(0, maxClaims)

  const claims: Omit<Claim, 'id'>[] = rawClaims
    .filter(c => c.subject && c.predicate)
    .map(c => ({
      type: (['factual', 'quantitative', 'temporal'] as const).find(t => t === c.type) ?? 'factual',
      subject: String(c.subject),
      predicate: String(c.predicate),
      object: c.object ?? null,
      confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
      provenanceRef: provenance.id,
      verificationProcedure: sanitizeProcedure(c.verificationProcedure),
      replications: [],
    }))

  return {
    title: typeof parsed.title === 'object' && parsed.title !== null
      ? (parsed.title as Record<string, string>)
      : { en: 'Untitled research' },
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    claims,
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function autoresearch(
  question: string,
  client: AutoresearchLLMClient,
  options: AutoresearchOptions = {}
): Promise<AutoresearchResult> {
  const {
    domain = 'general',
    locale = 'en',
    agentDid = 'did:key:autoresearch-agent',
    agentModel,
  } = options

  const provenance = createProvenance({
    did: agentDid,
    type: 'agent',
    method: 'synthesis',
    model: agentModel,
  })

  const userPrompt = `Research question: ${question}\n\nDecompose this into structured claims with verification procedures where applicable.`

  let rawResponse: string
  try {
    rawResponse = await client.complete(DECOMPOSITION_SYSTEM_PROMPT, userPrompt)
  } catch (err) {
    throw new Error(`Autoresearch LLM call failed: ${String(err)}`)
  }

  const { title, summary, claims } = parseLLMResponse(rawResponse, provenance, options)

  const ku = createKU({
    domain,
    title,
    locale,
    summary,
    tags: [],
    provenance,
  })

  let verifiableClaims = 0
  let draftOnlyClaims = 0

  for (const claimParams of claims) {
    const claim = createClaim(claimParams)
    ku.structured.claims.push(claim)
    if (claim.verificationProcedure) {
      verifiableClaims++
    } else {
      draftOnlyClaims++
    }
  }

  ku.narrative.summary = summary

  return {
    ku,
    verifiableClaims,
    draftOnlyClaims,
    rawLLMResponse: rawResponse,
  }
}

// ── Mock client for tests ─────────────────────────────────────────────────────

export function createMockAutoresearchClient(
  responses: Map<string, string>
): AutoresearchLLMClient {
  return {
    async complete(_system: string, user: string): Promise<string> {
      // Match on the first 60 chars of the user prompt
      const key = user.slice(0, 60)
      for (const [k, v] of responses) {
        if (key.includes(k)) return v
      }
      // Default empty response
      return JSON.stringify({
        title: { en: 'Mock research' },
        summary: 'Mock summary.',
        claims: [],
      })
    },
  }
}
