import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KUStore } from '../../src/core/store.js'
import { createKU, createProvenance } from '../../src/core/ku.js'
import { SyncPeer } from '../../src/sync/peer.js'
import { generateIdentity } from '../../src/core/identity.js'
import { mkdirSync } from 'fs'

function tmpStore(label: string): KUStore {
  const dir = `C:/Temp/akp-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir, { recursive: true })
  return new KUStore({ dbPath: `${dir}/${label}.db` })
}

function makeKU() {
  const prov = createProvenance({ did: 'did:key:ws', type: 'agent', method: 'synthesis' })
  return createKU({ domain: 'test', title: { en: `WS-KU-${Math.random().toFixed(6)}` }, provenance: prov })
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function waitFor(fn: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(150)
  }
  return false
}

let storeA: KUStore, storeB: KUStore
let peerA: SyncPeer, peerB: SyncPeer
let port: number

beforeEach(() => {
  port = 14000 + Math.floor(Math.random() * 1000)
  storeA = tmpStore('A')
  storeB = tmpStore('B')
  peerA = new SyncPeer({ store: storeA, port, requireAuth: false })
  peerB = new SyncPeer({ store: storeB, port: port + 1, requireAuth: false })
  peerA.startServer()
})

afterEach(async () => {
  peerA.close()
  peerB.close()
  await sleep(100)
  storeA.close()
  storeB.close()
})

describe('WebSocket two-node sync', () => {
  it('syncs a single KU from server to client', async () => {
    const ku = makeKU()
    storeA.create(ku)
    await peerB.connectTo(`ws://localhost:${port}`)
    const ok = await waitFor(() => storeB.allIds().includes(ku.id))
    expect(ok).toBe(true)
    expect(storeB.read(ku.id)?.meta.domain).toBe('test')
  }, 10000)

  it('syncs 10 KUs within 5 seconds', async () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const ku = makeKU()
      ids.push(ku.id)
      storeA.create(ku)
    }
    const start = Date.now()
    await peerB.connectTo(`ws://localhost:${port}`)
    const ok = await waitFor(() => ids.every(id => storeB.allIds().includes(id)), 8000)
    const elapsed = Date.now() - start
    expect(ok).toBe(true)
    expect(elapsed).toBeLessThan(5000)
  }, 12000)

  it('syncs bidirectionally: B→A', async () => {
    const kuA = makeKU()
    const kuB = makeKU()
    storeA.create(kuA)
    storeB.create(kuB)
    // Start peerB as server too, then A connects to B
    peerB.startServer()
    await sleep(50)
    await peerA.connectTo(`ws://localhost:${port + 1}`)
    const ok = await waitFor(() =>
      storeA.allIds().includes(kuB.id) && storeB.allIds().includes(kuA.id), 8000)
    expect(ok).toBe(true)
  }, 12000)

  it('syncs with Ed25519 challenge-response auth', async () => {
    const identityA = await generateIdentity()
    const identityB = await generateIdentity()

    const authPort = port + 100
    const authStoreA = tmpStore('authA')
    const authStoreB = tmpStore('authB')

    const authPeerA = new SyncPeer({ store: authStoreA, port: authPort, identity: identityA, requireAuth: true })
    const authPeerB = new SyncPeer({ store: authStoreB, port: authPort + 1, identity: identityB })
    authPeerA.startServer()

    const ku = makeKU()
    authStoreA.create(ku)

    try {
      await authPeerB.connectTo(`ws://localhost:${authPort}`)
      const ok = await waitFor(() => authStoreB.allIds().includes(ku.id), 8000)
      expect(ok).toBe(true)
    } finally {
      authPeerA.close()
      authPeerB.close()
      await sleep(100)
      authStoreA.close()
      authStoreB.close()
    }
  }, 15000)

  it('rejects unauthenticated connection when requireAuth=true', async () => {
    const identityA = await generateIdentity()
    const authPort = port + 200
    const authStoreA = tmpStore('authC')
    const unauthStoreB = tmpStore('authD')

    // Server requires auth; client has NO identity
    const authPeerA = new SyncPeer({ store: authStoreA, port: authPort, identity: identityA, requireAuth: true })
    const unauthPeerB = new SyncPeer({ store: unauthStoreB, port: authPort + 1 }) // no identity

    const ku = makeKU()
    authStoreA.create(ku)
    authPeerA.startServer()

    try {
      // Client connects but has no identity — server closes with 4401
      await expect(unauthPeerB.connectTo(`ws://localhost:${authPort}`))
        .rejects.toThrow()
    } finally {
      authPeerA.close()
      unauthPeerB.close()
      await sleep(100)
      authStoreA.close()
      unauthStoreB.close()
    }
  }, 10000)

  it('reconnection picks up new KUs', async () => {
    const ku1 = makeKU()
    storeA.create(ku1)
    await peerB.connectTo(`ws://localhost:${port}`)
    await waitFor(() => storeB.allIds().includes(ku1.id))

    // Disconnect (close peerB server, recreate)
    peerB.close()
    await sleep(200)

    // Add new KU after disconnect
    const ku2 = makeKU()
    storeA.create(ku2)

    // Reconnect
    peerB = new SyncPeer({ store: storeB, port: port + 1, requireAuth: false })
    await peerB.connectTo(`ws://localhost:${port}`)
    const ok = await waitFor(() => storeB.allIds().includes(ku2.id), 6000)
    expect(ok).toBe(true)
  }, 15000)
})
