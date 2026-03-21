/**
 * autoresearch.test.ts — Unit tests for the autoresearch agent.
 *
 * Uses MockAutoresearchClient — no real LLM calls.
 */

import { describe, it, expect } from 'vitest'
import { autoresearch, createMockAutoresearchClient } from '../../src/pipeline/autoresearch.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WATER_RESPONSE = JSON.stringify({
  title: { en: 'Water boiling point at sea level' },
  summary: 'Water boils at 100°C at sea level atmospheric pressure.',
  claims: [
    {
      type: 'quantitative',
      subject: 'water',
      predicate: 'boilingPointCelsius',
      object: 100,
      confidence: 0.99,
      verificationProcedure: {
        type: 'code',
        runtime: 'node@22',
        executable: 'console.log(JSON.stringify({ verdict: "reproduced", result: 100, deviationPct: 0 }))',
        expectedResult: 100,
        tolerancePct: 1,
        timeoutSeconds: 10,
        seedable: false,
      },
    },
    {
      type: 'factual',
      subject: 'water',
      predicate: 'chemicalFormula',
      object: 'H2O',
      confidence: 1.0,
      verificationProcedure: null,  // qualitative — no procedure
    },
  ],
})

const MALICIOUS_RESPONSE = JSON.stringify({
  title: { en: 'Malicious research' },
  summary: 'Test bad runtime rejection.',
  claims: [
    {
      type: 'code',
      subject: 'test',
      predicate: 'exploit',
      object: 'rce',
      confidence: 0.5,
      verificationProcedure: {
        type: 'code',
        runtime: 'ruby@3.2',   // not in ALLOWED_RUNTIMES
        executable: 'puts "pwned"',
        expectedResult: 'pwned',
      },
    },
  ],
})

const OVERSIZED_EXECUTABLE_RESPONSE = JSON.stringify({
  title: { en: 'Oversized exec' },
  summary: 'Test large executable rejection.',
  claims: [
    {
      type: 'quantitative',
      subject: 'x',
      predicate: 'y',
      object: 1,
      confidence: 0.5,
      verificationProcedure: {
        type: 'code',
        runtime: 'node@22',
        executable: 'x'.repeat(65 * 1024),  // > 64KB
        expectedResult: 1,
      },
    },
  ],
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('autoresearch', () => {
  it('decomposes a question into a KU with claims', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const result = await autoresearch('What is the boiling point of water?', client)

    expect(result.ku.structured.claims).toHaveLength(2)
    expect(result.verifiableClaims).toBe(1)
    expect(result.draftOnlyClaims).toBe(1)
  })

  it('sets KU title and summary from LLM response', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const result = await autoresearch('What is the boiling point of water?', client)

    expect(result.ku.meta.title.en).toBe('Water boiling point at sea level')
    expect(result.ku.narrative.summary).toContain('100°C')
  })

  it('claim with procedure has replications=[]', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const result = await autoresearch('What is the boiling point of water?', client)
    const verifiable = result.ku.structured.claims.find(c => c.verificationProcedure != null)
    expect(verifiable).toBeDefined()
    expect(verifiable!.replications).toEqual([])
  })

  it('rejects procedures with disallowed runtime', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: Test bad runtime', MALICIOUS_RESPONSE]])
    )
    const result = await autoresearch('Test bad runtime rejection.', client)
    // The claim is parsed but the procedure is stripped (sanitizeProcedure returns undefined)
    const withProc = result.ku.structured.claims.filter(c => c.verificationProcedure != null)
    expect(withProc).toHaveLength(0)
    // Claim still exists, but without a procedure → draft-only
    expect(result.draftOnlyClaims).toBeGreaterThanOrEqual(1)
    expect(result.verifiableClaims).toBe(0)
  })

  it('rejects procedures with oversized executable', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: Test large executable', OVERSIZED_EXECUTABLE_RESPONSE]])
    )
    const result = await autoresearch('Test large executable rejection.', client)
    const withProc = result.ku.structured.claims.filter(c => c.verificationProcedure != null)
    expect(withProc).toHaveLength(0)
    expect(result.verifiableClaims).toBe(0)
  })

  it('handles malformed LLM JSON gracefully', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: Broken', 'not valid json {']])
    )
    const result = await autoresearch('Broken JSON response.', client)
    expect(result.ku.structured.claims).toHaveLength(0)
    expect(result.verifiableClaims).toBe(0)
  })

  it('handles markdown-fenced JSON', async () => {
    const fenced = '```json\n' + WATER_RESPONSE + '\n```'
    const client = createMockAutoresearchClient(
      new Map([['Research question: Fenced', fenced]])
    )
    const result = await autoresearch('Fenced JSON response.', client)
    expect(result.ku.structured.claims).toHaveLength(2)
  })

  it('respects maxClaims option', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const result = await autoresearch('What is the boiling point of water?', client, { maxClaims: 1 })
    expect(result.ku.structured.claims).toHaveLength(1)
  })

  it('uses the provided agentDid in provenance', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const result = await autoresearch('What is the boiling point of water?', client, {
      agentDid: 'did:key:myresearcher',
    })
    expect(result.ku.provenance[0].agent.did).toBe('did:key:myresearcher')
  })

  it('sets maturity to draft (no replications yet)', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const result = await autoresearch('What is the boiling point of water?', client)
    // Fresh KU — no replications run yet
    expect(result.ku.meta.maturity).toBe('draft')
  })
})

// ── End-to-end: autoresearch → pipeline with replication ─────────────────────

describe('autoresearch + runReplication integration', () => {
  it('advances maturity from draft to proposed after 1 replication', async () => {
    const client = createMockAutoresearchClient(
      new Map([['Research question: What is the boiling', WATER_RESPONSE]])
    )
    const { ku } = await autoresearch('What is the boiling point of water?', client)

    const { runReplication, createMockReplicationAgent } = await import('../../src/pipeline/stage3-replication.js')
    const { computeMaturityFromReplications } = await import('../../src/core/confidence.js')

    const proc = ku.structured.claims.find(c => c.verificationProcedure != null)?.verificationProcedure!
    const fn = () => ({ verdict: 'reproduced' as const, result: 100, deviationPct: 0 })
    const agent = createMockReplicationAgent('did:key:rep1', 'rep', new Map([
      [proc.entrypoint ?? proc.executable.split(/\s+/)[0], fn]
    ]))

    await runReplication(ku, [agent], { requireSignature: false })
    expect(computeMaturityFromReplications(ku)).toBe('proposed')
  })
})
