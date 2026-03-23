#!/usr/bin/env tsx
/**
 * external-ground-truth.ts — Evaluate AKP Stage 3 and a naive LLM-only
 * baseline against a 100-claim labeled corpus, reporting accuracy, precision,
 * recall, and F1 for comparison.
 *
 * Evaluation modes:
 *   --mode llm-only   Pure LLM call with no external context (baseline)
 *   --mode akp        AKP Stage 1+3: fetch source URL then LLM with context
 *   --mode both       Run both and print a comparison table (default)
 *
 * Requires Jan running with a model loaded:
 *   npx tsx src/bench/external-ground-truth.ts --provider jan
 *   npx tsx src/bench/external-ground-truth.ts --provider jan --model Llama-3_1-8B-Instruct-IQ4_XS
 *
 * Output saved to results/ground-truth-<timestamp>.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBackend } from '../pipeline/stage3-backends.js'
import type { LLMAgent } from '../pipeline/stage3.js'

// ── Types ──────────────────────────────────────────────────────────────────────

interface CorpusClaim {
  id: string
  domain: string
  statement: string
  verdict: 'confirmed' | 'disputed'
  source: string
  verifiedBy: string
  explanation?: string
}

interface EvalResult {
  id: string
  domain: string
  expected: 'confirmed' | 'disputed'
  got: string
  correct: boolean
  latencyMs: number
  sourceContext?: string   // first 300 chars fetched
}

interface EvalSummary {
  mode: string
  model: string
  total: number
  correct: number
  accuracy: number
  precision: number   // TP / (TP + FP)  — "confirmed" is positive class
  recall: number      // TP / (TP + FN)
  f1: number
  byDomain: Record<string, { correct: number; total: number; accuracy: number }>
  results: EvalResult[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d }
  return {
    mode:     (get('--mode', 'both') as 'llm-only' | 'akp' | 'both'),
    provider: get('--provider', 'jan'),
    model:    get('--model'),
    limit:    get('--limit') ? parseInt(get('--limit')!) : undefined,
  }
}

async function fetchSourceSnippet(url: string, timeoutMs = 4000): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return ''
    const text = await res.text()
    // Strip HTML tags and return first 500 chars of text content
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch {
    return ''
  }
}

const LLM_ONLY_SYSTEM = `You are a fact-checking assistant. Based solely on your training knowledge, evaluate whether the claim is factually accurate.
Respond ONLY with valid JSON: {"verdict":"confirmed"|"disputed","confidence":<0-1>,"reasoning":"<one sentence>"}`

const AKP_SYSTEM = `You are a fact-checking assistant with access to a retrieved source snippet. Evaluate whether the claim is factually accurate based on both the source and your knowledge.
Respond ONLY with valid JSON: {"verdict":"confirmed"|"disputed","confidence":<0-1>,"reasoning":"<one sentence>"}`

async function runLLMOnly(claim: CorpusClaim, agent: LLMAgent): Promise<EvalResult> {
  const start = Date.now()
  let got = 'error'
  try {
    const raw = await agent.call(LLM_ONLY_SYSTEM, `Claim: "${claim.statement}"`)
    got = (JSON.parse(raw) as { verdict?: string }).verdict ?? 'error'
  } catch { /* keep 'error' */ }
  return {
    id: claim.id, domain: claim.domain,
    expected: claim.verdict, got, correct: got === claim.verdict,
    latencyMs: Date.now() - start,
  }
}

async function runAKP(claim: CorpusClaim, agent: LLMAgent): Promise<EvalResult> {
  const start = Date.now()
  const sourceContext = await fetchSourceSnippet(claim.source)
  let got = 'error'
  try {
    const userPrompt = sourceContext
      ? `Claim: "${claim.statement}"\n\nSource snippet (${claim.source}):\n${sourceContext}`
      : `Claim: "${claim.statement}"\n\n(Source unreachable — use your training knowledge)`
    const raw = await agent.call(AKP_SYSTEM, userPrompt)
    got = (JSON.parse(raw) as { verdict?: string }).verdict ?? 'error'
  } catch { /* keep 'error' */ }
  return {
    id: claim.id, domain: claim.domain,
    expected: claim.verdict, got, correct: got === claim.verdict,
    latencyMs: Date.now() - start,
    sourceContext: sourceContext.slice(0, 300) || undefined,
  }
}

function computeMetrics(results: EvalResult[], mode: string, model: string): EvalSummary {
  const correct = results.filter(r => r.correct).length
  // Positive class = 'confirmed'
  const tp = results.filter(r => r.expected === 'confirmed' && r.got === 'confirmed').length
  const fp = results.filter(r => r.expected === 'disputed'  && r.got === 'confirmed').length
  const fn = results.filter(r => r.expected === 'confirmed' && r.got !== 'confirmed').length
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall    = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1        = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

  // Per-domain breakdown
  const domainMap: Record<string, { correct: number; total: number }> = {}
  for (const r of results) {
    const key = r.domain.split('/')[0]  // top-level domain
    const entry = domainMap[key] ?? { correct: 0, total: 0 }
    entry.total++
    if (r.correct) entry.correct++
    domainMap[key] = entry
  }
  const byDomain: EvalSummary['byDomain'] = {}
  for (const [k, v] of Object.entries(domainMap)) {
    byDomain[k] = { ...v, accuracy: v.correct / v.total }
  }

  return { mode, model, total: results.length, correct, accuracy: correct / results.length,
           precision, recall, f1, byDomain, results }
}

function printSummary(s: EvalSummary) {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  console.log(`\n  Mode: ${s.mode}  |  Model: ${s.model}`)
  console.log(`  Accuracy=${pct(s.accuracy)}  Precision=${pct(s.precision)}  Recall=${pct(s.recall)}  F1=${pct(s.f1)}  (n=${s.total})`)
  console.log('  By domain:')
  for (const [domain, v] of Object.entries(s.byDomain).sort((a,b) => b[1].total - a[1].total)) {
    console.log(`    ${domain.padEnd(16)} ${pct(v.accuracy).padStart(7)}  (${v.correct}/${v.total})`)
  }
}

function printComparisonTable(baseline: EvalSummary, akp: EvalSummary) {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const delta = (a: number, b: number) => {
    const d = (b - a) * 100
    return d >= 0 ? `+${d.toFixed(1)}pp` : `${d.toFixed(1)}pp`
  }
  console.log('\n' + '═'.repeat(70))
  console.log('  AKP vs LLM-Only Baseline  —  External Ground Truth  (n=100)')
  console.log('═'.repeat(70))
  console.log(`  ${'Metric'.padEnd(16)} ${'LLM-Only'.padEnd(12)} ${'AKP Stage1+3'.padEnd(14)} Delta`)
  console.log('─'.repeat(70))
  for (const [metric, bv, av] of [
    ['Accuracy',  baseline.accuracy,  akp.accuracy],
    ['Precision', baseline.precision, akp.precision],
    ['Recall',    baseline.recall,    akp.recall],
    ['F1',        baseline.f1,        akp.f1],
  ] as Array<[string, number, number]>) {
    console.log(`  ${metric.padEnd(16)} ${pct(bv).padEnd(12)} ${pct(av).padEnd(14)} ${delta(bv, av)}`)
  }
  console.log('═'.repeat(70))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()
  const claimsRaw: CorpusClaim[] = JSON.parse(
    readFileSync(join('src/bench/truth-corpus/claims.json'), 'utf8')
  )
  const claims = args.limit ? claimsRaw.slice(0, args.limit) : claimsRaw
  console.log(`\nExternal Ground Truth Evaluation  (${claims.length} claims, mode=${args.mode})`)

  const backend = await resolveBackend({ provider: args.provider as 'jan', model: args.model })
  console.log(`Backend: ${backend.label}\n`)

  const summaries: EvalSummary[] = []

  try {
    if (args.mode === 'llm-only' || args.mode === 'both') {
      console.log('Running LLM-only baseline...')
      const results: EvalResult[] = []
      for (let i = 0; i < claims.length; i++) {
        process.stdout.write(`\r  ${i+1}/${claims.length}`)
        results.push(await runLLMOnly(claims[i], backend.agent))
      }
      console.log()
      const s = computeMetrics(results, 'llm-only', backend.label)
      summaries.push(s)
      printSummary(s)
    }

    if (args.mode === 'akp' || args.mode === 'both') {
      console.log('\nRunning AKP Stage1+3 (source fetch + LLM)...')
      const results: EvalResult[] = []
      for (let i = 0; i < claims.length; i++) {
        process.stdout.write(`\r  ${i+1}/${claims.length}`)
        results.push(await runAKP(claims[i], backend.agent))
      }
      console.log()
      const s = computeMetrics(results, 'akp-stage1+3', backend.label)
      summaries.push(s)
      printSummary(s)
    }

    if (args.mode === 'both' && summaries.length === 2) {
      printComparisonTable(summaries[0], summaries[1])
    }
  } finally {
    await backend.stop()
  }

  // Save results
  mkdirSync('results', { recursive: true })
  const outPath = join('results', `ground-truth-${Date.now()}.json`)
  writeFileSync(outPath, JSON.stringify(summaries, null, 2))
  console.log(`\nSaved → ${outPath}`)
}

main().catch(err => { console.error('Failed:', err); process.exit(1) })
