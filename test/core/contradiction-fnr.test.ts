import { describe, it, expect } from 'vitest'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { buildContradictionPairs } from '../fixtures/contradictions.js'
import { v7 as uuidv7 } from 'uuid'

describe('2-hop contradiction false negative rate', () => {
  it('detects hop-1 contradictions with >= 70% recall', () => {
    const pairs = buildContradictionPairs().filter(p => p.hopDistance === 1 && p.isContradiction)
    let detected = 0

    for (const { kuA, kuB } of pairs) {
      const graph = new RelationGraph()
      graph.addKU(kuA)
      graph.addKU(kuB)
      const claim = kuB.structured.claims[0]
      const contradictions = graph.checkContradictions(claim, kuB.id, 2)
      if (contradictions.length > 0) detected++
    }

    const rate = detected / pairs.length
    console.log(`Hop-1 recall: ${detected}/${pairs.length} = ${(rate * 100).toFixed(1)}%`)
    expect(rate).toBeGreaterThan(0.7)
  })

  it('detects hop-2 contradictions when bridge KU is in graph', () => {
    const pairs = buildContradictionPairs().filter(p => p.hopDistance === 2 && p.isContradiction)
    let detected = 0

    for (const { kuA, kuB } of pairs) {
      const graph = new RelationGraph()
      // Add kuA (contains relation to mid)
      graph.addKU(kuA)

      // Build synthetic bridge connecting kuA to kuB
      const prov = createProvenance({ did: 'did:key:bridge', type: 'agent', method: 'synthesis' })
      const bridge = createKU({ domain: kuA.meta.domain, title: { en: 'bridge' }, provenance: prov })
      bridge.structured.relations.push(
        { id: uuidv7(), type: 'related', sourceKuId: bridge.id, targetKuId: kuA.id, confidence: 0.9, confirmedBy: ['a', 'b'] },
        { id: uuidv7(), type: 'related', sourceKuId: bridge.id, targetKuId: kuB.id, confidence: 0.9, confirmedBy: ['a', 'b'] }
      )
      graph.addKU(bridge)
      graph.addKU(kuB)

      const claim = kuB.structured.claims[0]
      const contradictions = graph.checkContradictions(claim, kuB.id, 2)
      if (contradictions.length > 0) detected++
    }

    const rate = detected / pairs.length
    console.log(`Hop-2 recall (with bridge): ${detected}/${pairs.length} = ${(rate * 100).toFixed(1)}%`)
    expect(rate).toBeGreaterThan(0.5)
  })

  it('has false positive rate < 20% on true negatives', () => {
    const pairs = buildContradictionPairs().filter(p => !p.isContradiction)
    let fps = 0

    for (const { kuA, kuB } of pairs) {
      const graph = new RelationGraph()
      graph.addKU(kuA)
      graph.addKU(kuB)
      const contradictions = graph.checkContradictions(kuB.structured.claims[0], kuB.id, 2)
      if (contradictions.length > 0) fps++
    }

    const fpr = fps / pairs.length
    console.log(`False positive rate: ${fps}/${pairs.length} = ${(fpr * 100).toFixed(1)}%`)
    expect(fpr).toBeLessThan(0.2)
  })

  it('documents hop-3/4 as outside 2-hop detection window (known limitation)', () => {
    const pairs3 = buildContradictionPairs().filter(p => p.hopDistance === 3 && p.isContradiction)
    const pairs4 = buildContradictionPairs().filter(p => p.hopDistance === 4 && p.isContradiction)

    let det3 = 0, det4 = 0
    for (const { kuA, kuB } of pairs3) {
      const graph = new RelationGraph()
      graph.addKU(kuA)
      graph.addKU(kuB)
      if (graph.checkContradictions(kuB.structured.claims[0], kuB.id, 2).length > 0) det3++
    }
    for (const { kuA, kuB } of pairs4) {
      const graph = new RelationGraph()
      graph.addKU(kuA)
      graph.addKU(kuB)
      if (graph.checkContradictions(kuB.structured.claims[0], kuB.id, 2).length > 0) det4++
    }

    console.log(`Hop-3 recall (2-hop window, no intermediates): ${det3}/${pairs3.length} = ${((det3 / pairs3.length) * 100).toFixed(1)}%`)
    console.log(`Hop-4 recall (2-hop window, no intermediates): ${det4}/${pairs4.length} = ${((det4 / pairs4.length) * 100).toFixed(1)}%`)
    // Expected: ~0% without intermediate nodes — this documents the known limitation
    expect(det3 / pairs3.length).toBeLessThan(0.5)
    expect(det4 / pairs4.length).toBeLessThan(0.5)
  })
})
