import type { KnowledgeUnit, Source } from '../core/ku.js'

export interface SourceCheckResult {
  sourceId: string
  accessible: boolean
  contentMatch: boolean
  responseTime: number
  httpStatus?: number
  resolvedUrl?: string
  error?: string
}

export interface Stage1Result {
  stage1Score: number
  checks: SourceCheckResult[]
  checkedAt: string
}

/** Extract plain text keywords from a KU for content matching. */
function extractKeywords(ku: KnowledgeUnit): string[] {
  const words = new Set<string>()
  for (const claim of ku.structured.claims) {
    for (const raw of [claim.subject, String(claim.object ?? '')]) {
      for (const w of raw.toLowerCase().split(/\W+/)) {
        if (w.length >= 4) words.add(w)
      }
    }
  }
  // Also add significant words from the title
  const titleText = Object.values(ku.meta.title).join(' ')
  for (const w of titleText.toLowerCase().split(/\W+/)) {
    if (w.length >= 5) words.add(w)
  }
  return Array.from(words).slice(0, 10)
}

async function fetchSnippet(url: string, timeout = 15000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { Range: 'bytes=0-8191' },  // fetch only first 8 KB
    })
    clearTimeout(timer)
    if (!response.ok) return ''
    return (await response.text()).toLowerCase()
  } catch {
    clearTimeout(timer)
    return ''
  }
}

async function checkUrl(url: string, keywords: string[], timeout = 15000): Promise<SourceCheckResult> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)

    if (!response.ok) {
      return {
        sourceId: url,
        accessible: false,
        contentMatch: false,
        responseTime: Date.now() - start,
        httpStatus: response.status,
        resolvedUrl: response.url,
      }
    }

    // Only attempt content validation for text/* content types
    const ct = response.headers.get('content-type') ?? ''
    let contentMatch = false
    if (ct.includes('text/') || ct.includes('html') || ct.includes('json') || ct.includes('xml')) {
      const snippet = await fetchSnippet(response.url || url, timeout)
      contentMatch = snippet.length > 0 && keywords.some(kw => snippet.includes(kw))
    }

    return {
      sourceId: url,
      accessible: true,
      contentMatch,
      responseTime: Date.now() - start,
      httpStatus: response.status,
      resolvedUrl: response.url,
    }
  } catch (err) {
    return {
      sourceId: url,
      accessible: false,
      contentMatch: false,
      responseTime: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkDoi(doi: string, keywords: string[]): Promise<SourceCheckResult> {
  const url = `https://doi.org/${doi}`
  const result = await checkUrl(url, keywords)
  return { ...result, sourceId: doi }
}

async function checkPubMed(pmid: string, keywords: string[]): Promise<SourceCheckResult> {
  const url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
  const result = await checkUrl(url, keywords)
  return { ...result, sourceId: pmid }
}

async function checkRfc(rfcNumber: string, keywords: string[]): Promise<SourceCheckResult> {
  const url = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}`
  const result = await checkUrl(url, keywords)
  return { ...result, sourceId: rfcNumber }
}

export async function runStage1(ku: KnowledgeUnit, options?: {
  mockMode?: boolean
  mockResults?: Record<string, boolean>
}): Promise<Stage1Result> {
  const allSources: Source[] = ku.provenance.flatMap(p => p.sources)

  if (allSources.length === 0) {
    return {
      stage1Score: 0,
      checks: [],
      checkedAt: new Date().toISOString(),
    }
  }

  const keywords = extractKeywords(ku)

  const checks: SourceCheckResult[] = await Promise.all(
    allSources.map(async (source): Promise<SourceCheckResult> => {
      if (options?.mockMode) {
        const key = source.value
        const accessible = options.mockResults?.[key] ?? true
        return {
          sourceId: source.id,
          accessible,
          contentMatch: accessible,  // mock: accessible implies content match
          responseTime: Math.random() * 100,
          httpStatus: accessible ? 200 : 404,
        }
      }

      switch (source.type) {
        case 'doi':
          return checkDoi(source.value, keywords)
        case 'pubmed':
          return checkPubMed(source.value, keywords)
        case 'rfc':
          return checkRfc(source.value, keywords)
        case 'url':
        case 'arxiv':
        default:
          return checkUrl(source.value, keywords)
      }
    })
  )

  // Score = 0.5 * accessibility + 0.5 * content match rate
  const accessible = checks.filter(c => c.accessible).length / checks.length
  const contentMatch = checks.filter(c => c.contentMatch).length / checks.length
  const stage1Score = 0.5 * accessible + 0.5 * contentMatch

  return {
    stage1Score,
    checks,
    checkedAt: new Date().toISOString(),
  }
}
