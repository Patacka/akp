/**
 * Commit-reveal tests.
 *
 * Verifies:
 *  - Phase 1: valid commits are stored; blacklisted DIDs cannot commit
 *  - Phase 2: reveal window (time AND count) must be open
 *  - Phase 2: hash verification — wrong verdict/salt/DID rejected
 *  - Phase 2: already-revealed commits are idempotent (rejected on second call)
 *  - Reputation: correct verdict vs consensus → +1; wrong → -10 + blacklist
 *  - Sybil cannot copy a verdict because the commit hash binds the reviewer DID
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { KUStore } from '../../src/core/store.js'
import { v7 as uuidv7 } from 'uuid'

function commitHash(verdict: string, salt: string, did: string): string {
  // Fields are null-byte delimited to prevent concatenation collisions:
  // ("confirmed","123","did:...") ≠ ("confirmed123","","did:...")
  return createHash('sha256')
    .update(verdict).update('\x00')
    .update(salt).update('\x00')
    .update(did)
    .digest('hex')
}

function makeStore(commitWindowMinutes = 0, commitWindowMinCount = 1) {
  const store = new KUStore({ dbPath: ':memory:' })
  // Override window params and disable graduation gate for tests
  const params = store.getGovernanceParameters()
  params.commitWindowMinutes = commitWindowMinutes
  params.commitWindowMinCount = commitWindowMinCount
  params.graduationThreshold = 0  // dev mode: all DIDs have full weight
  store.saveGovernanceParameters(params)
  return store
}

const kuId = uuidv7()
const didA = 'did:key:zA'
const didB = 'did:key:zB'
const didC = 'did:key:zC'

describe('Phase 1 — commit', () => {
  let store: KUStore

  beforeEach(() => { store = makeStore() })

  it('accepts a valid commit', () => {
    const ok = store.commitReview({
      id: uuidv7(), kuId, reviewerDid: didA,
      commitHash: commitHash('confirmed', 'salt123', didA),
    })
    expect(ok).toBe(true)
  })

  it('rejects a duplicate commit id', () => {
    const id = uuidv7()
    const h = commitHash('confirmed', 'salt123', didA)
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: h })
    expect(store.commitReview({ id, kuId, reviewerDid: didA, commitHash: h })).toBe(false)
  })

  it('rejects commits from blacklisted DIDs', () => {
    store.ensureDid(didA)
    store.addReputation(didA, -10)  // blacklist
    const ok = store.commitReview({
      id: uuidv7(), kuId, reviewerDid: didA,
      commitHash: commitHash('confirmed', 'abc', didA),
    })
    expect(ok).toBe(false)
  })
})

describe('Phase 2 — reveal window enforcement', () => {
  it('rejects reveal when count condition is not met', () => {
    // Require 3 commits before reveal opens
    const store = makeStore(0, 3)
    const id = uuidv7()
    const verdict = 'confirmed', salt = 'mysalt'
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: commitHash(verdict, salt, didA) })
    // Only 1 commit — window not open
    const result = store.revealReview({ commitId: id, verdict, salt, reviewerDid: didA })
    expect(result.ok).toBe(false)
  })

  it('accepts reveal when both conditions are met', () => {
    const store = makeStore(0, 2)
    const id1 = uuidv7(), id2 = uuidv7()
    const v = 'confirmed', s = 'slt'
    store.commitReview({ id: id1, kuId, reviewerDid: didA, commitHash: commitHash(v, s, didA) })
    store.commitReview({ id: id2, kuId, reviewerDid: didB, commitHash: commitHash(v, s, didB) })
    const result = store.revealReview({ commitId: id1, verdict: v, salt: s, reviewerDid: didA })
    expect(result.ok).toBe(true)
  })
})

describe('Phase 2 — hash verification', () => {
  let store: KUStore

  beforeEach(() => { store = makeStore(0, 1) })

  it('accepts a reveal with the correct hash', () => {
    const id = uuidv7()
    const verdict = 'confirmed', salt = 'correctsalt'
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: commitHash(verdict, salt, didA) })
    expect(store.revealReview({ commitId: id, verdict, salt, reviewerDid: didA }).ok).toBe(true)
  })

  it('rejects a reveal with the wrong verdict', () => {
    const id = uuidv7()
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: commitHash('confirmed', 'salt', didA) })
    expect(store.revealReview({ commitId: id, verdict: 'disputed', salt: 'salt', reviewerDid: didA }).ok).toBe(false)
  })

  it('rejects a reveal with the wrong salt', () => {
    const id = uuidv7()
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: commitHash('confirmed', 'rightsalt', didA) })
    expect(store.revealReview({ commitId: id, verdict: 'confirmed', salt: 'wrongsalt', reviewerDid: didA }).ok).toBe(false)
  })

  it('rejects a reveal for the wrong reviewer DID', () => {
    const id = uuidv7()
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: commitHash('confirmed', 'salt', didA) })
    // didB tries to reveal didA's commit
    expect(store.revealReview({ commitId: id, verdict: 'confirmed', salt: 'salt', reviewerDid: didB }).ok).toBe(false)
  })

  it('rejects a second reveal of the same commit', () => {
    const id = uuidv7()
    store.commitReview({ id, kuId, reviewerDid: didA, commitHash: commitHash('confirmed', 's', didA) })
    expect(store.revealReview({ commitId: id, verdict: 'confirmed', salt: 's', reviewerDid: didA }).ok).toBe(true)
    expect(store.revealReview({ commitId: id, verdict: 'confirmed', salt: 's', reviewerDid: didA }).ok).toBe(false)
  })
})

describe('Sybil cannot copy-reveal', () => {
  it('a Sybil committing after seeing the honest commitment cannot derive the hash', () => {
    const store = makeStore(0, 2)
    // Honest reviewer commits 'confirmed'
    const honestVerdict = 'confirmed', honestSalt = 'unique-secret-salt-abc'
    const honestHash = commitHash(honestVerdict, honestSalt, didA)

    store.commitReview({ id: uuidv7(), kuId, reviewerDid: didA, commitHash: honestHash })

    // Sybil sees the hash but cannot reverse it to get the verdict+salt
    // They must commit their own hash — but they don't know the verdict yet
    const sybilGuessHash = commitHash('confirmed', 'guessed-salt', didB)
    const sybilId = uuidv7()
    store.commitReview({ id: sybilId, kuId, reviewerDid: didB, commitHash: sybilGuessHash })

    // Even if Sybil guesses the right verdict, the salt mismatch means the hash is wrong
    // unless they happen to guess both verdict AND salt exactly
    const attempt = store.revealReview({
      commitId: sybilId,
      verdict: 'confirmed',
      salt: 'wrong-salt',  // different salt → hash mismatch
      reviewerDid: didB,
    })
    expect(attempt.ok).toBe(false)
  })
})

describe('Reputation scoring on reveal', () => {
  // Helper: open a fresh store with threshold=0 (dev mode) and the given window config.
  // Registers all three DIDs so they exist in did_reputation.
  function makeRepStore(minCount = 3) {
    const s = makeStore(0, minCount)
    s.ensureDid(didA)
    s.ensureDid(didB)
    s.ensureDid(didC)
    return s
  }

  it('awards +1 when verdict matches the consensus of >= 2 prior revealed reviewers', () => {
    const store = makeRepStore(3)
    const ku2 = uuidv7()

    // All three commit on the same KU
    const idA = uuidv7(), idB = uuidv7(), idC = uuidv7()
    const v = 'confirmed', s = 'salt'
    store.commitReview({ id: idA, kuId: ku2, reviewerDid: didA, commitHash: commitHash(v, s, didA) })
    store.commitReview({ id: idB, kuId: ku2, reviewerDid: didB, commitHash: commitHash(v, s, didB) })
    store.commitReview({ id: idC, kuId: ku2, reviewerDid: didC, commitHash: commitHash(v, s, didC) })

    // A and B reveal first — establishes consensus
    store.revealReview({ commitId: idA, verdict: v, salt: s, reviewerDid: didA })
    store.revealReview({ commitId: idB, verdict: v, salt: s, reviewerDid: didB })

    // C reveals matching consensus → +1
    store.ensureDid(didC)
    const repBefore = store.getReputation(didC)!.reputation
    const result = store.revealReview({ commitId: idC, verdict: v, salt: s, reviewerDid: didC })
    expect(result.ok).toBe(true)
    expect(result.reputationDelta).toBe(1)
    expect(store.getReputation(didC)!.reputation).toBe(repBefore + 1)
  })

  it('slashes -10 when verdict contradicts the consensus of >= 2 prior revealed reviewers', () => {
    const store = makeRepStore(3)
    const ku2 = uuidv7()

    const idA = uuidv7(), idB = uuidv7(), idC = uuidv7()
    store.commitReview({ id: idA, kuId: ku2, reviewerDid: didA, commitHash: commitHash('confirmed', 's', didA) })
    store.commitReview({ id: idB, kuId: ku2, reviewerDid: didB, commitHash: commitHash('confirmed', 's', didB) })
    store.commitReview({ id: idC, kuId: ku2, reviewerDid: didC, commitHash: commitHash('disputed', 's', didC) })

    // Consensus established by A and B
    store.revealReview({ commitId: idA, verdict: 'confirmed', salt: 's', reviewerDid: didA })
    store.revealReview({ commitId: idB, verdict: 'confirmed', salt: 's', reviewerDid: didB })

    // C reveals contradicting verdict → −10, blacklisted
    const repBefore = store.getReputation(didC)!.reputation
    const result = store.revealReview({ commitId: idC, verdict: 'disputed', salt: 's', reviewerDid: didC })
    expect(result.ok).toBe(true)
    expect(result.reputationDelta).toBe(-10)
    expect(store.getReputation(didC)!.reputation).toBe(repBefore - 10)
    expect(store.getReputation(didC)!.blacklisted).toBe(true)
  })

  it('returns reputationDelta=0 when there is no prior consensus (fewer than 2 prior reveals)', () => {
    const store = makeRepStore(2)
    const ku2 = uuidv7()

    const idA = uuidv7(), idB = uuidv7()
    store.commitReview({ id: idA, kuId: ku2, reviewerDid: didA, commitHash: commitHash('confirmed', 's', didA) })
    store.commitReview({ id: idB, kuId: ku2, reviewerDid: didB, commitHash: commitHash('confirmed', 's', didB) })

    // A reveals — only 1 prior reveal, no consensus yet
    const result = store.revealReview({ commitId: idA, verdict: 'confirmed', salt: 's', reviewerDid: didA })
    expect(result.ok).toBe(true)
    expect(result.reputationDelta).toBe(0)  // no consensus reference yet
  })
})
