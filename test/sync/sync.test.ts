import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KUStore } from '../../src/core/store.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { syncStores } from '../../src/sync/protocol.js'
import { mkdirSync } from 'fs'

let storeA: KUStore
let storeB: KUStore

function tmpDb(name: string) {
  const dir = `C:/Temp/akp-sync-test-${Date.now()}`
  mkdirSync(dir, { recursive: true })
  return `${dir}/${name}.db`
}

function makeKU(domain = 'test') {
  const prov = createProvenance({ did: 'did:key:sync-test', type: 'agent', method: 'synthesis' })
  return createKU({ domain, title: { en: `KU ${Math.random().toFixed(4)}` }, provenance: prov })
}

beforeEach(() => {
  storeA = new KUStore({ dbPath: tmpDb('nodeA') })
  storeB = new KUStore({ dbPath: tmpDb('nodeB') })
})

afterEach(() => {
  storeA?.close()
  storeB?.close()
})

describe('Two-node sync', () => {
  it('syncs a single KU from A to B', async () => {
    const ku = makeKU()
    storeA.create(ku)

    await syncStores(storeA, storeB)

    const synced = storeB.read(ku.id)
    expect(synced).not.toBeNull()
    expect(synced!.meta.domain).toBe('test')
  })

  it('syncs 10 KUs from A to B', async () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const ku = makeKU()
      ids.push(ku.id)
      storeA.create(ku)
    }

    await syncStores(storeA, storeB)

    for (const id of ids) {
      expect(storeB.read(id)).not.toBeNull()
    }
  })

  it('syncs in both directions (bidirectional)', async () => {
    const kuA = makeKU('science')
    const kuB = makeKU('medicine')
    storeA.create(kuA)
    storeB.create(kuB)

    await syncStores(storeA, storeB)

    expect(storeA.read(kuB.id)).not.toBeNull()
    expect(storeB.read(kuA.id)).not.toBeNull()
  })

  it('converges concurrent edits via CRDT merge', async () => {
    // Create KU on A, sync to B so both share the same Automerge document history
    const ku = makeKU()
    storeA.create(ku)
    await syncStores(storeA, storeB)

    // Both make independent edits from the shared base state
    storeA.update(ku.id, (k) => { k.meta.tags.push('tag-from-a') }, 'edit')
    storeB.update(ku.id, (k) => { k.meta.tags.push('tag-from-b') }, 'edit')

    await syncStores(storeA, storeB)

    // Both nodes should have both tags (CRDT merge)
    const finalA = storeA.read(ku.id)!
    const finalB = storeB.read(ku.id)!
    expect(finalA.meta.tags).toContain('tag-from-a')
    expect(finalA.meta.tags).toContain('tag-from-b')
    expect(finalB.meta.tags).toContain('tag-from-a')
    expect(finalB.meta.tags).toContain('tag-from-b')
  })

  it('syncs 50 KUs within 5 seconds', async () => {
    for (let i = 0; i < 50; i++) {
      storeA.create(makeKU())
    }

    const start = Date.now()
    await syncStores(storeA, storeB)
    const elapsed = Date.now() - start

    expect(storeB.allIds().length).toBe(50)
    expect(elapsed).toBeLessThan(5000)
  }, 10000)

  it('is idempotent: re-syncing produces no changes', async () => {
    const ku = makeKU()
    storeA.create(ku)
    await syncStores(storeA, storeB)

    const result2 = await syncStores(storeA, storeB)
    // Second sync should exchange 0 messages (already in sync)
    expect(result2.exchanged).toBe(0)
  })
})
