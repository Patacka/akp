/**
 * relay.ts — Minimal AKP relay node.
 *
 * A relay is a lightweight always-on peer that:
 *   - Accepts inbound WebSocket connections from agents
 *   - Syncs KUs bidirectionally (accumulates network knowledge over time)
 *   - Maintains a persistent identity (same DID across restarts)
 *   - Optionally exposes the JSON-RPC API for read access
 *
 * Relays are the "seed nodes" of the AKP P2P network. At least one relay
 * must be reachable for a new agent to bootstrap into the network.
 *
 * Deploy on Fly.io (recommended — WebSocket + persistent volume):
 *   fly launch   # provisions app + 1 GB volume at /data
 *   fly secrets set AKP_NETWORK_ID=mainnet
 *   fly deploy
 *
 * Or locally:
 *   npm run relay
 *
 * Environment variables:
 *   SYNC_PORT    WebSocket port (default: 3001)
 *   PORT         HTTP RPC port, 0 = disabled (default: 0)
 *   DATA_DIR     Directory for identity.json + store.db (default: ./.akp-relay)
 *   NETWORK_ID   Network identifier (default: mainnet)
 *   LOG_LEVEL    debug | info | warn (default: info)
 */

import { AKPNode } from './node.js'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const syncPort  = parseInt(process.env.SYNC_PORT  ?? '3001')
const httpPort  = parseInt(process.env.PORT       ?? '0')
const networkId = process.env.NETWORK_ID          ?? 'mainnet'
const dataDir   = process.env.DATA_DIR            ?? join(process.cwd(), '.akp-relay')

mkdirSync(dataDir, { recursive: true })

const node = await AKPNode.start({
  identityPath: join(dataDir, 'identity.json'),
  store:        join(dataDir, 'store.db'),
  syncPort,
  port:         httpPort,
  networkId,
})

console.log(`AKP relay node started`)
console.log(`  DID:      ${node.did}`)
console.log(`  Sync WS:  ws://0.0.0.0:${syncPort}  (network: ${networkId})`)
if (httpPort > 0) {
  console.log(`  RPC HTTP: http://0.0.0.0:${httpPort}/rpc`)
}
console.log(`  Store:    ${dataDir}/store.db`)
console.log()
console.log(`Agents bootstrap with:`)
console.log(`  AKPNode.start({ bootstrap: ['wss://<this-host>'] })`)

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down relay...')
  node.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
