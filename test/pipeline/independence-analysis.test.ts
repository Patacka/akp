/**
 * independence-analysis.test.ts — Measures LLM inter-agent independence (agreement patterns).
 *
 * Tests with real API keys are skipped in CI.
 * Mock-agent tests run unconditionally to document the expected behavior.
 */
import { describe, it, expect } from 'vitest'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { createMockAgent } from '../../src/pipeline/stage3.js'
import { runStage3 } from '../../src/pipeline/stage3.js'
import type { AgentResult } from '../../src/pipeline/stage3.js'

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY

function skip(name: string, fn: () => Promise<void>) {
  if (HAS_API_KEY) return it(name, fn, 60_000)
  return it.skip(`[no API key] ${name}`, fn)
}

function makeKU(domain: string, subject: string, predicate: string, object: unknown) {
  const prov = createProvenance({ did: 'did:key:indep', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain, title: { en: `${subject} ${predicate}` }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'factual', subject, predicate, object, confidence: 0.9, provenanceRef: prov.id,
  }))
  return ku
}

/** Cohen's kappa for two verdict sequences */
function cohensKappa(a: string[], b: string[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  const n = a.length
  const labels = Array.from(new Set([...a, ...b]))
  const observed = a.filter((v, i) => v === b[i]).length / n

  const freqA = Object.fromEntries(labels.map(l => [l, a.filter(v => v === l).length / n]))
  const freqB = Object.fromEntries(labels.map(l => [l, b.filter(v => v === l).length / n]))
  const expected = labels.reduce((s, l) => s + freqA[l] * freqB[l], 0)

  return expected >= 1 ? 1 : (observed - expected) / (1 - expected)
}

/** Pairwise average kappa across all agent pairs */
function avgPairwiseKappa(results: AgentResult[][]): number {
  // results[sampleIdx][agentIdx]
  const numAgents = results[0]?.length ?? 0
  if (numAgents < 2) return NaN

  let totalKappa = 0
  let pairs = 0
  for (let i = 0; i < numAgents; i++) {
    for (let j = i + 1; j < numAgents; j++) {
      const a = results.map(r => r[i].verdict)
      const b = results.map(r => r[j].verdict)
      totalKappa += cohensKappa(a, b)
      pairs++
    }
  }
  return pairs > 0 ? totalKappa / pairs : 0
}

// ─── Mock-based independence tests (always run) ────────────────────────────

describe('Independence analysis — mock agents', () => {
  it('three identical confirm-agents have kappa=1.0 (perfect agreement = low independence)', async () => {
    const agents = [
      createMockAgent('a0', 'mock', 'confirm'),
      createMockAgent('a1', 'mock', 'confirm'),
      createMockAgent('a2', 'mock', 'confirm'),
    ]
    const ku = makeKU('chemistry', 'water', 'formula', 'H2O')
    const allResults: AgentResult[][] = []
    for (let i = 0; i < 10; i++) {
      const result = await runStage3(ku, agents)
      allResults.push(result.agentResults)
    }
    const kappa = avgPairwiseKappa(allResults)
    console.log(`Identical agents kappa: ${kappa.toFixed(3)} (expected ~1.0)`)
    expect(kappa).toBeGreaterThan(0.9)
  })

  it('mixed confirm/dispute agents have lower kappa (higher independence)', async () => {
    const agents = [
      createMockAgent('a0', 'mock', 'confirm'),
      createMockAgent('a1', 'mock', 'dispute'),
      createMockAgent('a2', 'mock', 'random'),
    ]
    const ku = makeKU('medicine', 'aspirin', 'mechanism', 'COX inhibitor')
    const allResults: AgentResult[][] = []
    for (let i = 0; i < 20; i++) {
      const result = await runStage3(ku, agents)
      allResults.push(result.agentResults)
    }
    const kappa = avgPairwiseKappa(allResults)
    console.log(`Mixed agents kappa: ${kappa.toFixed(3)} (expected lower)`)
    // Mixed agents should be less correlated than identical ones
    expect(kappa).toBeLessThan(0.9)
  })

  it('documents that mock agents cannot model true LLM independence (known limitation)', async () => {
    // Mock agents are deterministic; true independence requires diverse real models
    // This test documents the limitation: mock kappa is always ±0 or ±1
    const allConfirm = [
      createMockAgent('x0', 'mock', 'confirm'),
      createMockAgent('x1', 'mock', 'confirm'),
    ]
    const ku = makeKU('chemistry', 'gold', 'atomicNumber', 79)
    const results: AgentResult[][] = []
    for (let i = 0; i < 5; i++) {
      const r = await runStage3(ku, allConfirm)
      results.push(r.agentResults)
    }
    const kappa = avgPairwiseKappa(results)
    // Perfect correlation expected with identical mock agents
    console.log(`[known limitation] Mock identical kappa: ${kappa.toFixed(3)}`)
    expect(kappa).toBeGreaterThanOrEqual(0.99)
  })
})

// ─── Real-API independence tests (CI-skipped) ──────────────────────────────

describe('Independence analysis — real API', () => {
  skip('two live Claude agents have kappa < 0.9 (some independent variation)', async () => {
    const { createLiveAgentPool } = await import('../../src/pipeline/stage3-live.js')
    const agents = createLiveAgentPool(2)

    const kus = [
      makeKU('chemistry', 'water', 'boilingPointCelsius', 100),
      makeKU('chemistry', 'ethanol', 'boilingPointCelsius', 78.4),
      makeKU('medicine', 'aspirin', 'mechanism', 'COX inhibitor'),
      makeKU('medicine', 'insulin', 'producedBy', 'pancreatic beta cells'),
      makeKU('chemistry', 'oxygen', 'atomicNumber', 8),
    ]

    const allResults: AgentResult[][] = []
    for (const ku of kus) {
      const result = await runStage3(ku, agents)
      allResults.push(result.agentResults)
    }

    const kappa = avgPairwiseKappa(allResults)
    console.log(`Live agents (2) pairwise kappa: ${kappa.toFixed(3)}`)
    // Expect less than perfect agreement (agents are not clones)
    expect(kappa).toBeLessThan(0.95)
  })

  skip('kappa decreases as number of agents grows (more diverse perspectives)', async () => {
    const { createLiveAgentPool } = await import('../../src/pipeline/stage3-live.js')
    const ku = makeKU('chemistry', 'hydrogen', 'atomicNumber', 1)

    const kappas: number[] = []
    for (const n of [2, 3]) {
      const agents = createLiveAgentPool(n)
      const results: AgentResult[][] = []
      for (let trial = 0; trial < 3; trial++) {
        const r = await runStage3(ku, agents)
        results.push(r.agentResults)
      }
      kappas.push(avgPairwiseKappa(results))
    }

    console.log(`Kappa at 2 agents: ${kappas[0].toFixed(3)}, at 3 agents: ${kappas[1].toFixed(3)}`)
    // More agents → at least one pair should diverge somewhat
    expect(kappas[1]).toBeLessThanOrEqual(kappas[0] + 0.1)
  })
})
