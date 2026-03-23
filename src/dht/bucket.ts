/**
 * bucket.ts — Kademlia k-bucket routing table.
 *
 * Node IDs are 32-byte SHA-256 digests (256-bit keyspace).
 * Distance metric: XOR.
 * Each bucket covers nodes whose ID shares exactly i leading bits with the local node.
 */

import { createHash } from 'node:crypto'

export const K     = 20   // max nodes per bucket (Kademlia paper: k=20)
export const ALPHA = 3    // parallel lookups per round
export const ID_BYTES = 32

export type NodeId = Buffer  // 32 bytes

export interface DHTContact {
  id:       NodeId
  syncUrl:  string   // wss://… — used by AKP sync peer to connect
  httpUrl:  string   // https://… — used to reach /dht/* endpoints
  lastSeen: number
}

/** Derive a 32-byte DHT node ID from a did:key string. */
export function nodeIdFromDid(did: string): NodeId {
  return createHash('sha256').update(did).digest()
}

/** Derive a 32-byte lookup key from an arbitrary string (e.g. network ID). */
export function networkKey(name: string): NodeId {
  return createHash('sha256').update(`akp-dht-v1:${name}`).digest()
}

/** XOR distance between two node IDs. Lower = closer. */
export function xorDistance(a: NodeId, b: NodeId): Buffer {
  const out = Buffer.alloc(ID_BYTES)
  for (let i = 0; i < ID_BYTES; i++) out[i] = a[i] ^ b[i]
  return out
}

/** Number of leading zero bits shared by a and b (= bucket index). */
export function commonPrefixBits(a: NodeId, b: NodeId): number {
  for (let i = 0; i < ID_BYTES; i++) {
    const x = a[i] ^ b[i]
    if (x === 0) continue
    // clz of x (8-bit): 8 - floor(log2(x)) - 1
    let clz = 0
    for (let bit = 7; bit >= 0; bit--) {
      if (x & (1 << bit)) break
      clz++
    }
    return i * 8 + clz
  }
  return ID_BYTES * 8
}

/** Compare two distance buffers lexicographically. */
function distCmp(a: Buffer, b: Buffer): number {
  for (let i = 0; i < ID_BYTES; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

// ── Routing table ─────────────────────────────────────────────────────────────

export class KBucketTable {
  private buckets: DHTContact[][] = Array.from({ length: ID_BYTES * 8 + 1 }, () => [])
  readonly localId: NodeId

  constructor(localId: NodeId) {
    this.localId = localId
  }

  /** Add or refresh a contact. If the bucket is full, drop the oldest entry. */
  upsert(contact: DHTContact): void {
    if (contact.id.equals(this.localId)) return   // don't add self
    const bucket = this._bucket(contact.id)
    const existing = bucket.findIndex(c => c.id.equals(contact.id))
    if (existing >= 0) {
      bucket[existing] = { ...contact, lastSeen: Date.now() }
      return
    }
    if (bucket.length < K) {
      bucket.push({ ...contact, lastSeen: Date.now() })
    } else {
      // Evict oldest — in production Kademlia you would ping first
      bucket.sort((a, b) => a.lastSeen - b.lastSeen)
      bucket[0] = { ...contact, lastSeen: Date.now() }
    }
  }

  remove(id: NodeId): void {
    const bucket = this._bucket(id)
    const idx = bucket.findIndex(c => c.id.equals(id))
    if (idx >= 0) bucket.splice(idx, 1)
  }

  /** Return up to n contacts closest to target, sorted by XOR distance. */
  closest(target: NodeId, n = K): DHTContact[] {
    return this.buckets
      .flat()
      .sort((a, b) => distCmp(xorDistance(a.id, target), xorDistance(b.id, target)))
      .slice(0, n)
  }

  all(): DHTContact[]  { return this.buckets.flat() }
  size(): number       { return this.buckets.reduce((s, b) => s + b.length, 0) }

  private _bucket(id: NodeId): DHTContact[] {
    const cpl = commonPrefixBits(this.localId, id)
    return this.buckets[Math.min(cpl, this.buckets.length - 1)]
  }
}
