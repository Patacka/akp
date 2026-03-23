/**
 * DID-bound seed tests.
 *
 * Verifies that computeDidBoundSeed(claimId, reviewerDid) is:
 *  - Deterministic: same inputs → same output
 *  - DID-unique: different DIDs → different seeds for the same claim
 *  - Claim-unique: different claims → different seeds for the same DID
 *  - Enforced in akp.review.submit when claiming a seedable claim
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { computeDidBoundSeed, signBytes, canonicalReviewSubmitPayload } from '../../src/core/identity.js'
import { KUStore } from '../../src/core/store.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { createRpcServer } from '../../src/api/rpc.js'
import { generateIdentity } from '../../src/core/identity.js'
import { v7 as uuidv7 } from 'uuid'
import http from 'node:http'

// ── Unit tests for the seed function ─────────────────────────────────────────

describe('computeDidBoundSeed', () => {
  const claimId  = '018f1e2e-0001-7000-8000-000000000001'
  const claimId2 = '018f1e2e-0001-7000-8000-000000000002'
  const didA = 'did:key:zaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
  const didB = 'did:key:z0011223344556677889900aabbccddeeff0011223344556677889900aabbccdd'

  it('is deterministic — same inputs give the same seed', () => {
    expect(computeDidBoundSeed(claimId, didA)).toBe(computeDidBoundSeed(claimId, didA))
  })

  it('is DID-unique — different DIDs produce different seeds for the same claim', () => {
    const seedA = computeDidBoundSeed(claimId, didA)
    const seedB = computeDidBoundSeed(claimId, didB)
    expect(seedA).not.toBe(seedB)
  })

  it('is claim-unique — same DID produces different seeds for different claims', () => {
    const s1 = computeDidBoundSeed(claimId, didA)
    const s2 = computeDidBoundSeed(claimId2, didA)
    expect(s1).not.toBe(s2)
  })

  it('returns a 32-bit signed integer', () => {
    const seed = computeDidBoundSeed(claimId, didA)
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(-(2 ** 31))
    expect(seed).toBeLessThanOrEqual(2 ** 31 - 1)
  })

  it('a Sybil using DID-B cannot reproduce the seed for DID-A', () => {
    const legitimateSeed = computeDidBoundSeed(claimId, didA)
    const sybilSeed      = computeDidBoundSeed(claimId, didB)
    // The sybil must run the simulation under their own DID and gets a different answer
    expect(legitimateSeed).not.toBe(sybilSeed)
  })
})

// ── Integration test: RPC enforces the seed on seedable claims ────────────────

describe('akp.review.submit seed enforcement', () => {
  let store: KUStore
  let graph: RelationGraph
  let server: ReturnType<typeof createRpcServer>
  let port: number
  let kuId: string
  let claimId: string
  let reviewerDid: string
  let reviewerPrivateKeyHex: string

  async function sign(kuId: string, claimIds: string[], verdict: string, did: string, privateKeyHex: string): Promise<string> {
    return signBytes(canonicalReviewSubmitPayload({ kuId, claimIds, verdict, reviewerDid: did }), privateKeyHex)
  }

  async function rpc(method: string, params: unknown) {
    return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/rpc', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          let data = ''
          res.on('data', d => { data += d })
          res.on('end', () => resolve(JSON.parse(data)))
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  beforeEach(async () => {
    store = new KUStore({ dbPath: ':memory:' })
    graph = store.buildGraph()
    port = 12200 + Math.floor(Math.random() * 100)
    server = createRpcServer({ store, graph, port, mockStage1: true })
    server.listen()

    // Create a KU with a seedable claim
    const identity = await generateIdentity()
    reviewerDid = identity.did
    reviewerPrivateKeyHex = identity.privateKeyHex
    claimId = uuidv7()

    const ku = createKU({
      domain: 'test',
      title: { en: 'Seedable KU' },
      provenance: createProvenance({ did: identity.did, type: 'agent', method: 'observation' }),
    })
    ku.structured.claims.push({
      id: claimId,
      type: 'quantitative',
      subject: 'pi',
      predicate: 'approximate_value',
      object: '3.14159',
      confidence: 0.9,
      provenanceRef: ku.provenance[0].id,
      replications: [],
      verificationProcedure: {
        type: 'simulation',
        executable: 'return 3.14159',
        runtime: 'mock',
        seedable: true,
      },
    } as Parameters<typeof ku.structured.claims.push>[0])

    kuId = store.create(ku)
    graph.addKU(ku)
    // Graduate reviewer so weight > 0
    store.ensureDid(reviewerDid)
    // Bypass graduation for test (graduationThreshold=10 by default but dev mode has 0)
  })

  afterEach(() => server.close())

  it('accepts a review with the correct DID-bound seed', async () => {
    const seed = computeDidBoundSeed(claimId, reviewerDid)
    const signature = await sign(kuId, [claimId], 'confirmed', reviewerDid, reviewerPrivateKeyHex)
    const res = await rpc('akp.review.submit', {
      kuId, claimIds: [claimId], verdict: 'confirmed', reviewerDid, seed, signature,
    })
    expect(res.error).toBeUndefined()
    expect(res.result).toHaveProperty('newConfidence')
  })

  it('rejects a review with a wrong seed and slashes the DID', async () => {
    const wrongSeed = computeDidBoundSeed(claimId, reviewerDid) + 1
    const signature = await sign(kuId, [claimId], 'confirmed', reviewerDid, reviewerPrivateKeyHex)
    const res = await rpc('akp.review.submit', {
      kuId, claimIds: [claimId], verdict: 'confirmed', reviewerDid, seed: wrongSeed, signature,
    })
    expect(res.error).toBeDefined()
    expect(res.error!.message).toMatch(/Invalid DID-bound seed/)

    // Reputation should have been slashed
    const rep = store.getReputation(reviewerDid)
    expect(rep).not.toBeNull()
    expect(rep!.reputation).toBeLessThan(0)
  })

  it('rejects a review missing the seed entirely', async () => {
    const signature = await sign(kuId, [claimId], 'confirmed', reviewerDid, reviewerPrivateKeyHex)
    const res = await rpc('akp.review.submit', {
      kuId, claimIds: [claimId], verdict: 'confirmed', reviewerDid, signature,
      // no seed field
    })
    expect(res.error).toBeDefined()
    expect(res.error!.message).toMatch(/seed is required/)
  })
})
