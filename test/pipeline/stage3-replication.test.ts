/**
 * stage3-replication.test.ts — Unit tests for the replication engine.
 *
 * All tests use MockReplicationAgent or controlled fixtures.
 * No real executables are ever run in this test file.
 */

import { describe, it, expect } from 'vitest'
import {
  createMockReplicationAgent,
  runReplication,
  validateProcedure,
  validateProcedureAsync,
  getVerifiableClaims,
  ReplicationSecurityError,
  ALLOWED_RUNTIMES,
  type MockVerdict,
} from '../../src/pipeline/stage3-replication.js'
import { createKU, createClaim, createProvenance, type VerificationProcedure } from '../../src/core/ku.js'
import { computeMaturityFromReplications } from '../../src/core/confidence.js'
import { generateIdentity, signProcedure } from '../../src/core/identity.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProc(overrides: Partial<VerificationProcedure> = {}): VerificationProcedure {
  return {
    type: 'code',
    runtime: 'node@22',
    executable: 'console.log(JSON.stringify({ verdict: "reproduced", result: 100, deviationPct: 0 }))',
    expectedResult: 100,
    tolerancePct: 5,
    timeoutSeconds: 30,
    seedable: false,
    ...overrides,
  }
}

function makeKUWithProcedure(subject: string, predicate: string, object: unknown) {
  const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain: 'test', title: { en: `${subject} ${predicate}` }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'quantitative',
    subject,
    predicate,
    object,
    confidence: 0.9,
    provenanceRef: prov.id,
    verificationProcedure: makeProc({ entrypoint: `${predicate}.mjs` }),
  }))
  return ku
}

function makeKUWithoutProcedure() {
  const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain: 'test', title: { en: 'no procedure' }, provenance: prov })
  ku.structured.claims.push(createClaim({
    type: 'factual',
    subject: 'sky',
    predicate: 'color',
    object: 'blue',
    confidence: 0.9,
    provenanceRef: prov.id,
  }))
  return ku
}

// ── Security: validateProcedure ───────────────────────────────────────────────

describe('validateProcedure', () => {
  it('accepts a valid procedure', () => {
    expect(() => validateProcedure(makeProc())).not.toThrow()
  })

  it('rejects disallowed runtime', () => {
    expect(() => validateProcedure(makeProc({ runtime: 'ruby@3.2' })))
      .toThrow(ReplicationSecurityError)
  })

  it('rejects executable exceeding 64KB', () => {
    const oversized = 'x'.repeat(65 * 1024)
    expect(() => validateProcedure(makeProc({ executable: oversized })))
      .toThrow(ReplicationSecurityError)
  })

  it('accepts all allowed runtimes', () => {
    for (const runtime of ALLOWED_RUNTIMES) {
      expect(() => validateProcedure(makeProc({ runtime }))).not.toThrow()
    }
  })
})

// ── Ed25519 procedure signing ─────────────────────────────────────────────────

describe('procedure signing', () => {
  it('signProcedure adds authorDid and signature', async () => {
    const identity = await generateIdentity()
    const proc = makeProc()
    const signed = await signProcedure(proc, identity)
    expect(signed.authorDid).toBe(identity.did)
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it('validateProcedureAsync accepts a validly signed procedure', async () => {
    const identity = await generateIdentity()
    const signed = await signProcedure(makeProc(), identity)
    await expect(
      validateProcedureAsync(signed, { requireSignature: true })
    ).resolves.not.toThrow()
  })

  it('validateProcedureAsync rejects unsigned procedure when requireSignature=true', async () => {
    await expect(
      validateProcedureAsync(makeProc(), { requireSignature: true })
    ).rejects.toThrow(ReplicationSecurityError)
  })

  it('validateProcedureAsync rejects tampered executable', async () => {
    const identity = await generateIdentity()
    const signed = await signProcedure(makeProc(), identity)
    const tampered = { ...signed, executable: 'process.exit(1)' }
    await expect(
      validateProcedureAsync(tampered, { requireSignature: true })
    ).rejects.toThrow(ReplicationSecurityError)
  })

  it('validateProcedureAsync rejects wrong DID', async () => {
    const identity1 = await generateIdentity()
    const identity2 = await generateIdentity()
    const signed = await signProcedure(makeProc(), identity1)
    const spoofed = { ...signed, authorDid: identity2.did } // wrong DID with identity1 signature
    await expect(
      validateProcedureAsync(spoofed, { requireSignature: true })
    ).rejects.toThrow(ReplicationSecurityError)
  })

  it('validateProcedure (sync) rejects unsigned when requireSignature=true', () => {
    expect(() => validateProcedure(makeProc(), { requireSignature: true }))
      .toThrow(ReplicationSecurityError)
  })

  it('validateProcedure (sync) accepts unsigned when requireSignature=false', () => {
    expect(() => validateProcedure(makeProc(), { requireSignature: false }))
      .not.toThrow()
  })
})

// ── MockReplicationAgent ──────────────────────────────────────────────────────

describe('MockReplicationAgent', () => {
  it('returns reproduced verdict from registry', async () => {
    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100, deviationPct: 0 })
    const agent = createMockReplicationAgent(
      'did:key:mock1',
      'mock-agent',
      new Map([['boilingPointCelsius.mjs', fn]])
    )
    const proc = makeProc({ entrypoint: 'boilingPointCelsius.mjs' })
    const output = await agent.execute(proc, 'claim-1')
    expect(output.exitCode).toBe(0)
    const parsed = JSON.parse(output.stdout)
    expect(parsed.verdict).toBe('reproduced')
    expect(parsed.result).toBe(100)
  })

  it('returns partial when no registry key matches', async () => {
    const agent = createMockReplicationAgent('did:key:mock2', 'mock', new Map())
    const output = await agent.execute(makeProc(), 'claim-2')
    expect(output.exitCode).toBe(1)
    expect(output.stderr).toContain('No mock registered')
  })

  it('never executes the executable string', async () => {
    // Ensure the executable string content is irrelevant — the mock ignores it
    const malicious = 'process.exit(1); rm -rf /'
    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 42 })
    const agent = createMockReplicationAgent(
      'did:key:mock3',
      'mock',
      new Map([['test.mjs', fn]])
    )
    const proc = makeProc({ executable: malicious, entrypoint: 'test.mjs' })
    const output = await agent.execute(proc, 'claim-3')
    // Should succeed without running the malicious string
    expect(output.exitCode).toBe(0)
    const parsed = JSON.parse(output.stdout)
    expect(parsed.result).toBe(42)
  })
})

// ── runReplication ────────────────────────────────────────────────────────────

describe('runReplication', () => {
  it('skips KUs with no verifiable claims', async () => {
    const ku = makeKUWithoutProcedure()
    const agent = createMockReplicationAgent('did:key:a1', 'mock', new Map())
    const results = await runReplication(ku, [agent])
    expect(results).toHaveLength(0)
  })

  it('appends ReplicationResult to claim.replications', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPointCelsius', 100)
    const claim = ku.structured.claims[0]

    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100, deviationPct: 0 })
    const agent = createMockReplicationAgent(
      'did:key:a2', 'mock',
      new Map([['boilingPointCelsius.mjs', fn]])
    )

    const results = await runReplication(ku, [agent], { requireSignature: false })
    expect(results).toHaveLength(1)
    expect(results[0].reproduced).toBe(1)
    expect(results[0].failed).toBe(0)
    expect(claim.replications).toHaveLength(1)
    expect(claim.replications[0].verdict).toBe('reproduced')
    expect(claim.replications[0].replicatorDid).toBe('did:key:a2')
  })

  it('accumulates results from multiple agents', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPointCelsius', 100)
    const proc = ku.structured.claims[0].verificationProcedure!

    const agents = [0, 1, 2].map(i => {
      const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100, deviationPct: 0 })
      return createMockReplicationAgent(
        `did:key:agent${i}`, `mock${i}`,
        new Map([[proc.entrypoint!, fn]])
      )
    })

    const results = await runReplication(ku, agents, { requireSignature: false })
    expect(results[0].reproduced).toBe(3)
    expect(ku.structured.claims[0].replications).toHaveLength(3)
  })

  it('records failed replication on error', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPointCelsius', 100)
    const proc = ku.structured.claims[0].verificationProcedure!

    // Agent returns non-zero exit
    const fn: MockVerdict = () => ({ verdict: 'failed', result: null })
    const agent = createMockReplicationAgent(
      'did:key:fail', 'fail-mock',
      new Map([[proc.entrypoint!, fn]])
    )

    const results = await runReplication(ku, [agent])
    expect(results[0].failed).toBe(1)
    expect(ku.structured.claims[0].replications[0].verdict).toBe('failed')
  })

  it('respects maxAgents option', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPointCelsius', 100)
    const proc = ku.structured.claims[0].verificationProcedure!

    const agents = [0, 1, 2, 3, 4].map(i => {
      const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100, deviationPct: 0 })
      return createMockReplicationAgent(
        `did:key:m${i}`, `m${i}`,
        new Map([[proc.entrypoint!, fn]])
      )
    })

    const results = await runReplication(ku, agents, { maxAgents: 2, requireSignature: false })
    expect(results[0].reproduced).toBe(2)
  })

  it('rejects unsigned procedure when requireSignature=true', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPointCelsius', 100)
    const proc = ku.structured.claims[0].verificationProcedure!

    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100 })
    const agent = createMockReplicationAgent(
      'did:key:rs', 'mock',
      new Map([[proc.entrypoint!, fn]])
    )

    // Unsigned procedure — should record as failed, not throw at call site
    const results = await runReplication(ku, [agent], { requireSignature: true })
    expect(results[0].failed).toBe(1)
    expect(ku.structured.claims[0].replications[0].verdict).toBe('failed')
  })

  it('accepts signed procedure when requireSignature=true', async () => {
    const identity = await generateIdentity()
    const ku = makeKUWithProcedure('water', 'boilingPointCelsius', 100)
    const claim = ku.structured.claims[0]
    claim.verificationProcedure = await signProcedure(claim.verificationProcedure!, identity)

    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100 })
    const agent = createMockReplicationAgent(
      'did:key:rs2', 'mock',
      new Map([[claim.verificationProcedure.entrypoint!, fn]])
    )

    const results = await runReplication(ku, [agent], { requireSignature: true })
    expect(results[0].reproduced).toBe(1)
  })
})

// ── getVerifiableClaims ───────────────────────────────────────────────────────

describe('getVerifiableClaims', () => {
  it('returns only claims with a VerificationProcedure', () => {
    const prov = createProvenance({ did: 'did:key:t', type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'test', title: { en: 'mixed' }, provenance: prov })

    ku.structured.claims.push(createClaim({
      type: 'factual', subject: 'sky', predicate: 'color', object: 'blue',
      confidence: 0.9, provenanceRef: prov.id,
    }))
    ku.structured.claims.push(createClaim({
      type: 'quantitative', subject: 'water', predicate: 'boilingPoint', object: 100,
      confidence: 0.99, provenanceRef: prov.id,
      verificationProcedure: makeProc(),
    }))

    const verifiable = getVerifiableClaims(ku)
    expect(verifiable).toHaveLength(1)
    expect(verifiable[0].subject).toBe('water')
  })
})

// ── computeMaturityFromReplications ──────────────────────────────────────────

describe('computeMaturityFromReplications', () => {
  it('draft when procedure exists but no replications', () => {
    const ku = makeKUWithProcedure('water', 'boilingPoint', 100)
    expect(computeMaturityFromReplications(ku)).toBe('draft')
  })

  it('proposed after 1 reproduced replication', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPoint', 100)
    const proc = ku.structured.claims[0].verificationProcedure!
    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100 })
    const agent = createMockReplicationAgent('did:key:r1', 'r1', new Map([[proc.entrypoint!, fn]]))
    await runReplication(ku, [agent], { requireSignature: false })
    expect(computeMaturityFromReplications(ku)).toBe('proposed')
  })

  it('validated after 3 reproduced, 0 failed', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPoint', 100)
    const proc = ku.structured.claims[0].verificationProcedure!
    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100 })
    const agents = [0, 1, 2].map(i =>
      createMockReplicationAgent(`did:key:r${i}`, `r${i}`, new Map([[proc.entrypoint!, fn]]))
    )
    await runReplication(ku, agents, { requireSignature: false })
    expect(computeMaturityFromReplications(ku)).toBe('validated')
  })

  it('stable after 5 reproduced, 0 failed', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPoint', 100)
    const proc = ku.structured.claims[0].verificationProcedure!
    const fn: MockVerdict = () => ({ verdict: 'reproduced', result: 100 })
    const agents = [0, 1, 2, 3, 4].map(i =>
      createMockReplicationAgent(`did:key:s${i}`, `s${i}`, new Map([[proc.entrypoint!, fn]]))
    )
    await runReplication(ku, agents, { requireSignature: false })
    expect(computeMaturityFromReplications(ku)).toBe('stable')
  })

  it('stays proposed after 3 reproduced + 1 failed', async () => {
    const ku = makeKUWithProcedure('water', 'boilingPoint', 100)
    const proc = ku.structured.claims[0].verificationProcedure!
    const reproFn: MockVerdict = () => ({ verdict: 'reproduced', result: 100 })
    const failFn: MockVerdict = () => ({ verdict: 'failed', result: null })
    const agents = [
      createMockReplicationAgent('did:key:r0', 'r0', new Map([[proc.entrypoint!, reproFn]])),
      createMockReplicationAgent('did:key:r1', 'r1', new Map([[proc.entrypoint!, reproFn]])),
      createMockReplicationAgent('did:key:r2', 'r2', new Map([[proc.entrypoint!, reproFn]])),
      createMockReplicationAgent('did:key:f0', 'f0', new Map([[proc.entrypoint!, failFn]])),
    ]
    await runReplication(ku, agents, { requireSignature: false })
    // 3 reproduced + 1 failed → can't be 'validated' (failed > 0)
    const maturity = computeMaturityFromReplications(ku)
    expect(['proposed', 'draft']).toContain(maturity)
    expect(maturity).not.toBe('validated')
    expect(maturity).not.toBe('stable')
  })

  it('falls back to confidence-based maturity when no procedure', () => {
    const prov = createProvenance({ did: 'did:key:t', type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'test', title: { en: 'no proc' }, provenance: prov })
    ku.structured.claims.push(createClaim({
      type: 'factual', subject: 'sky', predicate: 'color', object: 'blue',
      confidence: 0.9, provenanceRef: prov.id,
    }))
    // High confidence + 0 reviews → 'draft' (legacy path)
    ku.meta.confidence.aggregate = 0.9
    const maturity = computeMaturityFromReplications(ku)
    expect(maturity).toBe('draft')  // no reviews → can't be stable/validated/proposed
  })
})
