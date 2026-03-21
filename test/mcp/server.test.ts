import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { KUStore } from '../../src/core/store.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { runPipeline } from '../../src/pipeline/index.js'
import { mkdirSync } from 'fs'
import { v7 as uuidv7 } from 'uuid'

let store: KUStore
let graph: RelationGraph

beforeAll(() => {
  mkdirSync('C:/Temp/akp-test-mcp', { recursive: true })
  store = new KUStore({ dbPath: `C:/Temp/akp-test-mcp/test-${Date.now()}.db` })
  graph = new RelationGraph()
})

afterAll(() => store?.close())

describe('MCP server setup', () => {
  it('instantiates without error', () => {
    expect(() => createMcpServer({ store, graph })).not.toThrow()
  })

  it('akp_contribute equivalent: create KU via pipeline and store', async () => {
    // Simulate what akp_contribute does internally
    const prov = createProvenance({ did: 'did:key:mcp-agent', type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'science', title: { en: 'Test via MCP flow' }, summary: 'Test', provenance: prov })
    const result = await runPipeline(ku, graph, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity
    const id = store.create(ku)
    graph.addKU(ku)
    expect(id).toBeTruthy()
    expect(store.read(id)?.meta.domain).toBe('science')
  })

  it('akp_search equivalent: query returns stored KUs', async () => {
    const results = store.query({ domain: 'science', limit: 10 })
    expect(results.length).toBeGreaterThan(0)
  })

  it('akp_review equivalent: review updates confidence', async () => {
    const [ku] = store.query({ domain: 'science', limit: 1 })
    const beforeConf = ku.meta.confidence.aggregate
    store.update(ku.id, (k) => {
      k.reviews.push({
        id: uuidv7(),
        reviewerDid: 'did:key:reviewer',
        reviewerType: 'agent',
        timestamp: new Date().toISOString(),
        verdict: 'confirmed',
        scope: [],
        weight: 0.8,
      })
    }, 'add_review')
    const updated = store.read(ku.id)!
    const result = await runPipeline(updated, graph, { mockStage1: true })
    expect(result.confidence.aggregate).toBeGreaterThanOrEqual(beforeConf)
  })
})
