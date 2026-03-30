/**
 * node.ts — AKPNode: the single entry-point for embedding AKP in an agent.
 *
 * Each agent instantiates one AKPNode. The node owns:
 *   - A persistent Ed25519 identity (DID)
 *   - A local SQLite-backed KU store (or in-memory for ephemeral agents)
 *   - An optional outbound/inbound WebSocket sync peer
 *   - An optional HTTP RPC server (for external access)
 *
 * Minimal usage:
 *
 *   const node = await AKPNode.start({ bootstrap: ['wss://relay.akp.community'] })
 *   const skills = node.skills()
 *   const kuId = node.contribute({ domain: 'skill', title: 'My tool', claims: [...] })
 *   node.close()
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { KUStore } from './core/store.js'
import { RelationGraph } from './core/graph.js'
import { generateIdentity, type Identity } from './core/identity.js'
import { createKU, createProvenance, createClaim } from './core/ku.js'
import { SyncPeer } from './sync/peer.js'
import { PeerTable } from './sync/discovery.js'
import { createRpcServer } from './api/rpc.js'
import { DHTPeer } from './dht/dht.js'
import { seedsFor } from './dht/seeds.js'
import type { KnowledgeUnit } from './core/ku.js'

// ── Public API types ──────────────────────────────────────────────────────────

export interface AKPNodeOptions {
  /**
   * Path to a JSON file holding the Ed25519 identity { did, publicKeyHex, privateKeyHex }.
   * Created automatically on first start, reloaded on subsequent starts so the agent
   * accumulates reputation across sessions.
   * Default: ~/.akp/identity.json
   */
  identityPath?: string

  /**
   * SQLite database path, or ':memory:' for ephemeral agents.
   * Default: ~/.akp/store.db
   */
  store?: string

  /**
   * HTTP port to expose the JSON-RPC API. 0 = do not listen.
   * Default: 0 (no HTTP server — agent talks to the store directly).
   */
  port?: number

  /**
   * WebSocket port for peer-to-peer sync. 0 = do not listen (outbound-only).
   * Default: 0
   */
  syncPort?: number

  /**
   * WebSocket URLs to connect to on startup.
   * E.g. ['wss://relay.akp.community', 'wss://relay2.akp.community']
   */
  bootstrap?: string[]

  /** Network identifier. Peers on a different network are rejected. Default: 'mainnet' */
  networkId?: string

  /**
   * Enable Kademlia DHT peer discovery. Every node participates by default
   * (BitTorrent-style) — no relay required. Set to false to disable entirely.
   *
   * Full participation (serving DHT routes + accepting sync connections)
   * requires port > 0 and publicly reachable URLs via publicHttpUrl/publicSyncUrl.
   * Nodes without public URLs participate outbound-only (query DHT to find peers).
   *
   * Default: true
   */
  dht?: boolean

  /**
   * Public HTTP base URL where /dht/* endpoints are reachable.
   * Required for full DHT participation. Leave unset for outbound-only.
   * E.g. 'https://akp-relay-1.fly.dev' or 'http://myserver:3000'
   */
  publicHttpUrl?: string

  /**
   * Public WebSocket URL that other nodes use to connect for sync.
   * Required for full DHT participation. Leave unset for outbound-only.
   * E.g. 'wss://akp-relay-1.fly.dev' or 'ws://myserver:3001'
   */
  publicSyncUrl?: string

  /**
   * Skip RFC-1918 address filtering and other prod-only guards.
   * Default: false
   */
  devMode?: boolean
}

export interface ContributeParams {
  domain: string
  title: string
  summary?: string
  claims?: Array<{
    type?: 'factual' | 'quantitative' | 'temporal' | 'causal' | 'contested'
    subject: string
    predicate: string
    object: unknown
    confidence?: number
  }>
  tags?: string[]
}

export interface QueryParams {
  domain?: string
  minConfidence?: number
  minMaturity?: 'draft' | 'proposed' | 'validated' | 'stable'
  tags?: string[]
  /** Full-text search across title + claims */
  search?: string
  limit?: number
}

// ── AKPNode ───────────────────────────────────────────────────────────────────

export class AKPNode {
  /** This node's DID (did:key:z…). Use to track reputation across sessions. */
  readonly did: string
  /** Full identity including private key. Keep this secret. */
  readonly identity: Identity

  private _store: KUStore
  private _graph: RelationGraph
  private _peerTable: PeerTable
  private _sync?: SyncPeer
  private _rpc?: ReturnType<typeof createRpcServer>
  private _dht?: DHTPeer
  private _networkId: string

  private constructor(
    identity: Identity,
    store: KUStore,
    graph: RelationGraph,
    peerTable: PeerTable,
    networkId: string,
  ) {
    this.identity = identity
    this.did = identity.did
    this._store = store
    this._graph = graph
    this._peerTable = peerTable
    this._networkId = networkId
  }

  /**
   * Start an AKP node.
   *
   * - Loads (or generates) a persistent Ed25519 identity.
   * - Opens (or creates) the local KU store.
   * - Optionally starts a WebSocket sync server (syncPort > 0).
   * - Optionally starts an HTTP RPC server (port > 0).
   * - Connects outbound to bootstrap peers.
   *
   * All options have sensible defaults — `AKPNode.start()` with no arguments
   * gives a fully functional offline node at ~/.akp/.
   */
  static async start(options: AKPNodeOptions = {}): Promise<AKPNode> {
    const akpDir = join(homedir(), '.akp')
    const identityPath = options.identityPath ?? join(akpDir, 'identity.json')
    const storePath    = options.store        ?? join(akpDir, 'store.db')

    const identity   = await loadOrCreateIdentity(identityPath)
    const store      = new KUStore({ dbPath: storePath })
    const graph      = store.buildGraph()
    const peerTable  = new PeerTable(options.devMode ?? false, store.database)
    const networkId  = options.networkId ?? 'mainnet'

    const node = new AKPNode(identity, store, graph, peerTable, networkId)

    // Optional: WebSocket sync server (inbound)
    const syncPort = options.syncPort ?? 0
    if (syncPort > 0) {
      node._sync = new SyncPeer({
        store,
        port: syncPort,
        identity,
        networkId,
        onKUSynced: (ku) => graph.addKU(ku),
      })
      node._sync.startServer()
    }

    // DHT peer — every node participates by default (BitTorrent-style)
    if (options.dht !== false) {
      node._dht = new DHTPeer({
        did:       identity.did,
        syncUrl:   options.publicSyncUrl ?? '',
        httpUrl:   options.publicHttpUrl ?? '',
        networkId,
      })
    }

    // Optional: HTTP RPC server
    const port = options.port ?? 0
    if (port > 0) {
      const rpc = createRpcServer({ store, graph, port })
      // Mount DHT routes onto the same Express app before listening
      if (node._dht && options.publicHttpUrl) {
        node._dht.mount(rpc.app)
      }
      node._rpc = rpc
      node._rpc.listen()
    }

    // Bootstrap: connect outbound to peers
    const peers = options.bootstrap ?? []
    if (peers.length > 0) {
      // Create a sync peer for outbound connections only (no server)
      if (!node._sync) {
        node._sync = new SyncPeer({
          store,
          port: 0,
          identity,
          networkId,
          onKUSynced: (ku) => graph.addKU(ku),
        })
      }
      for (const url of peers) {
        node._sync.connectTo(url).catch(() => {
          // Peer unreachable at boot — non-fatal, will retry on next gossip cycle
        })
      }
    }

    // DHT bootstrap: seed routing table + discover sync peers
    if (options.dht !== false && node._dht) {
      const dht = node._dht
      const seeds = seedsFor(networkId)
      const seedHttpUrls = [
        ...seeds.map(s => s.httpUrl),
        ...peers.map(url =>
          url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
        ),
      ]

      if (seedHttpUrls.length > 0) {
        dht.bootstrap(seedHttpUrls).then(async () => {
          const syncUrls = await dht.findPeers()
          if (!node._sync && syncUrls.length > 0) {
            node._sync = new SyncPeer({
              store, port: 0, identity, networkId,
              onKUSynced: (ku) => graph.addKU(ku),
            })
          }
          for (const url of syncUrls) {
            node._sync?.connectTo(url).catch(() => { /* non-fatal */ })
          }
          await dht.announce()
        }).catch(() => { /* DHT bootstrap failed — offline, retry later */ })
      }
    }

    return node
  }

  // ── Knowledge operations ──────────────────────────────────────────────────

  /**
   * Contribute a new Knowledge Unit. Returns the kuId.
   * The node's DID is automatically set as provenance.
   */
  contribute(params: ContributeParams): string {
    const prov = createProvenance({
      did: this.did,
      type: 'agent',
      method: 'observation',
    })

    const ku = createKU({
      domain: params.domain,
      title: { en: params.title },
      provenance: prov,
      tags: params.tags,
    })

    if (params.summary) {
      ku.narrative.summary = params.summary
    }

    for (const c of params.claims ?? []) {
      ku.structured.claims.push(createClaim({
        type: c.type ?? 'factual',
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        confidence: c.confidence ?? 0.7,
        provenanceRef: prov.id,
      }))
    }

    const kuId = this._store.create(ku)
    this._graph.addKU(ku)
    return kuId
  }

  /** Query the local knowledge graph. */
  query(params?: QueryParams): KnowledgeUnit[] {
    if (params?.search) {
      return this._store.search(params.search, {
        domain: params.domain,
        limit: params.limit,
      })
    }
    return this._store.query({
      domain: params?.domain,
      minConfidence: params?.minConfidence,
      minMaturity: params?.minMaturity,
      tags: params?.tags,
      limit: params?.limit,
    })
  }

  /** Read a single KU by ID. Returns null if not found. */
  read(kuId: string): KnowledgeUnit | null {
    return this._store.read(kuId)
  }

  /**
   * List skill KUs (domain='skill').
   * Skills are KUs contributed by agents describing tools, MCPs, or workflows
   * that other agents can invoke. Only returns KUs at or above minConfidence.
   *
   * Convention for skill KUs:
   *   claims[0]: { subject: '<tool-id>', predicate: 'serverUrl', object: 'https://...' }
   *   claims[1]: { subject: '<tool-id>', predicate: 'toolSchema', object: { ... } }
   */
  skills(opts?: { minConfidence?: number }): KnowledgeUnit[] {
    return this.query({
      domain: 'skill',
      minConfidence: opts?.minConfidence ?? 0.7,
    })
  }

  // ── Network ───────────────────────────────────────────────────────────────

  /**
   * Connect to a peer node.
   * Triggers an immediate sync of all KUs this peer hasn't seen.
   */
   async connect(url: string): Promise<void> {
    if (!this._sync) {
      this._sync = new SyncPeer({
        store: this._store,
        port: 0,
        identity: this.identity,
        networkId: this._networkId,
        onKUSynced: (ku) => this._graph.addKU(ku),
      })
    }
    await this._sync.connectTo(url)
  }

  /** Return all known peers from the local peer table. */
  peers() {
    return this._peerTable.all()
  }

  /**
   * Return contacts from the DHT routing table.
   * Only populated when dht: true was passed to start().
   */
  dhtContacts() {
    return this._dht?.contacts() ?? []
  }

  /** DHT routing table size — useful for diagnostics. */
  dhtSize() {
    return this._dht?.routingTableSize() ?? 0
  }

  /**
   * Manually trigger a DHT peer discovery cycle.
   * Useful when the network grows and you want to find new peers.
   */
  async dhtDiscover(): Promise<string[]> {
    if (!this._dht) return []
    return this._dht.findPeers()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Shut down the node. Closes sync peer, RPC server, and database.
   * Safe to call multiple times.
   */
  close(): void {
    this._sync?.close()
    if (this._rpc) {
      this._rpc.close()  // also closes the store
    } else {
      this._store.close()
    }
  }

  // ── Escape hatch ──────────────────────────────────────────────────────────

  /** Direct access to the underlying store for advanced operations. */
  get store(): KUStore { return this._store }
  /** Direct access to the relation graph. */
  get graph(): RelationGraph { return this._graph }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadOrCreateIdentity(path: string): Promise<Identity> {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as Identity
  }
  mkdirSync(dirname(path), { recursive: true })
  const identity = await generateIdentity()
  writeFileSync(path, JSON.stringify(identity, null, 2), 'utf8')
  return identity
}
