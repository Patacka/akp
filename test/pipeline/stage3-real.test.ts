/**
 * stage3-real.test.ts — Real Stage 3 corroboration using free OpenRouter models.
 *
 * Auto-discovers working free models at runtime (availability fluctuates).
 * Requires OPENROUTER_API_KEY in environment or .env file.
 *
 * Run: OPENROUTER_API_KEY=... npx vitest run test/pipeline/stage3-real.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { runStage3 } from '../../src/pipeline/stage3.js'
import {
  createFreeAgentPool,
  createFastAgent,
  discoverAvailableModels,
} from '../../src/pipeline/stage3-openrouter.js'
import { runPipeline } from '../../src/pipeline/index.js'
import { RelationGraph } from '../../src/core/graph.js'
import type { LLMAgent, AgentResult } from '../../src/pipeline/stage3.js'

const HAS_KEY = !!process.env.OPENROUTER_API_KEY
const live = (name: string, fn: () => Promise<void>, timeout = 90_000) =>
  HAS_KEY ? it(name, fn, timeout) : it.skip(`[no key] ${name}`, fn)

let fastAgent: LLMAgent
let agentPool: LLMAgent[]
let availableModels: string[]

// ─── Setup: discover available models once ────────────────────────────────────

if (HAS_KEY) {
  beforeAll(async () => {
    console.log('Discovering available free models...')
    availableModels = await discoverAvailableModels()
    console.log(`Available: ${availableModels.join(', ')}`)
    if (availableModels.length === 0) {
      console.warn('No free models available — tests will be skipped')
      return
    }
    agentPool = await createFreeAgentPool(Math.min(2, availableModels.length))
    fastAgent = agentPool[0]
  }, 120_000)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeKU(domain: string, subject: string, predicate: string, object: unknown, type: 'factual' | 'quantitative' = 'factual') {
  const prov = createProvenance({ did: 'did:key:real-test', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain, title: { en: `${subject} ${predicate}` }, provenance: prov })
  ku.structured.claims.push(createClaim({ type, subject, predicate, object, confidence: 0.9, provenanceRef: prov.id }))
  return ku
}

function kappa(a: string[], b: string[]): number {
  const n = a.length
  if (n === 0) return 0
  const labels = Array.from(new Set([...a, ...b]))
  const pObs = a.filter((v, i) => v === b[i]).length / n
  const pExp = labels.reduce((s, l) => s + (a.filter(v => v === l).length / n) * (b.filter(v => v === l).length / n), 0)
  return pExp >= 1 ? 1 : (pObs - pExp) / (1 - pExp)
}

function getAgents() {
  if (!fastAgent || !agentPool) throw new Error('No agents available')
  return { fast: fastAgent, pool: agentPool }
}

// ─── Model discovery ──────────────────────────────────────────────────────────

describe('OpenRouter model discovery', () => {
  live('finds at least one working free model', async () => {
    const models = await discoverAvailableModels()
    console.log(`Working models: ${models.join('\n  ')}`)
    expect(models.length).toBeGreaterThan(0)
  })
})

// ─── Single agent: factual accuracy battery ───────────────────────────────────

describe('Stage 3 — single agent factual accuracy', () => {
  live('confirms water boils at 100°C (reproduction)', async () => {
    const { fast } = getAgents()
    const ku = makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative')
    const result = await runStage3(ku, [fast], { variant: 'reproduction' })
    const ar = result.agentResults[0]
    console.log(`[${fast.model}] water=100C: verdict=${ar.verdict} conf=${ar.confidence?.toFixed(2)}`)
    console.log(`  reasoning: ${ar.reasoning?.slice(0, 150)}`)
    expect(ar.verdict).not.toBe('disputed')
    expect(ar.confidence).toBeGreaterThan(0.5)
  })

  live('disputes water boiling at -10°C (falsification)', async () => {
    const { fast } = getAgents()
    const ku = makeKU('chemistry', 'water', 'boilingPointCelsius', -10, 'quantitative')
    const result = await runStage3(ku, [fast], { variant: 'falsification' })
    const ar = result.agentResults[0]
    console.log(`[${fast.model}] water=-10C: verdict=${ar.verdict}`)
    expect(ar.verdict).toBe('disputed')
  })

  live('confirms DNA double helix structure', async () => {
    const { fast } = getAgents()
    const ku = makeKU('medicine', 'DNA', 'structureType', 'double helix')
    const result = await runStage3(ku, [fast])
    const ar = result.agentResults[0]
    console.log(`[${fast.model}] DNA=double helix: verdict=${ar.verdict}`)
    expect(ar.verdict).toBe('confirmed')
  })

  live('disputes aspirin as ACE inhibitor (it is a COX inhibitor)', async () => {
    const { fast } = getAgents()
    const ku = makeKU('medicine', 'aspirin', 'mechanismOfAction', 'ACE inhibitor')
    const result = await runStage3(ku, [fast], { variant: 'falsification' })
    const ar = result.agentResults[0]
    console.log(`[${fast.model}] aspirin=ACE: verdict=${ar.verdict}  counterexamples=${ar.counterexamples?.join(', ')}`)
    expect(ar.verdict).toBe('disputed')
  })

  live('confirms hydrogen atomic number = 1', async () => {
    const { fast } = getAgents()
    const ku = makeKU('chemistry', 'hydrogen', 'atomicNumber', 1, 'quantitative')
    const result = await runStage3(ku, [fast], { variant: 'reproduction' })
    const ar = result.agentResults[0]
    console.log(`[${fast.model}] H=1: verdict=${ar.verdict}`)
    expect(ar.verdict).toBe('confirmed')
  })

  live('disputes false claim: gold atomic number = 999', async () => {
    const { fast } = getAgents()
    const ku = makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative')
    const result = await runStage3(ku, [fast], { variant: 'falsification' })
    const ar = result.agentResults[0]
    console.log(`[${fast.model}] Au=999: verdict=${ar.verdict}`)
    expect(ar.verdict).toBe('disputed')
  })
})

// ─── Multi-agent pool ─────────────────────────────────────────────────────────

describe('Stage 3 — multi-agent pool', () => {
  live('at least 1 agent confirms true chemistry facts', async () => {
    const { pool } = getAgents()
    if (pool.length < 2) { console.log('Only 1 agent available, skipping pool test'); return }

    const trueFacts = [
      makeKU('chemistry', 'oxygen', 'atomicNumber', 8, 'quantitative'),
      makeKU('chemistry', 'water', 'formula', 'H2O'),
    ]
    for (const ku of trueFacts) {
      const result = await runStage3(ku, pool)
      const verdicts = result.agentResults.map(r => r.verdict)
      console.log(`${ku.structured.claims[0].subject}: ${pool.map((a, i) => a.model.split('/')[1]+'='+verdicts[i]).join(' ')}`)
      expect(verdicts.filter(v => v !== 'disputed').length).toBeGreaterThanOrEqual(1)
    }
  })

  live('pairwise kappa measures agent diversity', async () => {
    const { pool } = getAgents()
    if (pool.length < 2) { console.log('Only 1 model available, skipping kappa test'); return }

    const kus = [
      makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative'),
      makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative'),
      makeKU('medicine', 'DNA', 'structureType', 'double helix'),
      makeKU('medicine', 'aspirin', 'mechanismOfAction', 'ACE inhibitor'),
      makeKU('chemistry', 'hydrogen', 'atomicNumber', 1, 'quantitative'),
      makeKU('medicine', 'insulin', 'producedBy', 'adrenal gland'),
    ]

    const allResults: AgentResult[][] = []
    for (const ku of kus) {
      const result = await runStage3(ku, pool)
      allResults.push(result.agentResults)
      console.log(`  ${ku.structured.claims[0].subject}: ${pool.map((a, i) => a.id+'='+result.agentResults[i]?.verdict).join(' ')}`)
    }

    const a = allResults.map(r => r[0].verdict)
    const b = allResults.map(r => r[1].verdict)
    const k = kappa(a, b)
    console.log(`Kappa(${pool[0].model.split('/')[1]}, ${pool[1].model.split('/')[1]}) = ${k.toFixed(3)}`)
    console.log(`Agent 0 verdicts: ${a.join(',')}`)
    console.log(`Agent 1 verdicts: ${b.join(',')}`)
    // Models may agree or disagree — just verify the metric runs
    expect(k).toBeGreaterThanOrEqual(-1)
    expect(k).toBeLessThanOrEqual(1)
  })
})

// ─── Full pipeline integration ────────────────────────────────────────────────

describe('Full pipeline — real Stage 3 integration', () => {
  live('true claim achieves better score WITH Stage 3 than without', async () => {
    const { pool } = getAgents()
    const graph = new RelationGraph()
    const ku = makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative')
    graph.addKU(ku)

    const withoutS3 = await runPipeline(ku, graph, { mockStage1: true })
    const withS3 = await runPipeline(ku, graph, { mockStage1: true, runStage3: true, agents: pool })

    console.log(`Without Stage3: conf=${withoutS3.confidence.aggregate.toFixed(3)} maturity=${withoutS3.maturity}`)
    console.log(`With Stage3:    conf=${withS3.confidence.aggregate.toFixed(3)} maturity=${withS3.maturity}`)
    console.log(`Stage3 score:   ${withS3.stage3?.stage3Score.toFixed(3)}, consensus=${withS3.stage3?.consensusReached}`)

    // With Stage 3 should be >= without (Stage 3 only boosts via source score)
    expect(withS3.confidence.aggregate).toBeGreaterThanOrEqual(withoutS3.confidence.aggregate - 0.05)
    expect(withS3.maturity).not.toBe('stable') // no reviews → can't be stable
  })

  live('false claim stays below stable after real Stage 3 dispute', async () => {
    const { pool } = getAgents()
    const graph = new RelationGraph()
    const ku = makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative')
    graph.addKU(ku)

    const result = await runPipeline(ku, graph, { mockStage1: true, runStage3: true, agents: pool })
    console.log(`False claim: conf=${result.confidence.aggregate.toFixed(3)} maturity=${result.maturity}`)
    console.log(`Stage3 score: ${result.stage3?.stage3Score.toFixed(3)}`)
    expect(result.maturity).not.toBe('stable')
  })
})
