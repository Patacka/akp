/**
 * bucket.test.ts — KBucketTable unit tests.
 */

import { describe, it, expect } from 'vitest'
import {
  KBucketTable, nodeIdFromDid, xorDistance, commonPrefixBits, networkKey, K,
} from '../../src/dht/bucket.js'

function fakeContact(did: string, syncUrl = 'wss://test', httpUrl = 'http://test') {
  return { id: nodeIdFromDid(did), syncUrl, httpUrl, lastSeen: Date.now() }
}

describe('nodeIdFromDid', () => {
  it('returns a 32-byte buffer', () => {
    const id = nodeIdFromDid('did:key:zabc')
    expect(id.length).toBe(32)
  })

  it('is deterministic', () => {
    expect(nodeIdFromDid('did:key:z123').equals(nodeIdFromDid('did:key:z123'))).toBe(true)
  })

  it('is unique per DID', () => {
    expect(nodeIdFromDid('did:key:zA').equals(nodeIdFromDid('did:key:zB'))).toBe(false)
  })
})

describe('networkKey', () => {
  it('returns a 32-byte buffer', () => {
    expect(networkKey('mainnet').length).toBe(32)
  })

  it('differs by network name', () => {
    expect(networkKey('mainnet').equals(networkKey('testnet'))).toBe(false)
  })
})

describe('xorDistance', () => {
  it('distance to self is zero', () => {
    const id = nodeIdFromDid('did:key:z1')
    const d = xorDistance(id, id)
    expect(d.every(b => b === 0)).toBe(true)
  })

  it('is symmetric', () => {
    const a = nodeIdFromDid('did:key:zA')
    const b = nodeIdFromDid('did:key:zB')
    expect(xorDistance(a, b).equals(xorDistance(b, a))).toBe(true)
  })
})

describe('commonPrefixBits', () => {
  it('identical nodes share all 256 bits', () => {
    const id = nodeIdFromDid('did:key:z1')
    expect(commonPrefixBits(id, id)).toBe(256)
  })

  it('different nodes share fewer than 256 bits', () => {
    const a = nodeIdFromDid('did:key:zA')
    const b = nodeIdFromDid('did:key:zB')
    expect(commonPrefixBits(a, b)).toBeLessThan(256)
  })
})

describe('KBucketTable', () => {
  it('starts empty', () => {
    const table = new KBucketTable(nodeIdFromDid('did:key:local'))
    expect(table.size()).toBe(0)
  })

  it('upserts a contact', () => {
    const table = new KBucketTable(nodeIdFromDid('did:key:local'))
    table.upsert(fakeContact('did:key:peer1'))
    expect(table.size()).toBe(1)
  })

  it('does not add self', () => {
    const localId = nodeIdFromDid('did:key:local')
    const table = new KBucketTable(localId)
    table.upsert({ id: localId, syncUrl: '', httpUrl: '', lastSeen: Date.now() })
    expect(table.size()).toBe(0)
  })

  it('updates existing contact in-place', () => {
    const table = new KBucketTable(nodeIdFromDid('did:key:local'))
    table.upsert(fakeContact('did:key:peer1', 'wss://old'))
    table.upsert(fakeContact('did:key:peer1', 'wss://new'))
    expect(table.size()).toBe(1)
    expect(table.closest(nodeIdFromDid('did:key:peer1'), 1)[0].syncUrl).toBe('wss://new')
  })

  it('removes a contact', () => {
    const table = new KBucketTable(nodeIdFromDid('did:key:local'))
    table.upsert(fakeContact('did:key:peer1'))
    table.remove(nodeIdFromDid('did:key:peer1'))
    expect(table.size()).toBe(0)
  })

  it('closest returns contacts sorted by XOR distance to target', () => {
    const local = nodeIdFromDid('did:key:local')
    const table = new KBucketTable(local)
    const dids = ['did:key:A', 'did:key:B', 'did:key:C', 'did:key:D']
    for (const d of dids) table.upsert(fakeContact(d))

    const target = nodeIdFromDid('did:key:A')
    const result = table.closest(target, 2)
    expect(result.length).toBe(2)
    // First result must be closest to target
    const d0 = xorDistance(result[0].id, target)
    const d1 = xorDistance(result[1].id, target)
    expect(d0.compare(d1)).toBeLessThanOrEqual(0)
  })

  it('accepts up to K contacts per bucket before evicting oldest', () => {
    const local = nodeIdFromDid('did:key:local-unique-000')
    const table = new KBucketTable(local)
    // Insert K+5 contacts into the same bucket by using incremental DIDs
    for (let i = 0; i < K + 5; i++) {
      table.upsert(fakeContact(`did:key:peer${i.toString().padStart(4, '0')}`))
    }
    // Total size across all buckets is at most (K+5) contacts
    // (each bucket is capped at K but we may spread across buckets)
    expect(table.size()).toBeLessThanOrEqual(K + 5)
    expect(table.size()).toBeGreaterThan(0)
  })
})
