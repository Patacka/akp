/**
 * node.test.ts — AKPNode facade integration tests.
 *
 * All tests use :memory: store and no network ports.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { AKPNode } from '../src/node.js'

let node: AKPNode | undefined

afterEach(() => {
  node?.close()
  node = undefined
})

describe('AKPNode.start', () => {
  it('starts with no options (in-memory)', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })
    expect(node.did).toMatch(/^did:key:z/)
  })

  it('generates a stable identity — same path → same DID', async () => {
    const identityPath = `C:/Temp/akp-test-node-${Date.now()}/identity.json`
    const a = await AKPNode.start({ store: ':memory:', identityPath, devMode: true })
    const didA = a.did
    a.close()

    const b = await AKPNode.start({ store: ':memory:', identityPath, devMode: true })
    expect(b.did).toBe(didA)
    b.close()
  })
})

describe('AKPNode.contribute + query + read', () => {
  it('contribute returns a kuId and query finds it', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })

    const kuId = node.contribute({
      domain: 'chemistry',
      title: 'Boiling point of water',
      summary: 'Water boils at 100°C at 1 atm.',
      claims: [{ subject: 'water', predicate: 'boilingPoint', object: 100, type: 'quantitative' }],
    })

    expect(typeof kuId).toBe('string')

    const results = node.query({ domain: 'chemistry' })
    expect(results.length).toBe(1)
    expect(results[0].meta.domain).toBe('chemistry')
  })

  it('read returns the contributed KU', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })
    const kuId = node.contribute({ domain: 'test', title: 'Hello' })
    const ku = node.read(kuId)
    expect(ku).not.toBeNull()
    expect(ku!.meta.domain).toBe('test')
  })

  it('read returns null for unknown id', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })
    expect(node.read('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('provenance DID matches node DID', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })
    const kuId = node.contribute({ domain: 'test', title: 'Provenance test' })
    const ku = node.read(kuId)!
    expect(ku.provenance[0].agent.did).toBe(node.did)
  })

  it('full-text search finds contributed KU', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })
    node.contribute({ domain: 'medicine', title: 'Aspirin mechanism of action', summary: 'COX inhibitor' })
    const results = node.query({ search: 'aspirin' })
    expect(results.length).toBeGreaterThan(0)
  })
})

describe('AKPNode.skills', () => {
  it('returns only skill-domain KUs', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })

    node.contribute({ domain: 'skill', title: 'Brave search MCP', claims: [
      { subject: 'brave', predicate: 'serverUrl', object: 'https://mcp.brave.com' },
    ]})
    node.contribute({ domain: 'chemistry', title: 'Water boiling point' })

    const skills = node.skills({ minConfidence: 0 })
    expect(skills.length).toBe(1)
    expect(skills[0].meta.domain).toBe('skill')
  })
})

describe('AKPNode.store escape hatch', () => {
  it('exposes the underlying KUStore', async () => {
    node = await AKPNode.start({ store: ':memory:', devMode: true })
    expect(node.store).toBeDefined()
    expect(typeof node.store.allIds).toBe('function')
  })
})

describe('AKPNode two-node local sync', () => {
  it('syncs a KU from node A to node B via WebSocket', async () => {
    const nodeA = await AKPNode.start({
      store: ':memory:',
      syncPort: 14100,
      devMode: true,
      networkId: 'testnet',
    })
    const nodeB = await AKPNode.start({
      store: ':memory:',
      devMode: true,
      networkId: 'testnet',
    })

    nodeA.contribute({ domain: 'test', title: 'Sync test KU' })
    await nodeB.connect('ws://127.0.0.1:14100')
    await new Promise(r => setTimeout(r, 800))

    const results = nodeB.query({ domain: 'test' })
    expect(results.length).toBe(1)
    expect(results[0].meta.title.en).toBe('Sync test KU')

    nodeA.close()
    nodeB.close()
  }, 10_000)
})
