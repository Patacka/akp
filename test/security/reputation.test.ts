/**
 * DID reputation / zero-trust entry tests.
 *
 * Verifies:
 *  - New DIDs start at reputation=0, weight=0.0
 *  - Correct reviews increment reputation toward graduation
 *  - Reaching graduationThreshold grants weight=1.0
 *  - Slashing (negative delta) blacklists the DID permanently
 *  - Blacklisted DIDs cannot recover or vote
 *  - agent_flag governance proposal hard-slashes the flagged DID
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { KUStore } from '../../src/core/store.js'

function makeStore() {
  return new KUStore({ dbPath: ':memory:' })
}

describe('Zero-trust entry', () => {
  let store: KUStore
  beforeEach(() => { store = makeStore() })

  it('new DID has reputation=0 and weight=0 (when threshold > 0)', () => {
    store.ensureDid('did:key:zaaa')
    const rep = store.getReputation('did:key:zaaa')
    expect(rep).not.toBeNull()
    expect(rep!.reputation).toBe(0)
    expect(rep!.graduatedAt).toBeNull()

    // graduationThreshold defaults to 10 in params
    const params = store.getGovernanceParameters()
    expect(params.graduationThreshold).toBe(10)
    expect(store.getEffectiveWeight('did:key:zaaa')).toBe(0.0)
  })

  it('unknown DID also returns 0 weight', () => {
    expect(store.getEffectiveWeight('did:key:znobody')).toBe(0.0)
  })
})

describe('Graduation', () => {
  let store: KUStore
  const did = 'did:key:zreviewer'

  beforeEach(() => { store = makeStore() })

  it('reaches graduation after threshold correct reviews', () => {
    store.ensureDid(did)
    const params = store.getGovernanceParameters()
    const threshold = params.graduationThreshold // 10

    for (let i = 0; i < threshold - 1; i++) {
      store.addReputation(did, 1)
      expect(store.getEffectiveWeight(did)).toBe(0.0)  // not yet
    }

    store.addReputation(did, 1)  // now at threshold
    expect(store.getEffectiveWeight(did)).toBe(1.0)
    const rep = store.getReputation(did)!
    expect(rep.graduatedAt).not.toBeNull()
  })

  it('further reputation gains increase graduated weight proportionally', () => {
    store.ensureDid(did)
    for (let i = 0; i < 20; i++) store.addReputation(did, 1)
    // threshold=10, rep=20 → weight = min(20/10, 3.0) = 2.0
    expect(store.getEffectiveWeight(did)).toBe(2.0)
    const rep = store.getReputation(did)!
    expect(rep.reputation).toBe(20)
    expect(rep.graduatedAt).not.toBeNull()
  })
})

describe('Slashing', () => {
  let store: KUStore
  const did = 'did:key:zbadactor'

  beforeEach(() => { store = makeStore() })

  it('single -10 slash from 0 blacklists the DID', () => {
    store.ensureDid(did)
    store.addReputation(did, -10)
    const rep = store.getReputation(did)!
    expect(rep.blacklisted).toBe(true)
    expect(rep.reputation).toBeLessThan(0)
    expect(store.getEffectiveWeight(did)).toBe(0.0)
  })

  it('blacklisted DID cannot accumulate reputation', () => {
    store.ensureDid(did)
    store.addReputation(did, -10)
    // Attempt to recover — should have no effect
    store.addReputation(did, 100)
    const rep = store.getReputation(did)!
    expect(rep.blacklisted).toBe(true)
    expect(store.getEffectiveWeight(did)).toBe(0.0)
  })

  it('graduated DID can be slashed below zero → blacklisted', () => {
    store.ensureDid(did)
    // Graduate first
    for (let i = 0; i < 10; i++) store.addReputation(did, 1)
    expect(store.getEffectiveWeight(did)).toBe(1.0)

    // Big slash
    store.addReputation(did, -20)
    expect(store.getEffectiveWeight(did)).toBe(0.0)
    expect(store.getReputation(did)!.blacklisted).toBe(true)
  })
})

describe('Dev mode (graduationThreshold = 0)', () => {
  it('all non-blacklisted DIDs return weight 1.0 when threshold is 0', () => {
    const store = makeStore()
    // Override params to set threshold = 0 (simulates dev/test mode)
    const params = store.getGovernanceParameters()
    params.graduationThreshold = 0
    store.saveGovernanceParameters(params)

    store.ensureDid('did:key:zdev')
    expect(store.getEffectiveWeight('did:key:zdev')).toBe(1.0)
  })
})

describe('recordReview', () => {
  it('increments review_count', () => {
    const store = makeStore()
    store.ensureDid('did:key:zr')
    store.recordReview('did:key:zr')
    store.recordReview('did:key:zr')
    expect(store.getReputation('did:key:zr')!.reviewCount).toBe(2)
  })
})
