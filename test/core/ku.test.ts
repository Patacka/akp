import { describe, it, expect } from 'vitest'
import { createKU, createProvenance, createClaim, validateKU, KnowledgeUnitSchema } from '../../src/core/ku.js'
import { v4 as uuidv4 } from 'uuid'

describe('KnowledgeUnit schema', () => {
  it('validates a minimal KU', () => {
    const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'test', title: { en: 'Test KU' }, provenance: prov })
    expect(() => validateKU(ku)).not.toThrow()
  })

  it('requires domain', () => {
    expect(() => KnowledgeUnitSchema.parse({ id: 'bad' })).toThrow()
  })

  it('creates claims with correct structure', () => {
    const claim = createClaim({
      type: 'factual',
      subject: 'water',
      predicate: 'boilingPoint',
      object: 100,
      confidence: 0.99,
      provenanceRef: uuidv4(),
    })
    expect(claim.id).toBeTruthy()
    expect(claim.type).toBe('factual')
  })

  it('enforces confidence range', () => {
    const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
    const ku = createKU({ domain: 'test', title: { en: 'Test' }, provenance: prov })
    ku.meta.confidence.aggregate = 1.5
    expect(() => validateKU(ku)).toThrow()
  })
})
