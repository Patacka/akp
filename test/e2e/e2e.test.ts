import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { KUStore } from '../../src/core/store.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { runPipeline } from '../../src/pipeline/index.js'
import { syncStores } from '../../src/sync/protocol.js'
import { mkdirSync } from 'fs'
import { v7 as uuidv7 } from 'uuid'

let storeA: KUStore, graphA: RelationGraph
let storeB: KUStore, graphB: RelationGraph

beforeAll(() => {
  mkdirSync('C:/Temp/akp-e2e', { recursive: true })
  storeA = new KUStore({ dbPath: `C:/Temp/akp-e2e/nodeA-${Date.now()}.db` })
  graphA = new RelationGraph()
  storeB = new KUStore({ dbPath: `C:/Temp/akp-e2e/nodeB-${Date.now()}.db` })
  graphB = new RelationGraph()
})

afterAll(() => {
  storeA?.close()
  storeB?.close()
})

describe('End-to-end: two-node AKP workflow', () => {
  let waterKuId: string
  let caffeineKuId: string

  it('Node A: creates and validates a KU through the full pipeline', async () => {
    const prov = createProvenance({
      did: 'did:key:scientist-a',
      type: 'human',
      method: 'observation',
      sources: [{ id: uuidv7(), type: 'url', value: 'https://example.com/water', title: 'Water properties' }],
    })
    const ku = createKU({
      domain: 'chemistry',
      title: { en: 'Water (H₂O)' },
      summary: 'Water is a polar inorganic compound with boiling point 100°C at 1 atm.',
      tags: ['chemistry', 'compounds'],
      provenance: prov,
    })
    ku.structured.claims.push(createClaim({
      type: 'quantitative',
      subject: 'water',
      predicate: 'boilingPoint',
      object: 100,
      confidence: 0.99,
      provenanceRef: prov.id,
    }))

    const result = await runPipeline(ku, graphA, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity

    waterKuId = storeA.create(ku)
    graphA.addKU(ku)

    expect(waterKuId).toBeTruthy()
    expect(result.stage1.stage1Score).toBeGreaterThanOrEqual(0)
    expect(result.stage2.stage2Score).toBeGreaterThanOrEqual(0)
  })

  it('Node A: creates a second KU with a relation to the first', async () => {
    const prov = createProvenance({ did: 'did:key:scientist-a', type: 'human', method: 'synthesis' })
    const ku = createKU({
      domain: 'chemistry',
      title: { en: 'Caffeine' },
      summary: 'Caffeine is a central nervous system stimulant, molecular weight 194.19 g/mol.',
      tags: ['chemistry', 'pharmacology'],
      provenance: prov,
    })
    ku.structured.claims.push(createClaim({
      type: 'quantitative',
      subject: 'caffeine',
      predicate: 'molecularWeight',
      object: 194.19,
      confidence: 0.99,
      provenanceRef: prov.id,
    }))
    ku.structured.relations.push({
      id: uuidv7(),
      type: 'related_compound',
      sourceKuId: ku.id,
      targetKuId: waterKuId,
      confidence: 0.7,
      confirmedBy: [],
    })

    const result = await runPipeline(ku, graphA, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity

    caffeineKuId = storeA.create(ku)
    graphA.addKU(ku)

    expect(result.stage2.contradictions).toHaveLength(0)
  })

  it('Node A: submits a review to boost confidence', async () => {
    const ku = storeA.read(waterKuId)!
    storeA.update(waterKuId, (k) => {
      k.reviews.push({
        id: uuidv7(),
        reviewerDid: 'did:key:peer-reviewer',
        reviewerType: 'agent',
        timestamp: new Date().toISOString(),
        verdict: 'confirmed',
        scope: ku.structured.claims.map(c => c.id),
        weight: 0.8,
      })
    }, 'add_review')
    const updated = storeA.read(waterKuId)!
    const result = await runPipeline(updated, graphA, { mockStage1: true })
    storeA.update(waterKuId, (k) => {
      k.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
      k.meta.maturity = result.maturity
    }, 'update_confidence')
    expect(result.confidence.aggregate).toBeGreaterThan(0)
  })

  it('Node B: starts empty, then syncs from Node A', async () => {
    expect(storeB.allIds()).toHaveLength(0)

    await syncStores(storeA, storeB)

    const idsB = storeB.allIds()
    expect(idsB.length).toBe(2)
    expect(idsB).toContain(waterKuId)
    expect(idsB).toContain(caffeineKuId)
  })

  it('Node B: can query synced KUs', () => {
    const results = storeB.query({ domain: 'chemistry', minConfidence: 0 })
    expect(results.length).toBe(2)
    expect(results.some(r => r.id === waterKuId)).toBe(true)
  })

  it('Node B: makes an edit, Node A syncs it back', async () => {
    storeB.update(caffeineKuId, (k) => {
      k.meta.tags.push('stimulant')
    }, 'edit')

    await syncStores(storeB, storeA)

    const updatedOnA = storeA.read(caffeineKuId)!
    expect(updatedOnA.meta.tags).toContain('stimulant')
  })

  it('Both nodes converge to identical state', async () => {
    await syncStores(storeA, storeB)

    const idsA = storeA.allIds().sort()
    const idsB = storeB.allIds().sort()
    expect(idsA).toEqual(idsB)

    for (const id of idsA) {
      const kuA = storeA.read(id)!
      const kuB = storeB.read(id)!
      expect(kuA.meta.tags.sort()).toEqual(kuB.meta.tags.sort())
    }
  })
})
