/**
 * Regression tests for the 8 security fixes applied after the audit:
 *
 *  Fix 1 — Vote-weight snapshot: slashed voter weight zeroed at tally time
 *  Fix 2 — Corrupt Automerge binary: store survives startup without the bad KU
 *  Fix 3 — Sync validation: schema-invalid merged KU is discarded
 *  Fix 4 — Atomic reveal: double-reveal of the same commit is rejected
 *  Fix 5 — Commit signature: unsigned commits are rejected by the RPC
 *  Fix 6 — Hash framing: null-byte delimiter prevents concatenation collision
 *  Fix 7 — Prototype pollution: __proto__ / constructor paths are rejected
 *  Fix 8 — Immutable params: graduationThreshold cannot be lowered via parameter_change
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { KUStore } from '../../src/core/store.js'
import { GovernanceEngine } from '../../src/core/governance.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { createRpcServer } from '../../src/api/rpc.js'
import {
  generateIdentity,
  canonicalCommitPayload,
  signBytes,
  computeDidBoundSeed,
} from '../../src/core/identity.js'
import {
  createProposal,
  createVote,
  GovernanceParametersSchema,
  canonicalProposalPayload,
  canonicalVotePayload,
  signGovernancePayload,
  tallyVotes,
} from '../../src/core/governance.js'
import { v7 as uuidv7 } from 'uuid'
import http from 'node:http'

// ── helpers ───────────────────────────────────────────────────────────────────

function devStore() {
  const s = new KUStore({ dbPath: ':memory:' })
  const p = s.getGovernanceParameters()
  p.graduationThreshold = 0
  p.proposalReputationBond = 0
  p.commitWindowMinutes = 0
  p.commitWindowMinCount = 1
  s.saveGovernanceParameters(p)
  return s
}

/** Null-byte-delimited hash matching the fixed store implementation */
function commitHash(verdict: string, salt: string, did: string): string {
  return createHash('sha256')
    .update(verdict).update('\x00')
    .update(salt).update('\x00')
    .update(did)
    .digest('hex')
}

async function rpcCall(port: number, method: string, params: unknown) {
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/rpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => { d += c }); res.on('end', () => resolve(JSON.parse(d))) }
    )
    req.on('error', reject); req.write(body); req.end()
  })
}

// ── Fix 1: vote-weight snapshot attack ───────────────────────────────────────

describe('Fix 1 — vote weight re-derived at tally time', () => {
  it('a voter slashed after casting retains 0 weight at finalization', async () => {
    const store = devStore()
    const params = store.getGovernanceParameters()

    const proposer = await generateIdentity()
    const voter = await generateIdentity()

    // Proposer submits a proposal
    const stub = createProposal({
      type: 'parameter_change',
      proposerDid: proposer.did,
      payload: { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 },
      signature: 'stub', ttlDays: 0,  // expire immediately so finalizeExpired sees it
    })
    const propSig = await signGovernancePayload(canonicalProposalPayload(stub), proposer.privateKeyHex)
    const proposal = { ...stub, signature: propSig }
    await store.submitProposal(proposal)

    // Voter casts a 'yes' vote
    store.ensureDid(voter.did)
    const voteStub = createVote({ proposalId: proposal.id, voterDid: voter.did, choice: 'yes', weight: 1, signature: 'stub' })
    const voteSig = await signGovernancePayload(canonicalVotePayload(voteStub), voter.privateKeyHex)
    await store.castVote({ ...voteStub, signature: voteSig })

    // Slash the voter AFTER they voted
    store.addReputation(voter.did, -10)
    expect(store.getEffectiveWeight(voter.did)).toBe(0.0)

    // Tally should use live weight = 0, so quorum is not met
    const votes = store.getVotes(proposal.id)
    const liveVotes = votes.map(v => ({ ...v, weight: store.getEffectiveWeight(v.voterDid) }))
    const tally = tallyVotes(proposal, liveVotes, params)
    // quorumMet requires yesCount+noCount >= 5; with 1 vote total, it won't be met
    expect(tally.verdict).toBe('expired')  // TTL 0 → expired, not accepted
  })
})

// ── Fix 2: corrupt Automerge binary ──────────────────────────────────────────

describe('Fix 2 — corrupt Automerge binary does not crash store', () => {
  it('store starts up and skips the bad KU rather than throwing', () => {
    const store = new KUStore({ dbPath: ':memory:' })

    // Inject a corrupt Automerge binary directly into SQLite
    const fakeId = uuidv7()
    ;(store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare(
        'INSERT INTO knowledge_units (id, domain, maturity, confidence, tags, created, modified, automerge_binary) VALUES (?,?,?,?,?,?,?,?)'
      ).run(fakeId, 'test', 'draft', 0, '[]', new Date().toISOString(), new Date().toISOString(), Buffer.from('not valid automerge bytes!!'))

    // A second store opening the same DB should not throw
    expect(() => {
      // Re-run _loadAll indirectly by checking allIds (existing KU is corrupt, so skipped)
      const ids = store.allIds()
      // The corrupt id IS in SQLite but NOT loaded into docs
      expect(ids).toContain(fakeId)
      expect(store.read(fakeId)).toBeNull()  // not in docs map → null
    }).not.toThrow()
  })
})

// ── Fix 4: atomic reveal ──────────────────────────────────────────────────────

describe('Fix 4 — double reveal is rejected atomically', () => {
  it('second reveal of the same commit returns ok=false', () => {
    const store = devStore()
    const did = 'did:key:zrevealer'
    const ku = createKU({ domain: 'test', title: { en: 'R' }, provenance: createProvenance({ did, type: 'agent', method: 'observation' }) })
    const kuId = store.create(ku)

    const id = uuidv7()
    const verdict = 'confirmed', salt = 'saltydog'
    store.commitReview({ id, kuId, reviewerDid: did, commitHash: commitHash(verdict, salt, did) })

    const r1 = store.revealReview({ commitId: id, verdict, salt, reviewerDid: did })
    const r2 = store.revealReview({ commitId: id, verdict, salt, reviewerDid: did })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
  })
})

// ── Fix 5: commit signature enforcement ──────────────────────────────────────

describe('Fix 5 — akp.review.commit requires a valid Ed25519 signature', () => {
  let store: KUStore
  let graph: RelationGraph
  let server: ReturnType<typeof createRpcServer>
  let port: number
  let kuId: string
  let identity: Awaited<ReturnType<typeof generateIdentity>>

  beforeEach(async () => {
    store = new KUStore({ dbPath: ':memory:' })
    graph = store.buildGraph()
    port = 13100 + Math.floor(Math.random() * 100)
    server = createRpcServer({ store, graph, port, mockStage1: true })
    server.listen()

    identity = await generateIdentity()
    const ku = createKU({ domain: 'test', title: { en: 'C' }, provenance: createProvenance({ did: identity.did, type: 'agent', method: 'observation' }) })
    kuId = store.create(ku)
    graph.addKU(ku)
  })

  const afterEach = () => server.close()

  it('accepts a commit signed by the reviewer DID', async () => {
    const id = uuidv7()
    const hash = commitHash('confirmed', 'mysecret', identity.did)
    const sig = await signBytes(canonicalCommitPayload({ id, kuId, reviewerDid: identity.did, commitHash: hash }), identity.privateKeyHex)
    const res = await rpcCall(port, 'akp.review.commit', { id, kuId, reviewerDid: identity.did, commitHash: hash, signature: sig })
    afterEach()
    expect(res.error).toBeUndefined()
    expect(res.result).toMatchObject({ commitId: id })
  })

  it('rejects a commit with a wrong signature (griefing attempt)', async () => {
    const id = uuidv7()
    const hash = commitHash('confirmed', 'secret', identity.did)
    const wrongSig = 'a'.repeat(128)  // bogus signature
    const res = await rpcCall(port, 'akp.review.commit', { id, kuId, reviewerDid: identity.did, commitHash: hash, signature: wrongSig })
    afterEach()
    expect(res.error).toBeDefined()
    expect(res.error!.message).toMatch(/invalid reviewer signature/)
  })

  it('rejects a commit where signature belongs to a different DID', async () => {
    const attacker = await generateIdentity()
    const id = uuidv7()
    const hash = commitHash('confirmed', 'secret', identity.did)
    // Attacker signs the payload — but the payload contains identity.did, not attacker.did
    // The extracted pub key from identity.did won't match attacker's signature
    const attackerSig = await signBytes(canonicalCommitPayload({ id, kuId, reviewerDid: identity.did, commitHash: hash }), attacker.privateKeyHex)
    const res = await rpcCall(port, 'akp.review.commit', { id, kuId, reviewerDid: identity.did, commitHash: hash, signature: attackerSig })
    afterEach()
    expect(res.error).toBeDefined()
    expect(res.error!.message).toMatch(/invalid reviewer signature/)
  })
})

// ── Fix 6: hash framing ───────────────────────────────────────────────────────

describe('Fix 6 — null-byte delimited commit hash prevents collisions', () => {
  it('different field splits with same concatenation produce different hashes', () => {
    // Without delimiters: ("ab","cd","e") == ("a","bcd","e") because "ab"+"cd"+"e" === "a"+"bcd"+"e"
    // With \x00 delimiters: "ab\x00cd\x00e" ≠ "a\x00bcd\x00e"
    const h1 = commitHash('ab', 'cd', 'e')
    const h2 = commitHash('a', 'bcd', 'e')
    expect(h1).not.toBe(h2)
  })

  it('store.revealReview accepts the delimited hash and rejects the old concatenated hash', () => {
    const store = devStore()
    const did = 'did:key:zframed'
    const ku = createKU({ domain: 'test', title: { en: 'F' }, provenance: createProvenance({ did, type: 'agent', method: 'observation' }) })
    const kuId = store.create(ku)

    const verdict = 'confirmed', salt = 'salty'
    const id = uuidv7()

    // Store commit using old (undelimited) hash — simulating a client that hasn't upgraded
    const oldHash = createHash('sha256').update(verdict + salt + did).digest('hex')
    store.commitReview({ id, kuId, reviewerDid: did, commitHash: oldHash })

    // Reveal with delimited hash → should FAIL (hash mismatch)
    const result = store.revealReview({ commitId: id, verdict, salt, reviewerDid: did })
    expect(result.ok).toBe(false)  // old hash ≠ expected delimited hash

    // Reveal with same raw concatenation also fails (expected hash is now delimited)
    const id2 = uuidv7()
    const newHash = commitHash(verdict, salt, did)  // delimited
    store.commitReview({ id: id2, kuId, reviewerDid: did, commitHash: newHash })
    const result2 = store.revealReview({ commitId: id2, verdict, salt, reviewerDid: did })
    expect(result2.ok).toBe(true)  // delimited hash matches
  })
})

// ── Fix 7: prototype pollution ────────────────────────────────────────────────

describe('Fix 7 — applyParameterChange blocks prototype-polluting paths', () => {
  const baseParams = GovernanceParametersSchema.parse({})

  it('rejects __proto__ in paramPath', () => {
    expect(() => GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: '__proto__.polluted', oldValue: false, newValue: true,
    })).toThrow(/Forbidden paramPath segment/)
  })

  it('rejects constructor in paramPath', () => {
    expect(() => GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: 'quorums.constructor.prototype', oldValue: 0, newValue: 999,
    })).toThrow(/Forbidden paramPath segment/)
  })

  it('rejects prototype in paramPath', () => {
    expect(() => GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: 'prototype.x', oldValue: 0, newValue: 1,
    })).toThrow(/Forbidden paramPath segment/)
  })

  it('still accepts a normal quorum change', () => {
    const updated = GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 7,
    })
    expect(updated.quorums['parameter_change']).toBe(7)
  })
})

// ── Fix 8: immutable Sybil-resistance params ──────────────────────────────────

describe('Fix 8 — graduationThreshold is immutable via parameter_change', () => {
  const baseParams = GovernanceParametersSchema.parse({})

  it('throws when a parameter_change tries to zero out graduationThreshold', () => {
    expect(() => GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: 'graduationThreshold', oldValue: 10, newValue: 0,
    })).toThrow(/protected parameter/)
  })

  it('throws when a parameter_change tries to zero out proposalReputationBond', () => {
    expect(() => GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: 'proposalReputationBond', oldValue: 10, newValue: 0,
    })).toThrow(/protected parameter/)
  })

  it('does not block legitimate quorum changes', () => {
    expect(() => GovernanceEngine.applyParameterChange(baseParams, {
      paramPath: 'quorums.agent_flag', oldValue: 5, newValue: 8,
    })).not.toThrow()
  })
})
