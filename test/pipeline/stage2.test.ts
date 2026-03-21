import { describe, it, expect } from 'vitest'
import { runStage2 } from '../../src/pipeline/stage2.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'

function makeProv() {
  return createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
}

describe('runStage2', () => {
  it('returns score 1.0 for KU with no claims in empty graph', async () => {
    const graph = new RelationGraph()
    const ku = createKU({ domain: 'test', title: { en: 'Empty KU' }, provenance: makeProv() })
    graph.addKU(ku)
    const result = await runStage2(ku, graph)
    expect(result.stage2Score).toBe(1.0)
    expect(result.contradictions.length).toBe(0)
  })

  it('detects direct contradiction', async () => {
    const graph = new RelationGraph()
    const prov1 = makeProv()
    const ku1 = createKU({ domain: 'test', title: { en: 'KU1' }, provenance: prov1 })
    const claim1 = createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boils',
      object: 100,
      confidence: 0.9,
      provenanceRef: prov1.id,
    })
    ku1.structured.claims.push(claim1)
    graph.addKU(ku1)

    const prov2 = makeProv()
    const ku2 = createKU({ domain: 'test', title: { en: 'KU2' }, provenance: prov2 })
    ku2.structured.relations.push({
      id: uuidv7(),
      type: 'related',
      sourceKuId: ku2.id,
      targetKuId: ku1.id,
      confidence: 0.9,
      confirmedBy: [],
    })
    graph.addKU(ku2)

    // New claim for ku2 that contradicts ku1
    const claim2 = createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boils',
      object: 90, // contradicts 100 (>10% diff)
      confidence: 0.9,
      provenanceRef: prov2.id,
    })
    ku2.structured.claims.push(claim2)
    graph.addKU(ku2)

    const result = await runStage2(ku2, graph)
    expect(result.contradictions.length).toBeGreaterThan(0)
  })

  it('returns no contradiction for consistent claims', async () => {
    const graph = new RelationGraph()
    const prov1 = makeProv()
    const ku1 = createKU({ domain: 'test', title: { en: 'KU1' }, provenance: prov1 })
    const claim1 = createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boils',
      object: 100,
      confidence: 0.9,
      provenanceRef: prov1.id,
    })
    ku1.structured.claims.push(claim1)
    graph.addKU(ku1)

    const prov2 = makeProv()
    const ku2 = createKU({ domain: 'test', title: { en: 'KU2' }, provenance: prov2 })
    ku2.structured.relations.push({
      id: uuidv7(),
      type: 'related',
      sourceKuId: ku2.id,
      targetKuId: ku1.id,
      confidence: 0.9,
      confirmedBy: [],
    })
    const claim2 = createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boils',
      object: 100, // same value, no contradiction
      confidence: 0.9,
      provenanceRef: prov2.id,
    })
    ku2.structured.claims.push(claim2)
    graph.addKU(ku2)

    const result = await runStage2(ku2, graph)
    expect(result.contradictions.length).toBe(0)
  })

  it('stage2Score penalizes contradictions', async () => {
    const graph = new RelationGraph()
    const prov1 = makeProv()
    const ku1 = createKU({ domain: 'test', title: { en: 'KU1' }, provenance: prov1 })
    const claim1 = createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boils',
      object: 100,
      confidence: 0.9,
      provenanceRef: prov1.id,
    })
    ku1.structured.claims.push(claim1)
    graph.addKU(ku1)

    const prov2 = makeProv()
    const ku2 = createKU({ domain: 'test', title: { en: 'KU2' }, provenance: prov2 })
    ku2.structured.relations.push({
      id: uuidv7(),
      type: 'related',
      sourceKuId: ku2.id,
      targetKuId: ku1.id,
      confidence: 0.9,
      confirmedBy: [],
    })
    const claim2 = createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boils',
      object: 90, // contradicts
      confidence: 0.9,
      provenanceRef: prov2.id,
    })
    ku2.structured.claims.push(claim2)
    graph.addKU(ku2)

    const result = await runStage2(ku2, graph)
    expect(result.stage2Score).toBeLessThan(1.0)
  })
})
