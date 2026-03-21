/**
 * stage3-live.test.ts — Real Anthropic API tests for Stage 3.
 *
 * All tests are guarded by `skipIf(!ANTHROPIC_API_KEY)` so CI passes without credentials.
 * To run locally: ANTHROPIC_API_KEY=sk-... npx vitest run test/pipeline/stage3-live.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { createAnthropicLiveAgent, createLiveAgentPool } from '../../src/pipeline/stage3-live.js'
import { runStage3 } from '../../src/pipeline/stage3.js'

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY

function skip(name: string, fn: () => Promise<void>) {
  if (HAS_API_KEY) {
    return it(name, fn, 30_000)
  }
  return it.skip(`[no API key] ${name}`, fn)
}

function makeWaterKU() {
  const prov = createProvenance({ did: 'did:key:live-test', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain: 'chemistry', title: { en: 'Water boiling point' }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'quantitative',
    subject: 'water',
    predicate: 'boilingPointCelsius',
    object: 100,
    confidence: 0.95,
    provenanceRef: prov.id,
  }))
  return ku
}

function makeFalseKU() {
  const prov = createProvenance({ did: 'did:key:live-test-false', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain: 'chemistry', title: { en: 'False claim' }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'factual',
    subject: 'water',
    predicate: 'boilingPointCelsius',
    object: 'never boils',
    confidence: 0.9,
    provenanceRef: prov.id,
  }))
  return ku
}

describe('Stage 3 live agent — real Anthropic API', () => {
  skip('createAnthropicLiveAgent returns parseable JSON', async () => {
    const agent = createAnthropicLiveAgent('test-agent')
    const raw = await agent.call(
      'You are a fact-checker. Respond ONLY with JSON.',
      'Is water H2O? JSON: { "verdict": "confirmed"|"disputed"|"uncertain", "confidence": 0-1, "reasoning": "...", "sources": [], "counterexamples": [] }'
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(['confirmed', 'disputed', 'uncertain']).toContain(parsed.verdict)
    expect(typeof parsed.confidence).toBe('number')
  })

  skip('confirms a true claim about water boiling at 100°C', async () => {
    const agent = createAnthropicLiveAgent('agent-water')
    const ku = makeWaterKU()
    const result = await runStage3(ku, [agent], { variant: 'reproduction' })
    expect(result.agentResults).toHaveLength(1)
    const ar = result.agentResults[0]
    // True claim: expect confirmed or uncertain, not disputed
    expect(ar.verdict).not.toBe('disputed')
    expect(ar.confidence).toBeGreaterThan(0.3)
  })

  skip('disputes a false claim (water never boils)', async () => {
    const agent = createAnthropicLiveAgent('agent-false')
    const ku = makeFalseKU()
    const result = await runStage3(ku, [agent], { variant: 'falsification' })
    expect(result.agentResults[0].verdict).toBe('disputed')
  })

  skip('pool of 3 agents reaches consensus on true claim', async () => {
    const agents = createLiveAgentPool(3)
    const ku = makeWaterKU()
    const result = await runStage3(ku, agents)
    expect(result.agentResults).toHaveLength(3)
    const confirmed = result.agentResults.filter(r => r.verdict === 'confirmed').length
    // At least 2 of 3 should confirm a basic chemistry fact
    expect(confirmed).toBeGreaterThanOrEqual(2)
    expect(result.consensusReached).toBe(true)
  })
})
