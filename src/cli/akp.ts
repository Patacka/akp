#!/usr/bin/env node
import 'dotenv/config'
import { program } from 'commander'
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { randomBytes } from 'node:crypto'

const AKP_BANNER = `
╭─╮╷╭ ╭─╮
├─┤├┴╮├─╯
╵ ╵╵ ╵╵    Agent Knowledge Protocol v0.1.0
`
import { KUStore } from '../core/store.js'
import { createKU, createProvenance } from '../core/ku.js'
import { generateIdentity } from '../core/identity.js'
import { runPipeline } from '../pipeline/index.js'
import { createRpcServer } from '../api/rpc.js'
import { createJanEntailmentClient } from '../pipeline/stage3-llamacpp.js'
import { createLLMEntailmentChecker } from '../pipeline/stage3-rav.js'
import { createMcpServer } from '../mcp/server.js'
import { SyncPeer } from '../sync/peer.js'
import { DHTPeer } from '../dht/dht.js'
import { seedsFor } from '../dht/seeds.js'
import { v7 as uuidv7 } from 'uuid'

const CONFIG_DIR = join(process.env.HOME ?? process.cwd(), '.akp')
const DEFAULT_DB = process.env.AKP_DB ?? join(CONFIG_DIR, 'akp.db')
const DEFAULT_LOG = process.env.AKP_LOG ?? join(CONFIG_DIR, 'deltas.ndjson')

function getStore(dbPath?: string) {
  const path = dbPath ?? DEFAULT_DB
  mkdirSync(join(path, '..'), { recursive: true })
  const store = new KUStore({ dbPath: path, deltaLogPath: DEFAULT_LOG })
  return { store, graph: store.buildGraph() }
}

program
  .name('akp')
  .description('Agent Knowledge Protocol CLI')
  .version('0.1.0')

program
  .command('init')
  .description('Initialize a new AKP node')
  .option('--dir <path>', 'Node directory', CONFIG_DIR)
  .action(async (opts) => {
    mkdirSync(opts.dir, { recursive: true })
    const identity = await generateIdentity()
    const identityPath = join(opts.dir, 'identity.json')
    const { writeFileSync } = await import('fs')
    writeFileSync(identityPath, JSON.stringify(identity, null, 2))
    console.log(`AKP node initialized at ${opts.dir}`)
    console.log(`DID: ${identity.did}`)
  })

program
  .command('create')
  .description('Create a new Knowledge Unit')
  .requiredOption('--domain <domain>', 'Knowledge domain')
  .option('--file <file>', 'JSON or Markdown file with KU content')
  .option('--title <title>', 'KU title')
  .option('--summary <summary>', 'Brief summary')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (opts) => {
    const { store, graph } = getStore()
    const identity = await generateIdentity()

    let title: Record<string, string> = { en: opts.title ?? 'Untitled' }
    let summary = opts.summary ?? ''

    if (opts.file) {
      const content = readFileSync(resolve(opts.file), 'utf8')
      if (opts.file.endsWith('.json')) {
        const data = JSON.parse(content) as Record<string, unknown>
        title = (data.title as Record<string, string>) ?? title
        summary = (data.summary as string) ?? summary
      } else {
        // Markdown: first line is title, rest is body
        const lines = content.split('\n')
        const firstLine = lines[0].replace(/^#+\s*/, '')
        title = { en: firstLine }
        summary = lines.slice(1, 3).join(' ').trim()
      }
    }

    const prov = createProvenance({
      did: identity.did,
      type: 'human',
      method: 'human_input',
    })

    const ku = createKU({
      domain: opts.domain,
      title,
      summary,
      tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [],
      provenance: prov,
    })

    const result = await runPipeline(ku, graph, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity

    store.create(ku)
    graph.addKU(ku)

    console.log(`Created KU: ${ku.id}`)
    console.log(`Maturity: ${ku.meta.maturity}, Confidence: ${ku.meta.confidence.aggregate.toFixed(3)}`)
    store.close()
  })

program
  .command('query <text>')
  .description('Search knowledge units (supports full-text search)')
  .option('--domain <domain>', 'Filter by domain')
  .option('--min-confidence <n>', 'Minimum confidence', '0')
  .option('--limit <n>', 'Max results', '10')
  .action((text, opts) => {
    const { store } = getStore()
    // Use FTS when a search term is provided
    const results = text
      ? store.search(text, { domain: opts.domain, limit: parseInt(opts.limit) })
      : store.query({
          domain: opts.domain,
          minConfidence: parseFloat(opts.minConfidence),
          limit: parseInt(opts.limit),
        })

    if (results.length === 0) {
      console.log('No results found.')
    } else {
      for (const ku of results) {
        const title = Object.values(ku.meta.title)[0] ?? 'Untitled'
        console.log(`[${ku.meta.maturity}] ${ku.id} — ${title}`)
        console.log(`  Domain: ${ku.meta.domain} | Confidence: ${ku.meta.confidence.aggregate.toFixed(3)}`)
        if (ku.narrative.summary) {
          console.log(`  ${ku.narrative.summary.slice(0, 100)}...`)
        }
        console.log()
      }
    }
    store.close()
  })

program
  .command('read <kuId>')
  .description('Read a Knowledge Unit')
  .option('--format <format>', 'Output format: json|md', 'json')
  .action((kuId, opts) => {
    const { store } = getStore()
    const ku = store.read(kuId)

    if (!ku) {
      console.error(`KU not found: ${kuId}`)
      process.exit(1)
    }

    if (opts.format === 'md') {
      const title = Object.values(ku.meta.title)[0] ?? 'Untitled'
      console.log(`# ${title}`)
      console.log()
      console.log(`**Domain:** ${ku.meta.domain} | **Maturity:** ${ku.meta.maturity} | **Confidence:** ${ku.meta.confidence.aggregate.toFixed(3)}`)
      console.log()
      console.log(ku.narrative.summary)
      console.log()
      if (ku.structured.claims.length > 0) {
        console.log('## Claims')
        for (const claim of ku.structured.claims) {
          console.log(`- [${claim.type}] ${claim.subject} ${claim.predicate} ${JSON.stringify(claim.object)}`)
        }
      }
    } else {
      console.log(JSON.stringify(ku, null, 2))
    }
    store.close()
  })

program
  .command('review <kuId>')
  .description('Submit a review for a Knowledge Unit')
  .requiredOption('--verdict <verdict>', 'Verdict: confirmed|amended|disputed|rejected')
  .option('--claims <ids>', 'Comma-separated claim IDs (default: all)')
  .action(async (kuId, opts) => {
    const { store, graph } = getStore()
    const ku = store.read(kuId)
    if (!ku) {
      console.error(`KU not found: ${kuId}`)
      process.exit(1)
    }

    const identity = await generateIdentity()
    const claimIds = opts.claims
      ? opts.claims.split(',').map((s: string) => s.trim())
      : ku.structured.claims.map(c => c.id)

    const review = {
      id: uuidv7(),
      reviewerDid: identity.did,
      reviewerType: 'human' as const,
      timestamp: new Date().toISOString(),
      verdict: opts.verdict as 'confirmed' | 'amended' | 'disputed' | 'rejected',
      scope: claimIds,
      weight: 0.7,
    }

    store.update(kuId, (k) => { k.reviews.push(review) }, 'add_review')
    const updated = store.read(kuId)!
    const result = await runPipeline(updated, graph, { mockStage1: true })
    store.update(kuId, (k) => {
      k.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
      k.meta.maturity = result.maturity
    }, 'update_confidence')

    console.log(`Review submitted for ${kuId}`)
    console.log(`New confidence: ${result.confidence.aggregate.toFixed(3)}, Maturity: ${result.maturity}`)
    store.close()
  })

program
  .command('start')
  .description('Start the AKP node (JSON-RPC + MCP HTTP + sync peer)')
  .option('--port <port>', 'API port', process.env.PORT ?? '3000')
  .option('--mcp', 'Start MCP server on stdio only (no HTTP API)')
  .option('--no-mcp-http', 'Disable MCP HTTP endpoint (served at /mcp by default)')
  .option('--mcp-path <path>', 'Path for MCP HTTP endpoint', '/mcp')
  .option('--mock-stage1', 'Skip real source URL verification (dev mode)')
  .option('--governance-interval <ms>', 'Governance finalization interval in ms', '300000')
  .option('--peers <urls>', 'Comma-separated peer WebSocket URLs to connect to')
  .option('--network <id>', 'Network identifier: mainnet|testnet|devnet (default: mainnet)', process.env.AKP_NETWORK_ID ?? 'mainnet')
  .option('--min-version <semver>', 'Minimum peer version to accept (default: 0.1.0)', process.env.AKP_MIN_PEER_VERSION ?? '0.1.0')
  .option('--no-dht', 'Disable Kademlia DHT peer discovery')
  .option('--public-http-url <url>', 'Public HTTP base URL (enables full DHT participation, e.g. http://myserver:3000)', process.env.PUBLIC_HTTP_URL)
  .option('--public-sync-url <url>', 'Public WebSocket URL (enables full DHT participation, e.g. ws://myserver:3001)', process.env.PUBLIC_SYNC_URL)
  .action(async (opts) => {
    console.log(AKP_BANNER)

    // Auto-generate API key if not set
    if (!process.env.AKP_API_KEY) {
      const key = randomBytes(32).toString('hex')
      process.env.AKP_API_KEY = key
      console.log(`Generated API key (not persisted — set AKP_API_KEY to fix it):`)
      console.log(`  AKP_API_KEY=${key}\n`)
    }

    // Auto-init identity if this is the first run
    const identityPath = join(CONFIG_DIR, 'identity.json')
    if (!existsSync(identityPath)) {
      console.log('First run — initializing node identity...')
      mkdirSync(CONFIG_DIR, { recursive: true })
      const identity = await generateIdentity()
      const { writeFileSync } = await import('fs')
      writeFileSync(identityPath, JSON.stringify(identity, null, 2))
      console.log(`DID: ${identity.did}`)
    }

    const { store, graph } = getStore()

    if (opts.mcp) {
      const { startStdio } = createMcpServer({ store, graph })
      await startStdio()
      return
    }

    // Auto-enable RAV if Jan is reachable
    let entailmentChecker
    if (process.env.JAN_BASE_URL || !opts.mockStage1) {
      try {
        const client = await createJanEntailmentClient()
        entailmentChecker = createLLMEntailmentChecker(client)
        console.log('RAV entailment checker: enabled (Jan)')
      } catch {
        // Jan not available — RAV disabled
      }
    }

    const { app, listen, close } = createRpcServer({
      store, graph,
      port: parseInt(opts.port),
      mockStage1: Boolean(opts.mockStage1),
      entailmentChecker,
    })

    // DHT peer — every node participates by default (BitTorrent-style)
    // Full peer: mounts /dht/* routes + announces itself (requires public URLs)
    // Outbound-only: queries DHT to find peers, but doesn't serve routes
    let dhtPeer: DHTPeer | undefined
    if (opts.dht !== false) {
      const identity = JSON.parse(
        (await import('fs')).readFileSync(identityPath, 'utf8')
      ) as { did: string }
      dhtPeer = new DHTPeer({
        did:       identity.did,
        syncUrl:   opts.publicSyncUrl ?? '',
        httpUrl:   opts.publicHttpUrl ?? '',
        networkId: opts.network,
      })
      if (opts.publicHttpUrl) {
        dhtPeer.mount(app)
        console.log(`DHT:   full peer  httpUrl=${opts.publicHttpUrl}  syncUrl=${opts.publicSyncUrl ?? ''}`)
      } else {
        console.log(`DHT:   outbound-only (set --public-http-url + --public-sync-url to become a full peer)`)
      }
    }

    // Mount MCP over HTTP on the same Express app unless disabled
    if (opts.mcpHttp !== false) {
      const { mountHttp } = createMcpServer({ store, graph })
      mountHttp(app, opts.mcpPath)
      console.log(`MCP HTTP endpoint: http://0.0.0.0:${opts.port}${opts.mcpPath}`)
    }

    listen()
    console.log(`Network: ${opts.network}  |  Node version: 0.1.0  |  Min peer version: ${opts.minVersion}`)

    // Sync peer: keeps in-memory graph current as gossip arrives
    const syncIdentity = existsSync(identityPath)
      ? JSON.parse(readFileSync(identityPath, 'utf8')) as { did: string; privateKeyHex: string; publicKeyHex: string }
      : undefined
    const syncPeer = new SyncPeer({
      store,
      port: parseInt(opts.port) + 1,
      identity: syncIdentity,
      requireAuth: true,
      maxMsgPerSecond: 200,
      onKUSynced: (ku) => graph.addKU(ku),
      version: '0.1.0',
      minVersion: opts.minVersion,
      networkId: opts.network,
    })
    syncPeer.startServer()

    // Auto-connect to configured peers (AKP_PEERS=ws://node2:3001,ws://node3:3001)
    const peers = (process.env.AKP_PEERS ?? opts.peers ?? '').split(',').map((p: string) => p.trim()).filter(Boolean)
    for (const peerUrl of peers) {
      syncPeer.connectTo(peerUrl).then(() => {
        console.log(`Connected to peer: ${peerUrl}`)
      }).catch((err: Error) => {
        console.warn(`Could not connect to peer ${peerUrl}: ${err.message}`)
      })
    }

    // DHT bootstrap: seed routing table, discover peers, announce self
    if (dhtPeer) {
      const dht = dhtPeer
      const seeds = seedsFor(opts.network)
      const peerList = (process.env.AKP_PEERS ?? opts.peers ?? '').split(',').map((p: string) => p.trim()).filter(Boolean)
      const seedHttpUrls = [
        ...seeds.map(s => s.httpUrl),
        ...peerList.map((url: string) =>
          url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
        ),
      ]
      if (seedHttpUrls.length > 0) {
        dht.bootstrap(seedHttpUrls).then(async () => {
          const discovered = await dht.findPeers()
          for (const url of discovered) {
            syncPeer.connectTo(url).catch(() => { /* non-fatal */ })
          }
          await dht.announce()
          console.log(`DHT bootstrap complete — ${dht.routingTableSize()} contacts, ${discovered.length} sync peers found`)
        }).catch(() => { /* offline — retry not needed, DHT is best-effort */ })
      }

      // Re-announce every 30 minutes
      const announceInterval = setInterval(() => {
        dht.announce().catch(() => {})
      }, 30 * 60 * 1000)
      announceInterval.unref()
    }

    // Governance finalization scheduler
    const govInterval = setInterval(async () => {
      try {
        const results = store.finalizeExpired()
        if (results.length > 0) {
          console.log(`[governance] Finalized ${results.length} proposal(s):`, results)
        }
      } catch (e) {
        console.error('[governance] Finalization error:', e)
      }
    }, parseInt(opts.governanceInterval))
    govInterval.unref()  // don't prevent process exit

    // Graceful shutdown
    let shuttingDown = false
    const shutdown = () => {
      if (shuttingDown) return
      shuttingDown = true
      console.log('\nShutting down...')
      clearInterval(govInterval)
      syncPeer.close()
      close()
      // Give in-flight HTTP requests up to 5 s to complete
      setTimeout(() => process.exit(0), 5000).unref()
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })

program
  .command('bench')
  .description('Run benchmark suite')
  .action(async () => {
    const { default: runBenchmarks } = await import('../bench/report.js')
    await runBenchmarks()
  })

program
  .command('backup')
  .description('Back up the AKP SQLite database to a file')
  .option('--db <path>', 'Source database path', DEFAULT_DB)
  .option('--out <path>', 'Backup destination path (default: <db>.backup-<timestamp>.db)')
  .action(async (opts) => {
    const src = resolve(opts.db)
    if (!existsSync(src)) {
      console.error(`Database not found: ${src}`)
      process.exit(1)
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = resolve(opts.out ?? `${src}.backup-${ts}.db`)
    mkdirSync(join(dest, '..'), { recursive: true })
    copyFileSync(src, dest)
    console.log(`Backup saved to ${dest}`)
  })

program
  .command('restore')
  .description('Restore the AKP database from a backup file')
  .argument('<backup>', 'Path to backup file')
  .option('--db <path>', 'Destination database path', DEFAULT_DB)
  .option('--force', 'Overwrite existing database without prompting')
  .action(async (backup, opts) => {
    const src = resolve(backup)
    if (!existsSync(src)) {
      console.error(`Backup file not found: ${src}`)
      process.exit(1)
    }
    const dest = resolve(opts.db)
    if (existsSync(dest) && !opts.force) {
      console.error(`Database already exists at ${dest}. Use --force to overwrite.`)
      process.exit(1)
    }
    mkdirSync(join(dest, '..'), { recursive: true })
    copyFileSync(src, dest)
    console.log(`Database restored from ${src} to ${dest}`)
  })

program.parse()
