import { describe, it, expect } from 'vitest'
import { runStage3, createMockAgent } from '../../src/pipeline/stage3.js'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'

function makeKU() {
  const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'factual',
    subject: 'caffeine',
    predicate: 'molecularWeight',
    object: 194.19,
    confidence: 0.95,
    provenanceRef: prov.id,
  }))
  ku.narrative.summary = 'Caffeine is a stimulant with molecular weight 194.19 g/mol'
  return ku
}

describe('Stage 3 corroboration', () => {
  it('reaches consensus with 3 confirming agents', async () => {
    const ku = makeKU()
    const agents = [
      createMockAgent('a1', 'claude-3', 'confirm'),
      createMockAgent('a2', 'gpt-4', 'confirm'),
      createMockAgent('a3', 'gemini', 'confirm'),
    ]
    const result = await runStage3(ku, agents)
    expect(result.consensusReached).toBe(true)
    expect(result.stage3Score).toBeGreaterThan(0.6)
    expect(result.agentResults).toHaveLength(3)
  })

  it('returns low score when agents dispute', async () => {
    const ku = makeKU()
    const agents = [
      createMockAgent('a1', 'claude-3', 'dispute'),
      createMockAgent('a2', 'gpt-4', 'dispute'),
      createMockAgent('a3', 'gemini', 'dispute'),
    ]
    const result = await runStage3(ku, agents)
    expect(result.stage3Score).toBeLessThan(0.4)
  })

  it('handles empty agents gracefully', async () => {
    const ku = makeKU()
    const result = await runStage3(ku, [])
    expect(result.stage3Score).toBe(0)
    expect(result.consensusReached).toBe(false)
  })

  it('uses triangulation variant for factual claims', async () => {
    const ku = makeKU()
    const agents = [createMockAgent('a1', 'claude-3', 'confirm')]
    const result = await runStage3(ku, agents)
    expect(result.variant).toBe('triangulation')
  })

  it('uses reproduction variant for quantitative claims', async () => {
    const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'test', title: { en: 'Quant' }, provenance: prov })
    ku.structured.claims.push(createClaim({
      type: 'quantitative',
      subject: 'pi',
      predicate: 'value',
      object: 3.14159,
      confidence: 0.99,
      provenanceRef: prov.id,
    }))
    const agents = [createMockAgent('a1', 'claude-3', 'confirm')]
    const result = await runStage3(ku, agents, { variant: 'reproduction' })
    expect(result.variant).toBe('reproduction')
  })
})
