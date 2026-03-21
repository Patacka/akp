import { describe, it, expect } from 'vitest'
import { vrfProve, vrfVerify, selectAgents } from '../../src/core/vrf.js'
import { generateIdentity } from '../../src/core/identity.js'

describe('VRF', () => {
  it('proves and verifies', async () => {
    const identity = await generateIdentity()
    const output = await vrfProve(identity.privateKeyHex, 'test-input')
    expect(output.hash).toBeTruthy()
    expect(output.proof).toBeTruthy()
    const valid = await vrfVerify(identity.publicKeyHex, 'test-input', output)
    expect(valid).toBe(true)
  })

  it('rejects wrong input', async () => {
    const identity = await generateIdentity()
    const output = await vrfProve(identity.privateKeyHex, 'input-a')
    const valid = await vrfVerify(identity.publicKeyHex, 'input-b', output)
    expect(valid).toBe(false)
  })

  it('is deterministic for same key+input', async () => {
    const identity = await generateIdentity()
    const out1 = await vrfProve(identity.privateKeyHex, 'same-input')
    const out2 = await vrfProve(identity.privateKeyHex, 'same-input')
    expect(out1.hash).toBe(out2.hash)
  })
})

describe('selectAgents', () => {
  it('selects N agents from pool', () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({
      did: `did:key:agent${i}`,
      publicKeyHex: i.toString(16).padStart(64, '0'),
    }))
    const selected = selectAgents(pool, 'seed-123', 3)
    expect(selected).toHaveLength(3)
  })

  it('returns full pool if N >= pool size', () => {
    const pool = [
      { did: 'did:key:a', publicKeyHex: 'aa'.repeat(32) },
      { did: 'did:key:b', publicKeyHex: 'bb'.repeat(32) },
    ]
    const selected = selectAgents(pool, 'seed', 10)
    expect(selected).toHaveLength(2)
  })

  it('is deterministic for same seed', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({
      did: `did:key:agent${i}`,
      publicKeyHex: i.toString(16).padStart(64, '0'),
    }))
    const s1 = selectAgents(pool, 'fixed-seed', 5).map(a => a.did)
    const s2 = selectAgents(pool, 'fixed-seed', 5).map(a => a.did)
    expect(s1).toEqual(s2)
  })

  it('different seeds produce different selections', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({
      did: `did:key:agent${i}`,
      publicKeyHex: i.toString(16).padStart(64, '0'),
    }))
    const s1 = selectAgents(pool, 'seed-aaa', 5).map(a => a.did)
    const s2 = selectAgents(pool, 'seed-zzz', 5).map(a => a.did)
    expect(s1).not.toEqual(s2)
  })
})
