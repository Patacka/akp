import { describe, it, expect } from 'vitest'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'

function makeKU(domain = 'test') {
  const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
  return createKU({ domain, title: { en: 'Test' }, provenance: prov })
}

describe('RelationGraph', () => {
  it('adds and removes KUs', () => {
    const graph = new RelationGraph()
    const ku = makeKU()
    graph.addKU(ku)
    expect(graph.getStats().nodeCount).toBe(1)
    graph.removeKU(ku.id)
    expect(graph.getStats().nodeCount).toBe(0)
  })

  it('detects direct contradiction', () => {
    const graph = new RelationGraph()
    const ku1 = makeKU()
    ku1.structured.claims.push(createClaim({
      type: 'factual',
      subject: 'water',
      predicate: 'boilingPoint',
      object: 100,
      confidence: 0.99,
      provenanceRef: uuidv7(),
    }))
    graph.addKU(ku1)

    const newClaim = createClaim({
      type: 'factual',
      subject: 'water',
      predicate: 'boilingPoint',
      object: 90,  // contradicts 100
      confidence: 0.8,
      provenanceRef: uuidv7(),
    })

    const ku2 = makeKU()
    ku2.structured.relations.push({
      id: uuidv7(),
      type: 'related',
      sourceKuId: ku2.id,
      targetKuId: ku1.id,
      confidence: 0.9,
      confirmedBy: [],
    })
    graph.addKU(ku2)

    const contradictions = graph.checkContradictions(newClaim, ku2.id, 2)
    expect(contradictions.length).toBeGreaterThan(0)
  })

  it('gets neighbors within hop distance', () => {
    const graph = new RelationGraph()
    const ku1 = makeKU()
    const ku2 = makeKU()
    const ku3 = makeKU()

    ku1.structured.relations.push({
      id: uuidv7(), type: 'related',
      sourceKuId: ku1.id, targetKuId: ku2.id,
      confidence: 0.9, confirmedBy: [],
    })
    ku2.structured.relations.push({
      id: uuidv7(), type: 'related',
      sourceKuId: ku2.id, targetKuId: ku3.id,
      confidence: 0.9, confirmedBy: [],
    })

    graph.addKU(ku1)
    graph.addKU(ku2)
    graph.addKU(ku3)

    const hop1 = graph.getNeighbors(ku1.id, 1)
    expect(hop1.has(ku2.id)).toBe(true)
    expect(hop1.has(ku3.id)).toBe(false)

    const hop2 = graph.getNeighbors(ku1.id, 2)
    expect(hop2.has(ku3.id)).toBe(true)
  })
})
