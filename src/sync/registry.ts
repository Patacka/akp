/**
 * registry.ts — Lightweight HTTP bootstrap registry for AKP peer discovery.
 *
 * Peers POST their address on startup and GET a list of recently-active peers.
 * The registry is intentionally simple and stateless beyond an in-memory table;
 * it is designed to be run as a community-hosted service or co-located with a
 * trusted AKP node.
 *
 * Endpoints:
 *   POST /peers          { nodeId, did, syncUrl }  → 200 { ok: true }
 *   GET  /peers          → 200 { peers: PeerEntry[] }
 *   GET  /health         → 200 { ok: true, count: number }
 *
 * Run standalone:
 *   npx tsx src/sync/registry.ts [--port 3002] [--ttl 3600]
 */

import express from 'express'
import { z } from 'zod'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Registry-side peer record (URL-based, suitable for the bootstrap service). */
export interface RegistryEntry {
  nodeId: string
  did: string
  syncUrl: string
  registeredAt: string   // ISO timestamp
  lastSeenAt: string     // ISO timestamp (refreshed on re-registration)
}

// ── Validation ────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  nodeId: z.string().min(1).max(128),
  did:     z.string().startsWith('did:').max(256),
  syncUrl: z.string().url().max(512),
})

// Block RFC-1918 / loopback / link-local to prevent SSRF forwarding
const PRIVATE_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fe80:/i,
]

function isPublicUrl(url: string): boolean {
  return !PRIVATE_PATTERNS.some(p => p.test(url))
}

// ── Registry store ─────────────────────────────────────────────────────────────

export class BootstrapRegistry {
  private peers = new Map<string, RegistryEntry>()
  private readonly ttlMs: number

  constructor(ttlSeconds = 3600) {
    this.ttlMs = ttlSeconds * 1000
  }

  register(nodeId: string, did: string, syncUrl: string): void {
    const now = new Date().toISOString()
    const existing = this.peers.get(nodeId)
    this.peers.set(nodeId, {
      nodeId,
      did,
      syncUrl,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
    })
  }

  list(excludeNodeId?: string): RegistryEntry[] {
    const cutoff = Date.now() - this.ttlMs
    const active: RegistryEntry[] = []
    for (const [id, entry] of this.peers) {
      if (new Date(entry.lastSeenAt).getTime() < cutoff) {
        this.peers.delete(id)  // evict stale
        continue
      }
      if (id !== excludeNodeId) active.push(entry)
    }
    return active
  }

  count(): number { return this.peers.size }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

export function createRegistryServer(registry: BootstrapRegistry): express.Express {
  const app = express()
  app.use(express.json({ limit: '16kb' }))

  // POST /peers — register or refresh a peer
  app.post('/peers', (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload', details: parsed.error.issues })
      return
    }
    const { nodeId, did, syncUrl } = parsed.data
    if (!isPublicUrl(syncUrl)) {
      res.status(400).json({ error: 'syncUrl must be a public address' })
      return
    }
    registry.register(nodeId, did, syncUrl)
    res.json({ ok: true })
  })

  // GET /peers — list active peers (exclude the caller if they send X-Node-Id)
  app.get('/peers', (req, res) => {
    const exclude = typeof req.headers['x-node-id'] === 'string'
      ? req.headers['x-node-id']
      : undefined
    res.json({ peers: registry.list(exclude) })
  })

  // GET /health
  app.get('/health', (_req, res) => {
    res.json({ ok: true, count: registry.count() })
  })

  return app
}

// ── Client helper (used by discovery.ts bootstrapFromRegistry) ────────────────

export interface RegistryConfig {
  url: string       // e.g. "https://registry.akp.example/peers"
  nodeId: string
  did: string
  syncUrl: string
}

/**
 * Register with a remote registry and return its peer list.
 * Returns [] on any network or parse error (non-fatal).
 */
export async function registerAndFetch(
  config: RegistryConfig,
  timeoutMs = 5000,
): Promise<RegistryEntry[]> {
  try {
    // Register self
    await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: config.nodeId, did: config.did, syncUrl: config.syncUrl }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Fetch peer list
    const res = await fetch(config.url, {
      headers: { 'X-Node-Id': config.nodeId },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return []
    const data = await res.json() as { peers?: unknown }
    if (!Array.isArray(data.peers)) return []
    return data.peers as RegistryEntry[]
  } catch {
    return []
  }
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('registry.ts') || process.argv[1]?.endsWith('registry.js')) {
  const args = process.argv.slice(2)
  const getArg = (flag: string, def: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : def
  }
  const port = parseInt(getArg('--port', '3002'))
  const ttl  = parseInt(getArg('--ttl',  '3600'))

  const registry = new BootstrapRegistry(ttl)
  const app = createRegistryServer(registry)
  app.listen(port, () => {
    console.log(`AKP Bootstrap Registry listening on :${port}  (peer TTL ${ttl}s)`)
  })
}
