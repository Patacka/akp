/**
 * peer.ts — WebSocket sync peer with optional Ed25519 challenge-response auth.
 *
 * Auth flow (when server has requireAuth: true):
 *   1. Server sends {type:'challenge', nonce}
 *   2. Client signs "nonce:clientDid" with Ed25519
 *   3. Client sends {type:'auth', did, signature}
 *   4. Server verifies; on success sends {type:'auth_ok'}
 *   5. Both sides continue with hello / request_ids / sync
 *
 * Client state machine (single message handler, no nested listeners):
 *   'handshake' → waiting for challenge or first sync message
 *   'syncing'   → full sync protocol active
 *
 * requireAuth defaults to false for backward compatibility.
 */

import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { KUStore } from '../core/store.js'
import type { KnowledgeUnit } from '../core/ku.js'
import * as Automerge from '@automerge/automerge'
import type { Identity } from '../core/identity.js'
import { extractPublicKeyFromDid } from '../core/identity.js'
import * as ed from '@noble/ed25519'

export interface SyncPeerOptions {
  store: KUStore
  port?: number
  /** Identity used to authenticate outbound connections and label the node */
  identity?: Identity
  /**
   * Require inbound connections to pass Ed25519 challenge-response before syncing.
   * Default: true. Set false only in trusted local dev environments.
   */
  requireAuth?: boolean
  /**
   * Maximum allowed size of a single incoming WebSocket message in bytes.
   * Protects against OOM from oversized Automerge payloads.
   * Default: 10 MB.
   */
  maxMessageBytes?: number
  /**
   * Called whenever a KU is created or updated via gossip sync.
   * Use to keep an in-memory RelationGraph in sync without a full rebuild.
   * Example: onKUSynced: (ku) => graph.addKU(ku)
   */
  onKUSynced?: (ku: KnowledgeUnit) => void
  /**
   * Maximum sync messages accepted per peer per second before the connection
   * is closed with code 1008 (policy violation). Default: 20.
   */
  maxMsgPerSecond?: number
  /**
   * Semver version of this node, announced in hello and checked against peers.
   * Default: "0.1.0"
   */
  version?: string
  /**
   * Minimum peer version accepted. Peers advertising a lower version are
   * rejected with close code 4426. Default: "0.1.0"
   */
  minVersion?: string
  /**
   * Network identifier. Peers on a different network are rejected with close
   * code 4400. Use "mainnet" | "testnet" | "devnet" or any custom string.
   * Default: "mainnet"
   */
  networkId?: string
}

// WebSocket close codes (4000-4999 are application-defined)
export const WS_CLOSE_NETWORK_MISMATCH = 4400  // networkId doesn't match — wrong network
export const WS_CLOSE_VERSION_TOO_OLD  = 4426  // peer version below our minVersion (like HTTP 426 Upgrade Required)

type SyncMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'auth'; did: string; signature: string }
  | { type: 'auth_ok' }
  | {
      type: 'hello'
      nodeId: string
      did?: string
      /** Semver string of this node, e.g. "0.1.0" */
      version?: string
      /** Lowest peer version this node will accept, e.g. "0.1.0" */
      minVersion?: string
      /** Network identifier — nodes refuse connections from a different network */
      networkId?: string
    }
  | { type: 'request_ids' }
  | { type: 'ids_response'; ids: string[] }
  | { type: 'sync'; kuId: string; data: string }

/** Compare two semver strings. Returns true if a >= b. Non-semver strings compare as equal. */
function semverGte(a: string, b: string): boolean {
  const parse = (s: string) => s.split('.').map(n => parseInt(n, 10) || 0)
  const [aMaj, aMin, aPat] = parse(a)
  const [bMaj, bMin, bPat] = parse(b)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPat >= bPat
}

export class SyncPeer {
  private wss?: WebSocketServer
  private store: KUStore
  private port: number
  private syncStates: Map<string, Map<string, Automerge.SyncState>> = new Map()
  private nodeId: string
  private identity?: Identity
  private requireAuth: boolean
  private maxMessageBytes: number
  private onKUSynced?: (ku: KnowledgeUnit) => void
  private maxMsgPerSecond: number
  private version: string
  private minVersion: string
  private networkId: string
  /** Per-peer token buckets for sync flood protection */
  private peerBuckets: Map<string, { count: number; windowStart: number }> = new Map()

  constructor(options: SyncPeerOptions) {
    this.store = options.store
    this.port = options.port ?? 3001
    this.identity = options.identity
    this.requireAuth = options.requireAuth ?? true
    this.maxMessageBytes = options.maxMessageBytes ?? 10 * 1024 * 1024
    this.onKUSynced = options.onKUSynced
    this.maxMsgPerSecond = options.maxMsgPerSecond ?? 20
    this.version = options.version ?? '0.1.0'
    this.minVersion = options.minVersion ?? '0.1.0'
    this.networkId = options.networkId ?? 'mainnet'
    this.nodeId = options.identity?.did ?? Math.random().toString(36).slice(2)
  }

  /** Returns false if the peer has exceeded the per-second message budget. */
  private _checkRateLimit(peerId: string): boolean {
    const now = Date.now()
    const bucket = this.peerBuckets.get(peerId)
    if (!bucket || now - bucket.windowStart >= 1000) {
      this.peerBuckets.set(peerId, { count: 1, windowStart: now })
      return true
    }
    bucket.count++
    return bucket.count <= this.maxMsgPerSecond
  }

  startServer() {
    this.wss = new WebSocketServer({ port: this.port })

    const ipConnections = new Map<string, number>()
    const MAX_CONNECTIONS_PER_IP = 5

    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress ?? 'unknown'
      const current = ipConnections.get(ip) ?? 0
      if (current >= MAX_CONNECTIONS_PER_IP) {
        ws.close(1008, 'too many connections from this IP')
        return
      }
      ipConnections.set(ip, current + 1)
      ws.on('close', () => {
        const n = (ipConnections.get(ip) ?? 1) - 1
        if (n <= 0) ipConnections.delete(ip)
        else ipConnections.set(ip, n)
      })
      this._handleInbound(ws)
    })

    return this.wss
  }

  connectTo(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.on('open', () => {
        this._handleOutbound(ws, resolve, reject)
      })
      ws.on('error', reject)
    })
  }

  // ── Inbound (server side) ───────────────────────────────────────────────────

  private _handleInbound(ws: WebSocket) {
    if (!this.requireAuth) {
      const peerId = Math.random().toString(36).slice(2)
      this._beginSync(ws, peerId)
      return
    }

    // Auth-required: send challenge, wait for auth response
    const nonce = randomBytes(32).toString('hex')
    let authenticated = false
    let peerId = ''

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4401, 'auth timeout')
    }, 10_000)

    this._send(ws, { type: 'challenge', nonce })

    ws.on('message', async (raw) => {
      try {
        if (Buffer.byteLength(raw as Buffer) > this.maxMessageBytes) {
          ws.close(1009, 'message too large')
          return
        }
        const msg = JSON.parse(raw.toString()) as SyncMessage

        if (!authenticated) {
          if (msg.type !== 'auth') { ws.close(4401, 'expected auth'); return }
          const valid = await this._verifyAuth(nonce, msg.did, msg.signature)
          if (!valid) { ws.close(4401, 'invalid signature'); return }
          clearTimeout(authTimeout)
          authenticated = true
          peerId = msg.did
          this._send(ws, { type: 'auth_ok' })
          this._beginSync(ws, peerId)  // will add its own listener — that's fine, both fire
          return
        }
        // Post-auth messages are handled by the listener added in _beginSync
      } catch (e) {
        console.error('Inbound message error:', e)
      }
    })
  }

  private async _verifyAuth(nonce: string, did: string, signature: string): Promise<boolean> {
    try {
      const publicKeyHex = extractPublicKeyFromDid(did)
      const publicKey = ed.etc.hexToBytes(publicKeyHex)
      const sig = ed.etc.hexToBytes(signature)
      const message = new TextEncoder().encode(`${nonce}:${did}`)
      return await ed.verifyAsync(sig, message, publicKey)
    } catch { return false }
  }

  // ── Outbound (client side) ──────────────────────────────────────────────────
  //
  // Single state-machine message handler — no nested listeners.
  // States: 'handshake' → 'syncing'

  private _handleOutbound(
    ws: WebSocket,
    resolve: (ws: WebSocket) => void,
    reject: (err: Error) => void
  ) {
    const peerId = Math.random().toString(36).slice(2)
    let state: 'handshake' | 'syncing' = 'handshake'
    let settled = false

    const settle = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(ws)
    }

    const timeout = setTimeout(() => settle(new Error('Handshake timeout')), 15_000)

    ws.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 4401) settle(new Error(`Auth rejected by server (4401)`))
      else settle(new Error(`Connection closed during handshake (code ${code})`))
    })

    ws.on('message', async (raw) => {
      try {
        if (Buffer.byteLength(raw as Buffer) > this.maxMessageBytes) {
          ws.close(1009, 'message too large')
          settle(new Error('Server sent oversized message'))
          return
        }
        const msg = JSON.parse(raw.toString()) as SyncMessage

        if (state === 'handshake') {
          if (msg.type === 'challenge') {
            if (!this.identity) {
              ws.close(4401, 'no identity')
              clearTimeout(timeout)
              settle(new Error('Server requires auth but SyncPeer has no identity'))
              return
            }
            const privateKey = ed.etc.hexToBytes(this.identity.privateKeyHex)
            const message = new TextEncoder().encode(`${msg.nonce}:${this.identity.did}`)
            const sig = await ed.signAsync(message, privateKey)
            this._send(ws, { type: 'auth', did: this.identity.did, signature: ed.etc.bytesToHex(sig) })
            return
          }

          if (msg.type === 'auth_ok') {
            state = 'syncing'
            clearTimeout(timeout)
            settle()
            this._beginSyncInitiate(ws, peerId)
            return
          }

          // Server doesn't use auth — first message is hello/request_ids/etc.
          // Process it AND kick off our side of the sync protocol.
          if (msg.type === 'hello' || msg.type === 'request_ids' || msg.type === 'ids_response' || msg.type === 'sync') {
            state = 'syncing'
            clearTimeout(timeout)
            settle()
            this._handleMessage(ws, peerId, msg)
            this._beginSyncInitiate(ws, peerId)  // send hello + request_ids to server
            return
          }
          return
        }

        // state === 'syncing'
        this._handleMessage(ws, peerId, msg)
      } catch (e) {
        console.error('Outbound message error:', e)
      }
    })

    // If server requires no auth, we need to kick things off
    // But we can't know yet — wait for server's first message.
    // The server always speaks first (sends hello or challenge).
  }

  // ── Core sync ─────────────────────────────────────────────────────────────

  /** Validate a received hello message. Returns an error string or null if OK. */
  private _checkHello(msg: Extract<SyncMessage, { type: 'hello' }>): string | null {
    if (msg.networkId && msg.networkId !== this.networkId) {
      return `network mismatch: peer="${msg.networkId}" local="${this.networkId}"`
    }
    if (msg.version && !semverGte(msg.version, this.minVersion)) {
      return `version too old: peer="${msg.version}" minVersion="${this.minVersion}"`
    }
    return null
  }

  /** Server-side: start syncing with an already-connected, optionally auth'd peer */
  private _beginSync(ws: WebSocket, peerId: string) {
    this._send(ws, { type: 'hello', nodeId: this.nodeId, did: this.identity?.did, version: this.version, minVersion: this.minVersion, networkId: this.networkId })
    this._send(ws, { type: 'request_ids' })

    ws.on('message', (data) => {
      try {
        if (Buffer.byteLength(data as Buffer) > this.maxMessageBytes) {
          ws.close(1009, 'message too large')
          return
        }
        const msg = JSON.parse(data.toString()) as SyncMessage
        this._handleMessage(ws, peerId, msg)
      } catch (e) {
        console.error('Sync message parse error:', e)
      }
    })
  }

  /** Client-side: initiate sync after auth_ok (or no-auth handshake) */
  private _beginSyncInitiate(ws: WebSocket, peerId: string) {
    this._send(ws, { type: 'hello', nodeId: this.nodeId, did: this.identity?.did, version: this.version, minVersion: this.minVersion, networkId: this.networkId })
    this._send(ws, { type: 'request_ids' })
    // Message handler already registered in _handleOutbound — no new listener needed
  }

  private _handleMessage(ws: WebSocket, peerId: string, msg: SyncMessage) {
    // Token-bucket flood protection
    if (!this._checkRateLimit(peerId)) {
      ws.close(1008, 'sync rate limit exceeded')
      return
    }

    switch (msg.type) {
      case 'hello': {
        const err = this._checkHello(msg)
        if (err) {
          const code = err.startsWith('network') ? WS_CLOSE_NETWORK_MISMATCH : WS_CLOSE_VERSION_TOO_OLD
          console.warn(`[sync] Rejected peer ${peerId}: ${err}`)
          ws.close(code, err)
        }
        break
      }

      case 'request_ids':
        this._send(ws, { type: 'ids_response', ids: this.store.allIds() })
        break

      case 'ids_response':
        for (const kuId of msg.ids) this._initSync(ws, peerId, kuId)
        break

      case 'sync':
        if (msg.kuId && msg.data) {
          const binary = Buffer.from(msg.data, 'base64')
          const syncState = this._getSyncState(msg.kuId, peerId)
          const [newSyncState, changed] = this.store.receiveSyncMessage(msg.kuId, syncState, new Uint8Array(binary))
          this._setSyncState(msg.kuId, peerId, newSyncState)
          this._sendSyncMessages(ws, peerId, msg.kuId)
          // Notify caller so in-memory graph stays current
          if (changed && this.onKUSynced) {
            const ku = this.store.read(msg.kuId)
            if (ku) this.onKUSynced(ku)
          }
        }
        break
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _send(ws: WebSocket, msg: SyncMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private _getSyncState(kuId: string, peerId: string): Automerge.SyncState {
    return (this.syncStates.get(kuId) ?? new Map<string, Automerge.SyncState>()).get(peerId) ?? Automerge.initSyncState()
  }

  private _setSyncState(kuId: string, peerId: string, state: Automerge.SyncState) {
    if (!this.syncStates.has(kuId)) this.syncStates.set(kuId, new Map())
    this.syncStates.get(kuId)!.set(peerId, state)
  }

  private _initSync(ws: WebSocket, peerId: string, kuId: string) {
    this._sendSyncMessages(ws, peerId, kuId)
  }

  private _sendSyncMessages(ws: WebSocket, peerId: string, kuId: string) {
    const syncState = this._getSyncState(kuId, peerId)
    const [newSyncState, message] = this.store.generateSyncMessages(kuId, syncState)
    this._setSyncState(kuId, peerId, newSyncState)
    if (message) {
      this._send(ws, { type: 'sync', kuId, data: Buffer.from(message).toString('base64') })
    }
  }

  close() {
    this.wss?.close()
    this.peerBuckets.clear()
  }
}
