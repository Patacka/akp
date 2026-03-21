import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, existsSync, readFileSync } from 'fs'
import { KUStore } from '../../src/core/store.js'
import { createKU, createProvenance } from '../../src/core/ku.js'

function makeStore(suffix = '', deltaLogPath?: string) {
  const dir = `C:/Temp/akp-test-store-${Date.now()}-${suffix}`
  mkdirSync(dir, { recursive: true })
  return new KUStore({ dbPath: `${dir}/store.db`, deltaLogPath })
}

function makeProv() {
  return createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
}

let store: KUStore

beforeEach(() => {
  store = makeStore(Math.random().toString(36).slice(2))
})

afterEach(() => {
  store.close()
})

describe('KUStore', () => {
  it('creates and reads a KU', () => {
    const ku = createKU({ domain: 'science', title: { en: 'Test KU' }, provenance: makeProv() })
    store.create(ku)
    const result = store.read(ku.id)
    expect(result).not.toBeNull()
    expect(result!.meta.domain).toBe('science')
  })

  it('returns null for missing id', () => {
    const result = store.read('nonexistent-id')
    expect(result).toBeNull()
  })

  it('update modifies KU fields', () => {
    const ku = createKU({ domain: 'test', title: { en: 'Original' }, provenance: makeProv() })
    store.create(ku)
    store.update(ku.id, (k) => {
      k.narrative.body = 'Updated body text'
    })
    const result = store.read(ku.id)
    expect(result!.narrative.body).toBe('Updated body text')
  })

  it('query filters by domain', () => {
    const ku1 = createKU({ domain: 'domain-a', title: { en: 'A' }, provenance: makeProv() })
    const ku2 = createKU({ domain: 'domain-b', title: { en: 'B' }, provenance: makeProv() })
    store.create(ku1)
    store.create(ku2)
    const results = store.query({ domain: 'domain-a' })
    expect(results.length).toBe(1)
    expect(results[0].meta.domain).toBe('domain-a')
  })

  it('query filters by minConfidence', () => {
    const ku1 = createKU({ domain: 'test', title: { en: 'Low' }, provenance: makeProv() })
    const ku2 = createKU({ domain: 'test', title: { en: 'High' }, provenance: makeProv() })
    store.create(ku1)
    store.create(ku2)
    store.update(ku2.id, (k) => {
      k.meta.confidence.aggregate = 0.8
    })
    const results = store.query({ minConfidence: 0.5 })
    expect(results.length).toBe(1)
    expect(results[0].id).toBe(ku2.id)
  })

  it('delete removes a KU', () => {
    const ku = createKU({ domain: 'test', title: { en: 'To Delete' }, provenance: makeProv() })
    store.create(ku)
    store.delete(ku.id)
    const result = store.read(ku.id)
    expect(result).toBeNull()
  })

  it('allIds returns all created ids', () => {
    const ku1 = createKU({ domain: 'test', title: { en: 'A' }, provenance: makeProv() })
    const ku2 = createKU({ domain: 'test', title: { en: 'B' }, provenance: makeProv() })
    const ku3 = createKU({ domain: 'test', title: { en: 'C' }, provenance: makeProv() })
    store.create(ku1)
    store.create(ku2)
    store.create(ku3)
    const ids = store.allIds()
    expect(ids).toHaveLength(3)
    expect(ids).toContain(ku1.id)
    expect(ids).toContain(ku2.id)
    expect(ids).toContain(ku3.id)
  })

  it('delta log is written', () => {
    const dir = `C:/Temp/akp-test-store-deltalog-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    const deltaLogPath = `${dir}/delta.ndjson`
    const storeWithLog = new KUStore({ dbPath: `${dir}/store.db`, deltaLogPath })
    try {
      const ku = createKU({ domain: 'test', title: { en: 'Logged' }, provenance: makeProv() })
      storeWithLog.create(ku)
      expect(existsSync(deltaLogPath)).toBe(true)
      const content = readFileSync(deltaLogPath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThan(0)
      const entry = JSON.parse(lines[0])
      expect(entry).toHaveProperty('op')
      expect(entry).toHaveProperty('deltaBytes')
    } finally {
      storeWithLog.close()
    }
  })

  it('mergeFrom applies remote changes', () => {
    const ku = createKU({ domain: 'test', title: { en: 'Remote KU' }, provenance: makeProv() })

    const dirA = `C:/Temp/akp-test-store-merge-a-${Date.now()}`
    const dirB = `C:/Temp/akp-test-store-merge-b-${Date.now()}`
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })

    const storeA = new KUStore({ dbPath: `${dirA}/store.db` })
    const storeB = new KUStore({ dbPath: `${dirB}/store.db` })

    try {
      storeA.create(ku)
      const binary = storeA.getAutomergeBinary(ku.id)
      expect(binary).not.toBeNull()

      storeB.mergeFrom(ku.id, binary!)
      const result = storeB.read(ku.id)
      expect(result).not.toBeNull()
      expect(result!.meta.domain).toBe('test')
    } finally {
      storeA.close()
      storeB.close()
    }
  })
})
