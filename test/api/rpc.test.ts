import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { mkdirSync } from 'fs'
import { KUStore } from '../../src/core/store.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createRpcServer } from '../../src/api/rpc.js'

let server: ReturnType<typeof import('http').createServer>
let port: number
let store: KUStore

beforeAll(async () => {
  mkdirSync('C:/Temp/akp-test-rpc', { recursive: true })
  store = new KUStore({ dbPath: `C:/Temp/akp-test-rpc/test-${Date.now()}.db` })
  const graph = new RelationGraph()
  const { app } = createRpcServer({ store, graph, mockStage1: true })
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      port = (server.address() as import('net').AddressInfo).port
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  store?.close()
})

async function rpc(method: string, params: unknown) {
  const res = await fetch(`http://localhost:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return res.json()
}

describe('JSON-RPC API', () => {
  it('akp.ku.create returns a kuId', async () => {
    const response = await rpc('akp.ku.create', {
      domain: 'test',
      title: { en: 'Test KU' },
      summary: 'test summary',
    })
    expect(response.result).toBeDefined()
    expect(typeof response.result.kuId).toBe('string')
  })

  it('akp.ku.read returns the created KU', async () => {
    const createRes = await rpc('akp.ku.create', {
      domain: 'test',
      title: { en: 'Read Test KU' },
      summary: 'for reading',
    })
    const kuId = createRes.result.kuId
    const readRes = await rpc('akp.ku.read', { kuId })
    expect(readRes.result).toBeDefined()
    expect(readRes.result.meta.domain).toBe('test')
  })

  it('akp.ku.read returns error for missing id', async () => {
    const response = await rpc('akp.ku.read', { kuId: '00000000-0000-0000-0000-000000000000' })
    expect(response.error).toBeDefined()
  })

  it('akp.ku.query returns results', async () => {
    const domain = `query-domain-${Date.now()}`
    await rpc('akp.ku.create', { domain, title: { en: 'Q1' }, summary: 's1' })
    await rpc('akp.ku.create', { domain, title: { en: 'Q2' }, summary: 's2' })
    const response = await rpc('akp.ku.query', { domain })
    expect(Array.isArray(response.result)).toBe(true)
    expect(response.result.length).toBeGreaterThanOrEqual(1)
  })

  it('akp.review.submit updates confidence', async () => {
    const createRes = await rpc('akp.ku.create', {
      domain: 'test',
      title: { en: 'Review Target' },
      summary: 'to be reviewed',
    })
    const kuId = createRes.result.kuId
    const reviewRes = await rpc('akp.review.submit', {
      kuId,
      claimIds: [],
      verdict: 'confirmed',
      reviewerDid: 'did:key:reviewer',
      weight: 0.8,
    })
    expect(reviewRes.result).toBeDefined()
    expect(reviewRes.result.newConfidence).toBeGreaterThanOrEqual(0)
  })
})
