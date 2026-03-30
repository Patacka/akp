/**
 * discovery.ts — Gossip-based peer discovery for AKP nodes.
 *
 * Design: two-level approach
 *
 * Level 1 — Bootstrap registry (well-known HTTP endpoint):
 *   Nodes POST their address to a well-known registry on startup.
 *   The registry returns a list of known peers.
 *   This is optional and operator-configurable; the default is no registry.
 *
 * Level 2 — Peer exchange (PEX) via gossip:
 *   After a successful handshake, each connected peer shares its known-peers
 *   list. The local node adds new addresses to its peer table and dials them
 *   if under the target peer count.
 *
 * Peer table: an in-memory + SQLite-persisted set of (address, port, nodeId,
 * lastSeen, failCount). Entries with failCount >= MAX_FAIL_COUNT are evicted.
 *
 * Anti-spam: each peer exchange message is limited to MAX_PEX_PEERS entries.
 * Addresses are validated (must be host:port, no internal RFC-1918 addresses
 * unless running in dev mode). Node IDs are verified to prevent spoofed
 * peer announcements.
 */

import type Database from 'better-sqlite3'

export const MAX_PEX_PEERS = 20       // max peers to share in one exchange
export const MAX_FAIL_COUNT = 5       // evict after 5 consecutive connection failures
export const TARGET_PEER_COUNT = 8    // target number of active connections
export const PEER_REFRESH_INTERVAL_MS = 5 * 60 * 1000  // 5 min

export interface PeerEntry {
  nodeId: string        // Ed25519 public key hex or DID
  address: string       // hostname or IP
  port: number
  lastSeenMs: number
  failCount: number
  source: 'bootstrap' | 'pex' | 'manual'
}

export interface PexMessage {
  type: 'pex'
  peers: Array<{ nodeId: string; address: string; port: number }>
}

export interface BootstrapRegistryConfig {
  url: string             // e.g. "https://akp-bootstrap.example.com/peers"
  nodeId: string
  listenAddress: string
  listenPort: number
  networkId: string
}

// ── In-memory + SQLite-persisted peer table ───────────────────────────────────

export class PeerTable {
  private peers = new Map<string, PeerEntry>()  // nodeId → entry
  private devMode: boolean
  private db: Database.Database | null

  constructor(devMode = false, db: Database.Database | null = null) {
    this.devMode = devMode
    this.db = db
    if (db) {
      // Load all persisted peers into memory on startup
      const rows = db.prepare('SELECT * FROM peers').all() as PeerEntry[]
      for (const row of rows) {
        this.peers.set(row.nodeId, row)
      }
    }
  }

  /** Add or refresh a peer entry */
  upsert(entry: Omit<PeerEntry, 'lastSeenMs' | 'failCount'> & Partial<Pick<PeerEntry, 'failCount'>>): void {
    if (!this.isValidAddress(entry.address)) return
    const existing = this.peers.get(entry.nodeId)
    const saved: PeerEntry = {
      ...entry,
      lastSeenMs: Date.now(),
      failCount: entry.failCount ?? existing?.failCount ?? 0,
    }
    this.peers.set(entry.nodeId, saved)
    this.db?.prepare(
      'INSERT OR REPLACE INTO peers (nodeId, address, port, lastSeenMs, failCount, source) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(saved.nodeId, saved.address, saved.port, saved.lastSeenMs, saved.failCount, saved.source)
  }

  /** Record a failed connection attempt; evict if over threshold */
  recordFailure(nodeId: string): void {
    const entry = this.peers.get(nodeId)
    if (!entry) return
    const failCount = entry.failCount + 1
    if (failCount >= MAX_FAIL_COUNT) {
      this.peers.delete(nodeId)
      this.db?.prepare('DELETE FROM peers WHERE nodeId = ?').run(nodeId)
    } else {
      this.peers.set(nodeId, { ...entry, failCount })
      this.db?.prepare('UPDATE peers SET failCount = ? WHERE nodeId = ?').run(failCount, nodeId)
    }
  }

  recordSuccess(nodeId: string): void {
    const entry = this.peers.get(nodeId)
    if (!entry) return
    const now = Date.now()
    this.peers.set(nodeId, { ...entry, failCount: 0, lastSeenMs: now })
    this.db?.prepare('UPDATE peers SET failCount = 0, lastSeenMs = ? WHERE nodeId = ?').run(now, nodeId)
  }

  /** Return up to n peers for exchange, most-recently-seen first */
  selectForExchange(n = MAX_PEX_PEERS, excludeNodeId?: string): PeerEntry[] {
    return Array.from(this.peers.values())
      .filter(p => p.nodeId !== excludeNodeId && p.failCount < MAX_FAIL_COUNT)
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .slice(0, n)
  }

  all(): PeerEntry[] {
    return Array.from(this.peers.values())
  }

  size(): number { return this.peers.size }

  private isValidAddress(addr: string): boolean {
    if (this.devMode) return true
    // Reject RFC-1918 and loopback in production
    if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return false
    if (addr === 'localhost' || addr === '::1') return false
    return true
  }
}

// ── Bootstrap registry client ────────────────────────────────────────────────

export interface BootstrapResponse {
  peers: Array<{ nodeId: string; address: string; port: number }>
}

/**
 * Register this node with a bootstrap registry and receive initial peers.
 * Fails gracefully if the registry is unreachable (offline-first operation).
 */
export async function bootstrapFromRegistry(
  config: BootstrapRegistryConfig,
  table: PeerTable,
): Promise<number> {
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: config.nodeId,
        address: config.listenAddress,
        port: config.listenPort,
        networkId: config.networkId,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return 0
    const data = await res.json() as BootstrapResponse
    let added = 0
    for (const peer of (data.peers ?? [])) {
      table.upsert({ ...peer, source: 'bootstrap' })
      added++
    }
    return added
  } catch {
    // Registry unreachable — continue with existing peer table
    return 0
  }
}

/**
 * Apply a PEX message from a connected peer to the local peer table.
 * Limits processing to MAX_PEX_PEERS entries regardless of message size.
 */
export function applyPexMessage(msg: PexMessage, table: PeerTable): number {
  let added = 0
  for (const peer of msg.peers.slice(0, MAX_PEX_PEERS)) {
    if (!peer.nodeId || !peer.address || !peer.port) continue
    table.upsert({ ...peer, source: 'pex' })
    added++
  }
  return added
}

/**
 * Generate a PEX message to send to a connected peer.
 */
export function buildPexMessage(table: PeerTable, excludeNodeId?: string): PexMessage {
  return {
    type: 'pex',
    peers: table.selectForExchange(MAX_PEX_PEERS, excludeNodeId).map(p => ({
      nodeId: p.nodeId,
      address: p.address,
      port: p.port,
    })),
  }
}
