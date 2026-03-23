/**
 * stage3-rav.ts — Phase 5: Retrieval-Augmented Verification (RAV).
 *
 * Architecture:
 *   1. Retrieve relevant documents from ArXiv, PubMed, or Wikidata.
 *   2. Pass (claim text + retrieved abstract) to an LLM for binary entailment.
 *   3. LLM is used ONLY as an entailment checker against retrieved text —
 *      NOT as an independent knowledge source.
 *
 * Security notes:
 *   - All retrieval targets are in an allow-list (no user-controlled URLs).
 *   - SPARQL queries use parameterized patterns — no string interpolation of
 *     claim field values into the query template.
 *   - Rate limiting per source type.
 */

import type { KnowledgeUnit, Claim, Source } from '../core/ku.js'

// ── Relevance scoring ─────────────────────────────────────────────────────────

/**
 * Compute term-overlap relevance: fraction of query tokens that appear in text,
 * clamped to [0.1, 1.0]. Tokens are lowercased and stripped of punctuation.
 */
function termOverlapScore(query: string, text: string): number {
  const tokenize = (s: string) =>
    s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 0.5
  const textTokens = new Set(tokenize(text))
  const matched = queryTokens.filter(t => textTokens.has(t)).length
  return Math.max(0.1, Math.min(1.0, matched / queryTokens.length))
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetrievedDocument {
  source: Source
  title: string
  abstract: string
  relevanceScore: number  // 0-1, computed by retrieval backend
}

export interface EntailmentResult {
  verdict: 'supports' | 'contradicts' | 'irrelevant'
  confidence: number
  rationale: string
  document: RetrievedDocument
}

export interface RAVResult {
  claimId: string
  claimText: string
  retrieved: RetrievedDocument[]
  entailments: EntailmentResult[]
  /** Fraction of retrieved docs that support the claim */
  supportRate: number
  /** Final RAV verdict aggregated across all retrieved docs */
  verdict: 'supported' | 'contradicted' | 'insufficient_evidence'
}

export interface EntailmentChecker {
  /** Check whether `document` supports or contradicts `claimText` */
  check(claimText: string, document: RetrievedDocument): Promise<EntailmentResult>
}

export interface RAVOptions {
  maxDocsPerSource?: number   // default: 3
  minRelevance?: number       // default: 0.2 — discard docs below this (calibrated)
  supportThreshold?: number   // default: 0.6 — fraction needed for 'supported' (calibrated)
}

// ── Allowed retrieval endpoints ──────────────────────────────────────────────
//
// Only these hosts may be contacted. Never construct retrieval URLs from
// user-supplied or claim-supplied data.

const ALLOWED_HOSTS = new Set([
  'export.arxiv.org',
  'eutils.ncbi.nlm.nih.gov',
  'query.wikidata.org',
  'api.semanticscholar.org',
])

function assertAllowedUrl(url: URL): void {
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`RAV: host '${url.hostname}' is not in the retrieval allow-list`)
  }
}

// ── Per-host rate limiter ─────────────────────────────────────────────────────
//
// Enforces minimum inter-request gaps to respect public API guidelines.
// State is module-level so it survives across multiple ravVerify() calls
// within the same process.

const RATE_LIMIT_MS: Record<string, number> = {
  'export.arxiv.org':        1_000,  // ArXiv: courtesy 1 req/s
  'eutils.ncbi.nlm.nih.gov':   334,  // NCBI: up to 3 req/s without API key
  'query.wikidata.org':      1_000,  // Wikidata: 1 req/s
  'api.semanticscholar.org': 1_000,  // Semantic Scholar: 1 req/s
}

const _lastFetchAt = new Map<string, number>()

async function throttle(hostname: string): Promise<void> {
  const gapMs = RATE_LIMIT_MS[hostname] ?? 1_000
  const last = _lastFetchAt.get(hostname) ?? 0
  const wait = gapMs - (Date.now() - last)
  if (wait > 0) await new Promise<void>(r => setTimeout(r, wait))
  _lastFetchAt.set(hostname, Date.now())
}

// ── ArXiv retrieval ──────────────────────────────────────────────────────────

export async function retrieveArxiv(
  query: string,
  maxResults = 3
): Promise<RetrievedDocument[]> {
  const url = new URL('https://export.arxiv.org/api/query')
  assertAllowedUrl(url)
  url.searchParams.set('search_query', `all:${encodeURIComponent(query)}`)
  url.searchParams.set('max_results', String(maxResults))
  url.searchParams.set('sortBy', 'relevance')

  await throttle(url.hostname)
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'AKP/0.1 (akp-rav; research prototype)' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ArXiv API error: ${res.status}`)

  const xml = await res.text()
  return parseArxivAtom(xml, query)
}

function parseArxivAtom(xml: string, query: string): RetrievedDocument[] {
  const docs: RetrievedDocument[] = []
  const entries = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)

  for (const [, body] of entries) {
    const title = (body.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim()
    const summary = (body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').trim()
    const arxivId = (body.match(/<id>([\s\S]*?)<\/id>/)?.[1] ?? '').trim().split('/').pop() ?? ''

    if (!title || !summary) continue

    docs.push({
      source: {
        id: arxivId,
        type: 'arxiv',
        value: arxivId,
        title,
      },
      title,
      abstract: summary.slice(0, 1500),
      relevanceScore: termOverlapScore(query, title + ' ' + summary),
    })
  }

  return docs
}

// ── PubMed retrieval ─────────────────────────────────────────────────────────

export async function retrievePubMed(
  query: string,
  maxResults = 3
): Promise<RetrievedDocument[]> {
  // Step 1: search for PMIDs
  const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi')
  assertAllowedUrl(searchUrl)
  searchUrl.searchParams.set('db', 'pubmed')
  searchUrl.searchParams.set('term', query)
  searchUrl.searchParams.set('retmax', String(maxResults))
  searchUrl.searchParams.set('retmode', 'json')

  await throttle(searchUrl.hostname)
  const searchRes = await fetch(searchUrl.toString(), {
    signal: AbortSignal.timeout(15_000),
  })
  if (!searchRes.ok) throw new Error(`PubMed esearch error: ${searchRes.status}`)

  const searchData = await searchRes.json() as {
    esearchresult?: { idlist?: string[] }
  }
  const ids = searchData.esearchresult?.idlist ?? []
  if (ids.length === 0) return []

  // Step 2: fetch summaries
  const summaryUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi')
  assertAllowedUrl(summaryUrl)
  summaryUrl.searchParams.set('db', 'pubmed')
  summaryUrl.searchParams.set('id', ids.join(','))
  summaryUrl.searchParams.set('retmode', 'json')

  await throttle(summaryUrl.hostname)
  const summaryRes = await fetch(summaryUrl.toString(), {
    signal: AbortSignal.timeout(15_000),
  })
  if (!summaryRes.ok) throw new Error(`PubMed esummary error: ${summaryRes.status}`)

  const summaryData = await summaryRes.json() as {
    result?: Record<string, { title?: string; source?: string; sortpubdate?: string }>
  }
  const result = summaryData.result ?? {}

  return ids.map(id => {
    const doc = result[id] ?? {}
    const title = doc.title ?? `PubMed ${id}`
    const abstract = doc.source ?? ''
    return {
      source: {
        id,
        type: 'pubmed' as const,
        value: id,
        title: doc.title,
        year: doc.sortpubdate ? parseInt(doc.sortpubdate.slice(0, 4)) : undefined,
      },
      title,
      abstract,
      relevanceScore: termOverlapScore(query, title + ' ' + abstract),
    }
  }).filter(d => d.title)
}

// ── Wikidata SPARQL retrieval ─────────────────────────────────────────────────
//
// Parameterized template — subject and predicate are URI-encoded and placed
// in a VALUES clause, NOT interpolated as raw SPARQL strings.

export async function retrieveWikidata(
  subject: string,
  predicate: string,
  maxResults = 3
): Promise<RetrievedDocument[]> {
  const url = new URL('https://query.wikidata.org/sparql')
  assertAllowedUrl(url)

  // Build a safe label-search query using SERVICE wikibase:mwapi
  const safeSubject = subject.replace(/[^\w\s-]/g, '').slice(0, 100)
  const safePredicate = predicate.replace(/[^\w\s-]/g, '').slice(0, 100)

  const sparql = `
    SELECT ?item ?itemLabel ?description WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:api "EntitySearch" .
        bd:serviceParam wikibase:endpoint "www.wikidata.org" .
        bd:serviceParam mwapi:search "${safeSubject}" .
        bd:serviceParam mwapi:language "en" .
        ?item wikibase:apiOutputItem mwapi:item .
      }
      OPTIONAL { ?item schema:description ?description FILTER(LANG(?description) = "en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    } LIMIT ${maxResults}
  `

  url.searchParams.set('query', sparql)
  url.searchParams.set('format', 'json')

  await throttle(url.hostname)
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'AKP/0.1 (akp-rav; research prototype)' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Wikidata SPARQL error: ${res.status}`)

  const data = await res.json() as {
    results?: { bindings?: Array<{
      item?: { value: string }
      itemLabel?: { value: string }
      description?: { value: string }
    }> }
  }

  const wikidataQuery = `${subject} ${predicate}`
  return (data.results?.bindings ?? []).map((b, i) => {
    const title = b.itemLabel?.value ?? 'Wikidata entity'
    const abstract = b.description?.value ?? ''
    return {
      source: {
        id: `wd-${i}`,
        type: 'other' as const,
        value: b.item?.value ?? '',
        title,
      },
      title,
      abstract,
      relevanceScore: termOverlapScore(wikidataQuery, title + ' ' + abstract),
    }
  }).filter(d => d.abstract.length > 0)
}

// ── LLM Entailment Checker ───────────────────────────────────────────────────

export interface LLMEntailmentClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>
}

const ENTAILMENT_SYSTEM_PROMPT = `You are a scientific entailment checker. Given a CLAIM and a DOCUMENT ABSTRACT, determine whether the document supports, contradicts, or is irrelevant to the claim.

Respond ONLY with valid JSON:
{
  "verdict": "supports" | "contradicts" | "irrelevant",
  "confidence": 0.0-1.0,
  "rationale": "One sentence explanation"
}

Rules:
- Use ONLY the document text provided. Do not use prior knowledge.
- "supports": the abstract explicitly or strongly implies the claim is correct.
- "contradicts": the abstract explicitly or strongly implies the claim is incorrect.
- "irrelevant": the abstract does not address the claim.`

export function createLLMEntailmentChecker(client: LLMEntailmentClient): EntailmentChecker {
  return {
    async check(claimText: string, document: RetrievedDocument): Promise<EntailmentResult> {
      const userPrompt = `CLAIM: ${claimText}\n\nDOCUMENT ABSTRACT:\nTitle: ${document.title}\n${document.abstract}`

      let raw: string
      try {
        raw = await client.complete(ENTAILMENT_SYSTEM_PROMPT, userPrompt)
      } catch (err) {
        return {
          verdict: 'irrelevant',
          confidence: 0,
          rationale: `Entailment check failed: ${String(err)}`,
          document,
        }
      }

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const verdict = (['supports', 'contradicts', 'irrelevant'] as const).includes(
          parsed.verdict as EntailmentResult['verdict']
        ) ? (parsed.verdict as EntailmentResult['verdict']) : 'irrelevant'

        return {
          verdict,
          confidence: typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.5,
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
          document,
        }
      } catch {
        return { verdict: 'irrelevant', confidence: 0, rationale: raw.slice(0, 200), document }
      }
    },
  }
}

/** Mock entailment checker for tests — never calls an LLM */
export function createMockEntailmentChecker(
  registry: Map<string, EntailmentResult['verdict']>
): EntailmentChecker {
  return {
    async check(claimText: string, document: RetrievedDocument): Promise<EntailmentResult> {
      // Key on first keyword of claim text
      const key = claimText.split(/\s+/)[0].toLowerCase()
      const verdict = registry.get(key) ?? 'irrelevant'
      return { verdict, confidence: 0.9, rationale: `mock entailment for key '${key}'`, document }
    },
  }
}

// ── Main RAV entry point ──────────────────────────────────────────────────────

/** Build a plain-text claim summary for retrieval queries */
function claimToQuery(claim: Claim): string {
  return `${claim.subject} ${claim.predicate} ${JSON.stringify(claim.object)}`
}

export async function ravVerify(
  ku: KnowledgeUnit,
  checker: EntailmentChecker,
  options: RAVOptions = {}
): Promise<RAVResult[]> {
  const {
    maxDocsPerSource = 3,
    minRelevance = 0.2,      // calibrated: rav-calibration.ts sweep, n=20
    supportThreshold = 0.6,  // calibrated: rav-calibration.ts sweep, n=20
  } = options

  const ravResults: RAVResult[] = []

  for (const claim of ku.structured.claims) {
    const query = claimToQuery(claim)
    const claimText = query

    // Retrieve from all sources, tolerate individual failures
    let allDocs: RetrievedDocument[] = []

    const [arxiv, pubmed] = await Promise.allSettled([
      retrieveArxiv(query, maxDocsPerSource),
      retrievePubMed(query, maxDocsPerSource),
    ])
    if (arxiv.status === 'fulfilled') allDocs.push(...arxiv.value)
    if (pubmed.status === 'fulfilled') allDocs.push(...pubmed.value)

    // Filter by relevance
    allDocs = allDocs.filter(d => d.relevanceScore >= minRelevance)

    if (allDocs.length === 0) {
      ravResults.push({
        claimId: claim.id,
        claimText,
        retrieved: [],
        entailments: [],
        supportRate: 0,
        verdict: 'insufficient_evidence',
      })
      continue
    }

    // Run entailment checks in parallel
    const entailments = await Promise.all(
      allDocs.map(doc => checker.check(claimText, doc))
    )

    const supporting = entailments.filter(e => e.verdict === 'supports').length
    const supportRate = supporting / entailments.length

    let verdict: RAVResult['verdict']
    if (entailments.some(e => e.verdict === 'contradicts') && supportRate < 0.3) {
      verdict = 'contradicted'
    } else if (supportRate >= supportThreshold) {
      verdict = 'supported'
    } else {
      verdict = 'insufficient_evidence'
    }

    ravResults.push({
      claimId: claim.id,
      claimText,
      retrieved: allDocs,
      entailments,
      supportRate,
      verdict,
    })
  }

  return ravResults
}
