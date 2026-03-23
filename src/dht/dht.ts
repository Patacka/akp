/**
 * dht.ts — Kademlia DHT for AKP peer discovery.
 *
 * Each AKP node that has a public HTTP endpoint participates in the DHT
 * as a full peer: it serves /dht/* routes and maintains a routing table.
 *
 * Outbound-only agents can still query the DHT (call bootstrap + findPeers)
 * but they don't mount routes and won't appear in other nodes' routing tables.
 *
 * Protocol (HTTP POST, JSON body):
 *   POST /dht/ping       { nodeId, syncUrl, httpUrl }
 *   POST /dht/find_node  { target, nodeId, syncUrl, httpUrl }
 *   POST /dht/announce   { nodeId, syncUrl, httpUrl, networkKey }
 *   POST /dht/find_peers { networkKey, nodeId, syncUrl, httpUrl }
 *
 * Node ID: SHA-256(did) — 32-byte hex.
 * Network key: SHA-256("akp-dht-v1:<networkId>") — shared lookup target.
 * All nodes on the same networkId converge to the same keyspace region.
 */

import type express from 'express'
import {
  KBucketTable, nodeIdFromDid, networkKey as makeNetworkKey,
  type DHTContact, type NodeId, K, ALPHA,
} from './bucket.js'

export interface DHTPeerOptions {
  /** This node's DID — used to derive DHT node ID. */
  did: string
  /**
   * Public WebSocket URL agents use to connect for KU sync.
   * E.g. 'wss://akp-relay-1.fly.dev' or 'ws://127.0.0.1:3001'
   * Leave empty if this node doesn't accept inbound sync connections.
   */
  syncUrl?: string
  /**
   * Public HTTP base URL where /dht/* endpoints are reachable.
   * E.g. 'https://akp-relay-1.fly.dev' or 'http://127.0.0.1:3000'
   * Leave empty for outbound-query-only nodes.
   */
  httpUrl?: string
  /** Network identifier — nodes on different networks are isolated. Default: 'mainnet' */
  networkId?: string
}

// Wire format used in all DHT messages
interface DHTNodeRecord {
  id:      string   // 32-byte hex
  syncUrl: string
  httpUrl: string
}

// ── DHTPeer ───────────────────────────────────────────────────────────────────

export class DHTPeer {
  readonly localId: NodeId
  private table: KBucketTable
  private syncUrl: string
  private httpUrl: string
  private netKey: NodeId
  private did: string

  constructor(opts: DHTPeerOptions) {
    this.did      = opts.did
    this.localId  = nodeIdFromDid(opts.did)
    this.table    = new KBucketTable(this.localId)
    this.syncUrl  = opts.syncUrl  ?? ''
    this.httpUrl  = opts.httpUrl  ?? ''
    this.netKey   = makeNetworkKey(opts.networkId ?? 'mainnet')
  }

  // ── Express routes ──────────────────────────────────────────────────────────

  /**
   * Mount DHT HTTP endpoints onto an existing Express app.
   * Call this only when this node has a public httpUrl.
   */
  mount(app: express.Express): void {
    // Rate-limit DHT endpoints independently — they're public/unauthenticated
    app.post('/dht/ping', (req, res) => {
      this._upsertFromBody(req.body as DHTNodeRecord)
      res.json(this._self())
    })

    app.post('/dht/find_node', (req, res) => {
      const body = req.body as DHTNodeRecord & { target?: string }
      this._upsertFromBody(body)
      const targetHex = body.target ?? ''
      const targetBuf = Buffer.from(targetHex.slice(0, 64).padEnd(64, '0'), 'hex')
      const nodes = this.table.closest(targetBuf, K).map(this._toRecord)
      res.json({ ...this._self(), nodes })
    })

    app.post('/dht/announce', (req, res) => {
      this._upsertFromBody(req.body as DHTNodeRecord)
      res.json({ ok: true })
    })

    app.post('/dht/find_peers', (req, res) => {
      this._upsertFromBody(req.body as DHTNodeRecord)
      const peers = this.table.closest(this.netKey, K).map(this._toRecord)
      res.json({ ...this._self(), peers })
    })
  }

  // ── Active DHT operations ───────────────────────────────────────────────────

  /**
   * Seed the routing table from a list of known HTTP base URLs.
   * Used at startup before the node has any peers.
   */
  async seed(httpUrls: string[]): Promise<void> {
    await Promise.allSettled(httpUrls.map(url => this._ping(url)))
  }

  /**
   * Full Kademlia bootstrap:
   *   1. Seed routing table from provided URLs.
   *   2. Iterative self-lookup to populate buckets.
   */
  async bootstrap(httpUrls: string[]): Promise<void> {
    await this.seed(httpUrls)
    if (this.table.size() > 0) {
      await this._iterativeLookup(this.localId)
    }
  }

  /**
   * Announce this node to the k-closest nodes for the network key.
   * Call after bootstrap and periodically (every 30–60 min).
   */
  async announce(): Promise<void> {
    if (!this.syncUrl && !this.httpUrl) return  // nothing to announce
    const closest = await this._iterativeLookup(this.netKey)
    await Promise.allSettled(
      closest.slice(0, ALPHA).map(c => this._postAnnounce(c.httpUrl))
    )
  }

  /**
   * Find sync peers for this network.
   * Returns WebSocket URLs (wss://…) of known peers, minus self.
   */
  async findPeers(n = K): Promise<string[]> {
    const closest = await this._iterativeLookup(this.netKey)
    return closest
      .map(c => c.syncUrl)
      .filter(url => url && url !== this.syncUrl)
      .slice(0, n)
  }

  /** Number of contacts currently in the routing table. */
  routingTableSize(): number { return this.table.size() }

  /** All contacts — useful for diagnostics. */
  contacts(): Array<{ id: string; syncUrl: string; httpUrl: string; lastSeen: number }> {
    return this.table.all().map(c => ({
      id:       c.id.toString('hex'),
      syncUrl:  c.syncUrl,
      httpUrl:  c.httpUrl,
      lastSeen: c.lastSeen,
    }))
  }

  // ── Iterative Kademlia lookup ───────────────────────────────────────────────

  private async _iterativeLookup(target: NodeId): Promise<DHTContact[]> {
    const queried = new Set<string>()
    let frontier = this.table.closest(target, K)

    for (let round = 0; round < 20; round++) {
      const toQuery = frontier
        .filter(c => !queried.has(c.id.toString('hex')))
        .slice(0, ALPHA)
      if (toQuery.length === 0) break

      const responses = await Promise.allSettled(
        toQuery.map(c => {
          queried.add(c.id.toString('hex'))
          return this._findNode(c.httpUrl, target)
        })
      )

      let anyNew = false
      for (const r of responses) {
        if (r.status !== 'fulfilled') continue
        for (const contact of r.value) {
          if (!queried.has(contact.id.toString('hex'))) {
            this.table.upsert(contact)
            anyNew = true
          }
        }
      }

      if (!anyNew) break
      frontier = this.table.closest(target, K)
    }

    return this.table.closest(target, K)
  }

  // ── Low-level RPC calls ─────────────────────────────────────────────────────

  private async _ping(httpUrl: string): Promise<void> {
    try {
      const res = await this._post(httpUrl + '/dht/ping', this._self()) as DHTNodeRecord | null
      if (res?.id) this.table.upsert(this._fromRecord(res))
    } catch { /* unreachable — skip */ }
  }

  private async _findNode(httpUrl: string, target: NodeId): Promise<DHTContact[]> {
    try {
      const res = await this._post(httpUrl + '/dht/find_node', {
        ...this._self(),
        target: target.toString('hex'),
      }) as { nodes?: DHTNodeRecord[] } | null
      if (!res?.nodes) return []
      const contacts: DHTContact[] = []
      for (const n of res.nodes) {
        if (n.id && n.syncUrl !== undefined && n.httpUrl !== undefined) {
          contacts.push(this._fromRecord(n))
        }
      }
      return contacts
    } catch {
      return []
    }
  }

  private async _postAnnounce(httpUrl: string): Promise<void> {
    await this._post(httpUrl + '/dht/announce', {
      ...this._self(),
      networkKey: this.netKey.toString('hex'),
    }).catch(() => { /* fire and forget */ })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _self(): DHTNodeRecord {
    return { id: this.localId.toString('hex'), syncUrl: this.syncUrl, httpUrl: this.httpUrl }
  }

  private _toRecord(c: DHTContact): DHTNodeRecord {
    return { id: c.id.toString('hex'), syncUrl: c.syncUrl, httpUrl: c.httpUrl }
  }

  private _fromRecord(r: DHTNodeRecord): DHTContact {
    return {
      id:       Buffer.from(r.id.slice(0, 64).padEnd(64, '0'), 'hex'),
      syncUrl:  r.syncUrl ?? '',
      httpUrl:  r.httpUrl ?? '',
      lastSeen: Date.now(),
    }
  }

  private _upsertFromBody(body: Partial<DHTNodeRecord>): void {
    if (!body.id || !body.httpUrl) return
    this.table.upsert(this._fromRecord(body as DHTNodeRecord))
  }

  private async _post(url: string, body: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    return res.json()
  }
}
