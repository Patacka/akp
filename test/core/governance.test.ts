import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, mkdirSync } from 'fs'
import {
  createProposal,
  createVote,
  createDefaultGovernanceState,
  tallyVotes,
  GovernanceEngine,
  GovernanceParametersSchema,
  canonicalProposalPayload,
  canonicalVotePayload,
  checkProposerEligibility,
  checkVoterEligibility,
  signGovernancePayload,
  type Proposal,
  type Vote,
  type GovernanceParameters,
} from '../../src/core/governance.js'
import { generateIdentity, type Identity } from '../../src/core/identity.js'
import { KUStore } from '../../src/core/store.js'
import { createKU, createProvenance } from '../../src/core/ku.js'

// ── Identity helpers ──────────────────────────────────────────────────────────

// Pre-generated test identities (created once per module, shared across tests)
// We use `generateIdentity()` in beforeAll-style iife because Vitest doesn't
// allow top-level await in commonjs-compiled output. Instead we generate lazily.
let _identities: Identity[] | null = null
async function getIdentities(n: number): Promise<Identity[]> {
  if (!_identities || _identities.length < n) {
    _identities = await Promise.all(Array.from({ length: n }, () => generateIdentity()))
  }
  return _identities.slice(0, n)
}

/** Sign and create a proposal using a real Ed25519 identity. */
async function signedProposal(
  identity: Identity,
  type: Proposal['type'],
  payload: Proposal['payload'],
  ttlDays = 7
): Promise<Proposal> {
  // Build a stub so we can compute canonical bytes
  const stub = createProposal({ type, proposerDid: identity.did, payload, signature: 'stub', ttlDays })
  const canonical = canonicalProposalPayload(stub)
  const signature = await signGovernancePayload(canonical, identity.privateKeyHex)
  return { ...stub, signature }
}

/** Sign and create a vote using a real Ed25519 identity. */
async function signedYesVote(identity: Identity, proposalId: string, weight = 1): Promise<Vote> {
  const stub = createVote({ proposalId, voterDid: identity.did, choice: 'yes', weight, signature: 'stub' })
  const canonical = canonicalVotePayload(stub)
  const signature = await signGovernancePayload(canonical, identity.privateKeyHex)
  return { ...stub, signature }
}

// ── Fixtures (for pure unit tests that don't hit the store) ──────────────────

const DUMMY_SIG = 'a'.repeat(128)
const FAKE_PROPOSER = 'did:key:proposer'
const VOTER_A = 'did:key:voter-a'
const VOTER_B = 'did:key:voter-b'
const VOTER_C = 'did:key:voter-c'
const VOTER_D = 'did:key:voter-d'
const VOTER_E = 'did:key:voter-e'

function defaultParams(): GovernanceParameters {
  return GovernanceParametersSchema.parse({})
}

function openProposal(type: Proposal['type'] = 'parameter_change', ttlDays = 7): Proposal {
  return createProposal({
    type,
    proposerDid: FAKE_PROPOSER,
    payload: { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 },
    signature: DUMMY_SIG,
    ttlDays,
  })
}

function yesVote(proposalId: string, voterDid: string, weight = 1): Vote {
  return createVote({ proposalId, voterDid, choice: 'yes', weight, signature: DUMMY_SIG })
}

function noVote(proposalId: string, voterDid: string, weight = 1): Vote {
  return createVote({ proposalId, voterDid, choice: 'no', weight, signature: DUMMY_SIG })
}

// ── canonical serializers ─────────────────────────────────────────────────────

describe('canonicalProposalPayload', () => {
  it('produces deterministic bytes for same input', () => {
    const p = openProposal()
    const a = canonicalProposalPayload(p)
    const b = canonicalProposalPayload(p)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('does not include status field', () => {
    const p = openProposal()
    const bytes = canonicalProposalPayload(p)
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain('"status"')
  })

  it('includes all required fields', () => {
    const p = openProposal()
    const text = new TextDecoder().decode(canonicalProposalPayload(p))
    expect(text).toContain('"id"')
    expect(text).toContain('"type"')
    expect(text).toContain('"proposerDid"')
    expect(text).toContain('"payload"')
    expect(text).toContain('"createdAt"')
    expect(text).toContain('"expiresAt"')
  })
})

describe('canonicalVotePayload', () => {
  it('produces deterministic bytes', () => {
    const p = openProposal()
    const v = yesVote(p.id, VOTER_A)
    const a = canonicalVotePayload(v)
    const b = canonicalVotePayload(v)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })
})

// ── eligibility ───────────────────────────────────────────────────────────────

describe('checkProposerEligibility', () => {
  it('allows normal agents', () => {
    const r = checkProposerEligibility(FAKE_PROPOSER, defaultParams())
    expect(r.eligible).toBe(true)
  })

  it('blocks blacklisted agents', () => {
    const params = defaultParams()
    params.blacklistedAgents.push(FAKE_PROPOSER)
    const r = checkProposerEligibility(FAKE_PROPOSER, params)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/blacklisted/)
  })

  it('blocks suspended agents', () => {
    const params = defaultParams()
    params.suspendedAgents.push(FAKE_PROPOSER)
    const r = checkProposerEligibility(FAKE_PROPOSER, params)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/suspended/)
  })
})

describe('checkVoterEligibility', () => {
  it('allows a fresh voter on an open proposal', () => {
    const p = openProposal()
    const r = checkVoterEligibility(VOTER_A, p, [], defaultParams())
    expect(r.eligible).toBe(true)
  })

  it('blocks double-voting', () => {
    const p = openProposal()
    const v = yesVote(p.id, VOTER_A)
    const r = checkVoterEligibility(VOTER_A, p, [v], defaultParams())
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/Already voted/)
  })

  it('blocks vote on non-open proposal', () => {
    const p = { ...openProposal(), status: 'accepted' as const }
    const r = checkVoterEligibility(VOTER_A, p, [], defaultParams())
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/accepted/)
  })

  it('blocks vote on expired proposal', () => {
    const p = createProposal({ type: 'parameter_change', proposerDid: FAKE_PROPOSER,
      payload: { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 },
      signature: DUMMY_SIG, ttlDays: -1 })
    const r = checkVoterEligibility(VOTER_A, p, [], defaultParams())
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/expired/)
  })
})

// ── tallyVotes ────────────────────────────────────────────────────────────────

describe('tallyVotes', () => {
  it('returns pending when quorum not met', () => {
    const p = openProposal()
    const votes = [yesVote(p.id, VOTER_A), yesVote(p.id, VOTER_B)]
    const r = tallyVotes(p, votes, defaultParams())
    expect(r.verdict).toBe('pending')
  })

  it('accepts when quorum met and threshold exceeded', () => {
    const p = openProposal()
    const votes = [
      yesVote(p.id, VOTER_A), yesVote(p.id, VOTER_B), yesVote(p.id, VOTER_C),
      yesVote(p.id, VOTER_D), yesVote(p.id, VOTER_E),
    ]
    const r = tallyVotes(p, votes, defaultParams())
    expect(r.verdict).toBe('accepted')
    expect(r.yesCount).toBe(5)
    expect(r.achievedRatio).toBeCloseTo(1.0)
  })

  it('rejects when quorum met but threshold not achievable', () => {
    const p = openProposal()
    const votes = [
      yesVote(p.id, VOTER_A), yesVote(p.id, VOTER_B),
      noVote(p.id, VOTER_C), noVote(p.id, VOTER_D), noVote(p.id, VOTER_E),
    ]
    const r = tallyVotes(p, votes, defaultParams())
    expect(r.verdict).toBe('rejected')
    expect(r.achievedRatio).toBeCloseTo(2 / 5)
  })

  it('expires when TTL elapsed and quorum never met', () => {
    const p = createProposal({ type: 'parameter_change', proposerDid: FAKE_PROPOSER,
      payload: { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 },
      signature: DUMMY_SIG, ttlDays: -1 })
    const r = tallyVotes(p, [], defaultParams())
    expect(r.verdict).toBe('expired')
  })

  it('abstains do not count toward quorum or ratio', () => {
    const p = openProposal()
    const votes = [
      yesVote(p.id, VOTER_A), yesVote(p.id, VOTER_B), yesVote(p.id, VOTER_C),
      yesVote(p.id, VOTER_D), yesVote(p.id, VOTER_E),
      createVote({ proposalId: p.id, voterDid: 'did:key:abstainer', choice: 'abstain', signature: DUMMY_SIG }),
    ]
    const r = tallyVotes(p, votes, defaultParams())
    expect(r.verdict).toBe('accepted')
    expect(r.abstainCount).toBe(1)
    expect(r.achievedRatio).toBeCloseTo(1.0)
  })

  it('uses quorum/threshold from params for rule_change type', () => {
    const p = createProposal({ type: 'rule_change', proposerDid: FAKE_PROPOSER,
      payload: { action: 'remove', ruleId: 'lifecycle' },
      signature: DUMMY_SIG })
    const votes = [
      yesVote(p.id, VOTER_A), yesVote(p.id, VOTER_B), yesVote(p.id, VOTER_C),
      yesVote(p.id, VOTER_D), yesVote(p.id, VOTER_E),
    ]
    const r = tallyVotes(p, votes, defaultParams())
    expect(r.verdict).toBe('pending')
    expect(r.quorumMet).toBe(false)
  })

  it('uses separate thresholds for promote vs demote', () => {
    const promote = createProposal({ type: 'maturity_override', proposerDid: FAKE_PROPOSER,
      payload: { kuId: '00000000-0000-0000-0000-000000000001', direction: 'promote', targetMaturity: 'stable', reason: 'test' },
      signature: DUMMY_SIG })
    const votes3 = [yesVote(promote.id, VOTER_A), yesVote(promote.id, VOTER_B), yesVote(promote.id, VOTER_C)]
    const r = tallyVotes(promote, votes3, defaultParams())
    expect(r.verdict).toBe('accepted')
    expect(r.quorumMet).toBe(true)
  })
})

// ── GovernanceEngine.applyParameterChange ─────────────────────────────────────

describe('GovernanceEngine.applyParameterChange', () => {
  it('updates a nested numeric field via dot-path', () => {
    const params = defaultParams()
    const updated = GovernanceEngine.applyParameterChange(params, {
      paramPath: 'quorums.parameter_change',
      oldValue: 5,
      newValue: 8,
    })
    expect(updated.quorums['parameter_change']).toBe(8)
    expect(params.quorums['parameter_change']).toBe(5)
  })

  it('throws for invalid dot-path', () => {
    const params = defaultParams()
    expect(() =>
      GovernanceEngine.applyParameterChange(params, {
        paramPath: 'nonexistent.deep.path',
        oldValue: 1,
        newValue: 2,
      })
    ).toThrow()
  })
})

// ── createDefaultGovernanceState ──────────────────────────────────────────────

describe('createDefaultGovernanceState', () => {
  it('has empty proposals, outcomes, overrides', () => {
    const state = createDefaultGovernanceState()
    expect(state.openProposals).toHaveLength(0)
    expect(state.outcomes).toHaveLength(0)
    expect(state.maturityOverrides).toEqual({})
  })

  it('contains sensible default parameters', () => {
    const state = createDefaultGovernanceState()
    expect(state.parameters.quorums['parameter_change']).toBe(5)
    expect(state.parameters.thresholds['rule_change']).toBeCloseTo(0.67)
  })
})

// ── KUStore governance integration (requires real signatures) ─────────────────

let tmpDir: string
let store: KUStore

beforeEach(() => {
  tmpDir = join(tmpdir(), `gov-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  store = new KUStore({ dbPath: join(tmpDir, 'test.db') })
  // Dev mode: graduationThreshold=0 gives all non-blacklisted DIDs full weight
  const params = store.getGovernanceParameters()
  params.graduationThreshold = 0
  params.proposalReputationBond = 0
  store.saveGovernanceParameters(params)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('KUStore.submitProposal + castVote (real signatures)', () => {
  it('rejects proposals with invalid/dummy signatures', async () => {
    const p = openProposal()  // uses FAKE_PROPOSER + DUMMY_SIG — sig won't verify
    expect(await store.submitProposal(p)).toBe(false)
  })

  it('accepts a properly signed proposal', async () => {
    const [proposer] = await getIdentities(1)
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 })
    expect(await store.submitProposal(p)).toBe(true)
    const open = store.getProposals('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(p.id)
  })

  it('rejects duplicate proposal ids', async () => {
    const [proposer] = await getIdentities(1)
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 })
    await store.submitProposal(p)
    expect(await store.submitProposal(p)).toBe(false)
  })

  it('accepts properly signed votes', async () => {
    const [proposer, voterA] = await getIdentities(2)
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 })
    await store.submitProposal(p)

    const v = await signedYesVote(voterA, p.id)
    expect(await store.castVote(v)).toBe(true)
    const votes = store.getVotes(p.id)
    expect(votes).toHaveLength(1)
    expect(votes[0].voterDid).toBe(voterA.did)
  })

  it('rejects votes with invalid signatures', async () => {
    const [proposer, voterA] = await getIdentities(2)
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 })
    await store.submitProposal(p)

    // Vote signed by voterA but claiming to be voterA DID — but tampered signature
    const stub = createVote({ proposalId: p.id, voterDid: voterA.did, choice: 'yes', signature: DUMMY_SIG })
    expect(await store.castVote(stub)).toBe(false)
  })

  it('enforces one vote per voter per proposal', async () => {
    const [proposer, voterA] = await getIdentities(2)
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 })
    await store.submitProposal(p)

    const v = await signedYesVote(voterA, p.id)
    await store.castVote(v)

    // Second vote same voter — should fail (duplicate)
    const v2 = await signedYesVote(voterA, p.id)
    expect(await store.castVote(v2)).toBe(false)
  })
})

describe('KUStore.finalizeExpired', () => {
  it('marks accepted proposal and applies parameter change', async () => {
    const identities = await getIdentities(6)  // 1 proposer + 5 voters
    const [proposer, ...voters] = identities
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 6 })
    await store.submitProposal(p)

    for (const v of voters) {
      await store.castVote(await signedYesVote(v, p.id))
    }

    const results = store.finalizeExpired()
    expect(results).toHaveLength(1)
    expect(results[0].verdict).toBe('accepted')

    const closed = store.getProposals('accepted')
    expect(closed).toHaveLength(1)

    const params = store.getGovernanceParameters()
    expect(params.quorums['parameter_change']).toBe(6)
  })

  it('applies maturity override for accepted maturity_override proposal', async () => {
    const identities = await getIdentities(4)  // 1 proposer + 3 voters
    const [proposer, ...voters] = identities

    const prov = createProvenance({ did: proposer.did, type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'science', title: { en: 'Test KU' }, provenance: prov })
    const kuId = store.create(ku)

    const p = await signedProposal(proposer, 'maturity_override',
      { kuId, direction: 'promote', targetMaturity: 'stable', reason: 'governance test' })
    await store.submitProposal(p)

    for (const v of voters) {
      await store.castVote(await signedYesVote(v, p.id))
    }

    store.finalizeExpired()

    const updated = store.read(kuId)
    expect(updated?.meta.maturity).toBe('stable')
  })

  it('suspends agent on accepted agent_flag', async () => {
    const identities = await getIdentities(6)
    const [proposer, ...voters] = identities
    const TARGET = 'did:key:z' + 'bad'.repeat(21)  // valid-ish DID format

    const p = await signedProposal(proposer, 'agent_flag',
      { targetDid: TARGET, reason: 'Sybil', evidence: [] })
    await store.submitProposal(p)

    for (const v of voters) {
      await store.castVote(await signedYesVote(v, p.id))
    }
    store.finalizeExpired()

    const params = store.getGovernanceParameters()
    expect(params.suspendedAgents).toContain(TARGET)
  })
})

describe('KUStore.computeGovernanceState', () => {
  it('returns default state with no proposals', () => {
    const state = store.computeGovernanceState()
    expect(state.openProposals).toHaveLength(0)
    expect(state.outcomes).toHaveLength(0)
  })

  it('reflects open proposals', async () => {
    const [proposer] = await getIdentities(1)
    const p = await signedProposal(proposer, 'parameter_change',
      { paramPath: 'quorums.parameter_change', oldValue: 5, newValue: 7 })
    await store.submitProposal(p)
    const state = store.computeGovernanceState()
    expect(state.openProposals).toHaveLength(1)
  })

  it('reflects maturity overrides in state', async () => {
    const identities = await getIdentities(4)
    const [proposer, ...voters] = identities

    const prov = createProvenance({ did: proposer.did, type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'science', title: { en: 'KU for override' }, provenance: prov })
    const kuId = store.create(ku)

    const p = await signedProposal(proposer, 'maturity_override',
      { kuId, direction: 'promote', targetMaturity: 'validated', reason: 'test' })
    await store.submitProposal(p)

    for (const v of voters) {
      await store.castVote(await signedYesVote(v, p.id))
    }
    store.finalizeExpired()

    const state = store.computeGovernanceState()
    expect(state.maturityOverrides[kuId]).toBe('validated')
  })
})
