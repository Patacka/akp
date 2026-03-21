import { describe, it, expect } from 'vitest'
import { runStage1 } from '../../src/pipeline/stage1.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'

function makeProv() {
  return createProvenance({ did: 'did:key:test', type: 'agent', method: 'retrieval' })
}

describe('runStage1', () => {
  it('returns score 1.0 when all sources accessible', async () => {
    const prov = makeProv()
    prov.sources = [
      { id: uuidv7(), type: 'url', value: 'https://example.com/a' },
      { id: uuidv7(), type: 'url', value: 'https://example.com/b' },
    ]
    const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
    const result = await runStage1(ku, {
      mockMode: true,
      mockResults: { 'https://example.com/a': true, 'https://example.com/b': true },
    })
    expect(result.stage1Score).toBe(1.0)
  })

  it('returns score 0 when no sources accessible', async () => {
    const prov = makeProv()
    prov.sources = [
      { id: uuidv7(), type: 'url', value: 'https://example.com/a' },
      { id: uuidv7(), type: 'url', value: 'https://example.com/b' },
    ]
    const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
    const result = await runStage1(ku, {
      mockMode: true,
      mockResults: { 'https://example.com/a': false, 'https://example.com/b': false },
    })
    expect(result.stage1Score).toBe(0)
  })

  it('returns score 0.5 for half accessible', async () => {
    const prov = makeProv()
    prov.sources = [
      { id: uuidv7(), type: 'url', value: 'https://example.com/a' },
      { id: uuidv7(), type: 'url', value: 'https://example.com/b' },
    ]
    const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
    const result = await runStage1(ku, {
      mockMode: true,
      mockResults: { 'https://example.com/a': true, 'https://example.com/b': false },
    })
    expect(result.stage1Score).toBe(0.5)
  })

  it('returns score 0 for KU with no sources', async () => {
    const prov = makeProv()
    // no sources set
    const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
    const result = await runStage1(ku, { mockMode: true })
    expect(result.stage1Score).toBe(0)
  })

  it('records response time per check', async () => {
    const prov = makeProv()
    prov.sources = [
      { id: uuidv7(), type: 'url', value: 'https://example.com/a' },
    ]
    const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
    const result = await runStage1(ku, {
      mockMode: true,
      mockResults: { 'https://example.com/a': true },
    })
    expect(result.checks.length).toBeGreaterThan(0)
    expect(result.checks[0]).toHaveProperty('responseTime')
    expect(typeof result.checks[0].responseTime).toBe('number')
  })
})
