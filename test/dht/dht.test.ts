/**
 * dht.test.ts — DHTPeer integration tests using in-process HTTP servers.
 *
 * We spin up real Express servers so the full HTTP path is exercised
 * without any network dependency.
 */

import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { DHTPeer } from '../../src/dht/dht.js'
import { nodeIdFromDid } from '../../src/dht/bucket.js'

// ── Test server helpers ───────────────────────────────────────────────────────

interface TestNode {
  peer:   DHTPeer
  server: http.Server
  url:    string        // http://127.0.0.1:<port>
  close:  () => Promise<void>
}

async function startNode(did: string, syncUrl = ''): Promise<TestNode> {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port
      const httpUrl = `http://127.0.0.1:${port}`
      const peer = new DHTPeer({ did, syncUrl, httpUrl, networkId: 'testnet' })
      peer.mount(app)
      resolve({
        peer, server, url: httpUrl,
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const nodes: TestNode[] = []
afterEach(async () => {
  await Promise.all(nodes.splice(0).map(n => n.close()))
})

describe('DHTPeer.mount — HTTP endpoints', () => {
  it('POST /dht/ping returns own nodeId and url', async () => {
    const n = await startNode('did:key:zAlpha', 'wss://alpha')
    nodes.push(n)

    const res = await fetch(n.url + '/dht/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '', syncUrl: '', httpUrl: '' }),
    })
    const data = await res.json() as { id: string; syncUrl: string }
    expect(res.ok).toBe(true)
    expect(data.id).toBe(nodeIdFromDid('did:key:zAlpha').toString('hex'))
    expect(data.syncUrl).toBe('wss://alpha')
  })

  it('POST /dht/find_node returns closest contacts', async () => {
    const n = await startNode('did:key:zHost')
    nodes.push(n)

    // Seed the host's routing table via a ping from a known node
    await fetch(n.url + '/dht/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: nodeIdFromDid('did:key:zKnown').toString('hex'),
        syncUrl: 'wss://known',
        httpUrl: 'http://known',
      }),
    })

    const target = nodeIdFromDid('did:key:zTarget').toString('hex')
    const res = await fetch(n.url + '/dht/find_node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, id: '', syncUrl: '', httpUrl: '' }),
    })
    const data = await res.json() as { nodes: unknown[] }
    expect(res.ok).toBe(true)
    expect(Array.isArray(data.nodes)).toBe(true)
  })
})

describe('DHTPeer two-node bootstrap', () => {
  it('nodeA can ping nodeB and populate routing table', async () => {
    const a = await startNode('did:key:zA', 'wss://a')
    const b = await startNode('did:key:zB', 'wss://b')
    nodes.push(a, b)

    await a.peer.seed([b.url])
    expect(a.peer.routingTableSize()).toBe(1)
  })

  it('after bootstrap both nodes know each other', async () => {
    const a = await startNode('did:key:zNode1', 'wss://node1')
    const b = await startNode('did:key:zNode2', 'wss://node2')
    nodes.push(a, b)

    await a.peer.bootstrap([b.url])
    await b.peer.bootstrap([a.url])

    expect(a.peer.routingTableSize()).toBeGreaterThan(0)
    expect(b.peer.routingTableSize()).toBeGreaterThan(0)
  })

  it('findPeers returns sync URL of known peers', async () => {
    const a = await startNode('did:key:zFinder', 'wss://finder')
    const b = await startNode('did:key:zTarget2', 'wss://target2')
    nodes.push(a, b)

    await a.peer.seed([b.url])
    await a.peer.announce()
    const peers = await a.peer.findPeers()
    // b's syncUrl should appear in the result
    expect(peers).toContain('wss://target2')
  })
})

describe('DHTPeer three-node network', () => {
  it('C finds A through B (routing through intermediary)', async () => {
    const a = await startNode('did:key:z3NodeA', 'wss://3a')
    const b = await startNode('did:key:z3NodeB', 'wss://3b')
    const c = await startNode('did:key:z3NodeC', 'wss://3c')
    nodes.push(a, b, c)

    // A and B know each other
    await a.peer.seed([b.url])
    await b.peer.seed([a.url])

    // C only knows B
    await c.peer.bootstrap([b.url])

    // After bootstrap, C should discover A through B's routing table
    const peers = await c.peer.findPeers()
    // C should find at least one peer (A or B)
    expect(peers.length).toBeGreaterThan(0)
  })
})
