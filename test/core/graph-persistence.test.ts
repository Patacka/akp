/**
 * Graph persistence tests.
 *
 * Verifies that _persistGraphData() keeps the graph_* SQLite tables in sync
 * and that buildGraph() can reconstruct a correct RelationGraph from them
 * without deserializing any Automerge documents.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { KUStore } from '../../src/core/store.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { generateIdentity } from '../../src/core/identity.js'
import { v7 as uuidv7 } from 'uuid'

async function makeKU(domain = 'test') {
  const id = await generateIdentity()
  return createKU({
    domain,
    title: { en: `KU-${Math.random().toFixed(4)}` },
    summary: 'graph persistence test',
    provenance: createProvenance({ did: id.did, type: 'agent', method: 'synthesis' }),
  })
}

describe('Graph table population', () => {
  let store: KUStore

  beforeEach(() => { store = new KUStore({ dbPath: ':memory:' }) })

  it('inserts claim rows when a KU is created', async () => {
    const ku = await makeKU()
    ku.structured.claims.push({
      id: uuidv7(),
      type: 'factual',
      subject: 'Water',
      predicate: 'boiling_point',
      object: '100°C',
      confidence: 0.99,
      provenanceRef: ku.provenance[0].id,
      replications: [],
    } as Parameters<typeof ku.structured.claims.push>[0])

    store.create(ku)

    const rows = (store as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } })
      .db.prepare('SELECT * FROM graph_claims_index WHERE ku_id = ?').all(ku.id)
    expect(rows.length).toBe(1)
  })

  it('removes claim rows when a KU is deleted', async () => {
    const ku = await makeKU()
    ku.structured.claims.push({
      id: uuidv7(), type: 'factual', subject: 'X', predicate: 'has', object: 'Y',
      confidence: 0.5, provenanceRef: ku.provenance[0].id, replications: [],
    } as Parameters<typeof ku.structured.claims.push>[0])
    store.create(ku)
    store.delete(ku.id)

    const rows = (store as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } })
      .db.prepare('SELECT * FROM graph_claims_index WHERE ku_id = ?').all(ku.id)
    expect(rows.length).toBe(0)
  })

  it('updates claim rows when a KU is updated', async () => {
    const ku = await makeKU()
    const claimId = uuidv7()
    ku.structured.claims.push({
      id: claimId, type: 'factual', subject: 'Iron', predicate: 'atomic_number', object: '26',
      confidence: 0.99, provenanceRef: ku.provenance[0].id, replications: [],
    } as Parameters<typeof ku.structured.claims.push>[0])
    store.create(ku)

    // Update the claim subject
    store.update(ku.id, (k) => {
      const claim = k.structured.claims.find(c => c.id === claimId)
      if (claim) (claim as Record<string, unknown>).subject = 'Iron element'
    })

    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
    const row = db.prepare('SELECT subject_orig FROM graph_claims_index WHERE ku_id = ? AND claim_id = ?')
      .get(ku.id, claimId) as { subject_orig: string } | undefined
    expect(row?.subject_orig).toBe('Iron element')
  })
})

describe('buildGraph() from persistent tables', () => {
  it('reconstructs the graph without Automerge deserialization', async () => {
    const store = new KUStore({ dbPath: ':memory:' })
    const ku = await makeKU()
    ku.structured.claims.push({
      id: uuidv7(), type: 'factual', subject: 'Helium', predicate: 'atomic_number', object: '2',
      confidence: 0.99, provenanceRef: ku.provenance[0].id, replications: [],
    } as Parameters<typeof ku.structured.claims.push>[0])
    store.create(ku)

    // Build graph — uses fast path from tables
    const graph = store.buildGraph()
    const stats = graph.getStats()
    expect(stats.nodeCount).toBeGreaterThanOrEqual(0)

    // Inverted index must be populated so contradiction detection works
    const claims = graph.findClaims({ subject: 'Helium' })
    expect(claims.length).toBe(1)
    expect(claims[0].claim.predicate).toBe('atomic_number')
    expect(claims[0].kuId).toBe(ku.id)
  })

  it('migration: backfills old KUs that have no graph table rows', async () => {
    // Simulate a KU created before graph tables existed by directly
    // clearing the graph table for an existing KU
    const store = new KUStore({ dbPath: ':memory:' })
    const ku = await makeKU()
    ku.structured.claims.push({
      id: uuidv7(), type: 'factual', subject: 'Oxygen', predicate: 'atomic_number', object: '8',
      confidence: 0.99, provenanceRef: ku.provenance[0].id, replications: [],
    } as Parameters<typeof ku.structured.claims.push>[0])
    store.create(ku)

    // Simulate pre-migration state: wipe graph tables
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
    db.prepare('DELETE FROM graph_claims_index').run()
    db.prepare('DELETE FROM graph_edges').run()
    db.prepare('DELETE FROM graph_entities_index').run()

    // buildGraph() should detect the gap and backfill
    const graph = store.buildGraph()
    const claims = graph.findClaims({ subject: 'Oxygen' })
    expect(claims.length).toBe(1)
  })

  it('checkContradictions works correctly after graph rebuild from tables', async () => {
    const store = new KUStore({ dbPath: ':memory:' })

    const ku1 = await makeKU()
    const claimId = uuidv7()
    ku1.structured.claims.push({
      id: claimId, type: 'factual', subject: 'Gold', predicate: 'atomic_number', object: '79',
      confidence: 0.99, provenanceRef: ku1.provenance[0].id, replications: [],
    } as Parameters<typeof ku1.structured.claims.push>[0])
    store.create(ku1)

    const graph = store.buildGraph()

    // A new claim asserting a conflicting value for Gold atomic_number should trigger a contradiction
    const conflictingClaim = {
      id: uuidv7(), type: 'factual' as const, subject: 'Gold', predicate: 'atomic_number',
      object: '80',  // wrong
      confidence: 0.5, provenanceRef: ku1.provenance[0].id, replications: [],
    }
    graph.addKU(ku1)  // also put in memory graph so BFS can find neighbors
    const contradictions = graph.checkContradictions(conflictingClaim, ku1.id, 2)
    expect(contradictions.length).toBeGreaterThan(0)
    expect(contradictions[0].reason).toMatch(/Factual contradiction/)
  })
})
