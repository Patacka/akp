import * as Automerge from '@automerge/automerge'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { KnowledgeUnit } from './ku.js'
import { validateKU, createKU, createProvenance } from './ku.js'
import { RelationGraph, type GraphEdgeRow, type GraphClaimRow, type GraphEntityRow } from './graph.js'
import { normalizePredicateAlias } from './predicate-aliases.js'
import {
  type Proposal,
  type Vote,
  type GovernanceState,
  type GovernanceParameters,
  ProposalSchema,
  VoteSchema,
  GovernanceParametersSchema,
  GovernanceStateSchema,
  GovernanceEngine,
  tallyVotes,
  createDefaultGovernanceState,
  canonicalProposalPayload,
  canonicalVotePayload,
} from './governance.js'
import { extractPublicKeyFromDid, verifyBytes } from './identity.js'

export interface DeltaLogEntry {
  op: string
  kuId: string
  deltaBytes: number
  docSizeBefore: number
  docSizeAfter: number
  timestamp: string
}

export interface StoreOptions {
  dbPath: string
  deltaLogPath?: string
}

// Automerge document type (mirrors KnowledgeUnit but as Automerge-compatible types)
type AKUDoc = {
  ku: Record<string, unknown>
}

export class KUStore {
  private db: Database.Database
  private docs: Map<string, Automerge.Doc<AKUDoc>> = new Map()
  private deltaLogPath: string | null

  constructor(options: StoreOptions) {
    mkdirSync(join(options.dbPath, '..'), { recursive: true })
    this.db = new Database(options.dbPath)
    this.deltaLogPath = options.deltaLogPath ?? null
    this._initSchema()
    this._loadAll()
  }

  private _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_units (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        maturity TEXT NOT NULL DEFAULT 'draft',
        confidence REAL NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        automerge_binary BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ku_domain ON knowledge_units(domain);
      CREATE INDEX IF NOT EXISTS idx_ku_maturity ON knowledge_units(maturity);
      CREATE INDEX IF NOT EXISTS idx_ku_confidence ON knowledge_units(confidence);

      CREATE TABLE IF NOT EXISTS ku_tags (
        ku_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (ku_id, tag),
        FOREIGN KEY (ku_id) REFERENCES knowledge_units(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tag ON ku_tags(tag);

      CREATE TABLE IF NOT EXISTS ku_lineage (
        child_id TEXT NOT NULL,
        ancestor_id TEXT NOT NULL,
        PRIMARY KEY (child_id, ancestor_id)
      );

      CREATE TABLE IF NOT EXISTS governance_proposals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        proposer_did TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
      );

      CREATE INDEX IF NOT EXISTS idx_gov_proposal_status ON governance_proposals(status);

      CREATE TABLE IF NOT EXISTS governance_votes (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        voter_did TEXT NOT NULL,
        choice TEXT NOT NULL,
        cast_at TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        signature TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES governance_proposals(id),
        UNIQUE (proposal_id, voter_did)
      );

      CREATE INDEX IF NOT EXISTS idx_gov_vote_proposal ON governance_votes(proposal_id);

      CREATE TABLE IF NOT EXISTS governance_parameters (
        singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
        params_json TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS ku_fts USING fts5(
        id UNINDEXED,
        title,
        summary,
        domain UNINDEXED,
        tokenize='porter unicode61'
      );

      -- ── Persistent graph index (Blocker 1) ─────────────────────────────────
      -- Avoids full Automerge deserialization on every restart.
      -- Kept in sync by _persistGraphData() on every create/update/delete.

      CREATE TABLE IF NOT EXISTS graph_edges (
        ku_id       TEXT NOT NULL,
        neighbor_id TEXT NOT NULL,
        PRIMARY KEY (ku_id, neighbor_id)
      );

      CREATE TABLE IF NOT EXISTS graph_claims_index (
        ku_id              TEXT NOT NULL,
        claim_id           TEXT NOT NULL,
        subject_orig       TEXT NOT NULL,
        subject_lc         TEXT NOT NULL,
        predicate_orig     TEXT NOT NULL,
        predicate_canonical TEXT NOT NULL,
        object_val         TEXT NOT NULL,
        claim_type         TEXT NOT NULL,
        valid_from         TEXT,
        valid_until        TEXT,
        PRIMARY KEY (ku_id, claim_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gclaims_subj ON graph_claims_index(subject_lc);
      CREATE INDEX IF NOT EXISTS idx_gclaims_pred ON graph_claims_index(predicate_canonical);

      CREATE TABLE IF NOT EXISTS graph_entities_index (
        ku_id        TEXT NOT NULL,
        entity_label TEXT NOT NULL,
        PRIMARY KEY (ku_id, entity_label)
      );

      -- ── DID reputation / zero-trust entry (Blocker 2) ──────────────────────
      -- New DIDs start at reputation=0, weight=0.0.
      -- Graduation (reputation >= threshold) grants weight=1.0.

      CREATE TABLE IF NOT EXISTS did_reputation (
        did          TEXT PRIMARY KEY,
        reputation   INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        graduated_at  TEXT,
        last_activity TEXT NOT NULL,
        blacklisted   INTEGER NOT NULL DEFAULT 0
      );

      -- ── Commit-reveal for static claims ────────────────────────────────────
      -- Phase 1: reviewer submits Hash(verdict + salt + reviewerDid).
      -- Phase 2: reviewer reveals verdict + salt after window opens.

      CREATE TABLE IF NOT EXISTS review_commits (
        id           TEXT PRIMARY KEY,
        ku_id        TEXT NOT NULL,
        reviewer_did TEXT NOT NULL,
        commit_hash  TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        revealed_at  TEXT,
        verdict      TEXT,
        salt         TEXT,
        valid        INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rcommit_ku ON review_commits(ku_id);
      CREATE INDEX IF NOT EXISTS idx_rcommit_did ON review_commits(reviewer_did);
    `)
  }

  private _loadAll() {
    const rows = this.db.prepare('SELECT id, automerge_binary FROM knowledge_units').all() as Array<{id: string, automerge_binary: Buffer}>
    for (const row of rows) {
      try {
        const doc = Automerge.load<AKUDoc>(new Uint8Array(row.automerge_binary))
        this.docs.set(row.id, doc)
      } catch {
        // Corrupt binary — skip this KU rather than crashing the entire store on startup
        console.warn(`[AKP] Skipping corrupt Automerge binary for KU ${row.id}`)
      }
    }
  }

  private _logDelta(entry: DeltaLogEntry) {
    if (!this.deltaLogPath) return
    appendFileSync(this.deltaLogPath, JSON.stringify(entry) + '\n')
  }

  // ── Graph persistence ──────────────────────────────────────────────────────

  /**
   * Write (or overwrite) all graph-index rows for a KU.
   * Called on every create / update / sync-receive so the tables stay in sync
   * with the Automerge documents and survive process restarts.
   */
  private _persistGraphData(ku: KnowledgeUnit): void {
    const id = ku.id

    // Delete existing rows for this KU
    this.db.prepare('DELETE FROM graph_edges WHERE ku_id = ?').run(id)
    this.db.prepare('DELETE FROM graph_claims_index WHERE ku_id = ?').run(id)
    this.db.prepare('DELETE FROM graph_entities_index WHERE ku_id = ?').run(id)

    // Edges (bidirectional — store both directions)
    const edgeStmt = this.db.prepare(
      'INSERT OR IGNORE INTO graph_edges (ku_id, neighbor_id) VALUES (?, ?)'
    )
    for (const rel of ku.structured.relations) {
      const neighbor = rel.targetKuId !== id ? rel.targetKuId : rel.sourceKuId
      edgeStmt.run(id, neighbor)
      edgeStmt.run(neighbor, id)
    }

    // Claims
    const claimStmt = this.db.prepare(`
      INSERT OR IGNORE INTO graph_claims_index
        (ku_id, claim_id, subject_orig, subject_lc, predicate_orig, predicate_canonical,
         object_val, claim_type, valid_from, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const claim of ku.structured.claims) {
      claimStmt.run(
        id,
        claim.id,
        claim.subject,
        claim.subject.toLowerCase(),
        claim.predicate,
        normalizePredicateAlias(claim.predicate),
        JSON.stringify(claim.object),
        claim.type,
        claim.validFrom ?? null,
        claim.validUntil ?? null,
      )
    }

    // Entities
    const entStmt = this.db.prepare(
      'INSERT OR IGNORE INTO graph_entities_index (ku_id, entity_label) VALUES (?, ?)'
    )
    for (const entity of ku.structured.entities) {
      entStmt.run(id, entity.label.toLowerCase())
    }
  }

  create(ku: KnowledgeUnit, parentId?: string): string {
    const validated = validateKU(ku)

    // Create Automerge doc
    let doc = Automerge.init<AKUDoc>()
    const sizeBefore = 0
    doc = Automerge.change(doc, (d) => {
      d.ku = JSON.parse(JSON.stringify(validated)) as Record<string, unknown>
    })

    const binary = Automerge.save(doc)
    const sizeAfter = binary.byteLength

    this._logDelta({
      op: 'create',
      kuId: validated.id,
      deltaBytes: sizeAfter - sizeBefore,
      docSizeBefore: sizeBefore,
      docSizeAfter: sizeAfter,
      timestamp: new Date().toISOString(),
    })

    // Save to SQLite
    const stmt = this.db.prepare(`
      INSERT INTO knowledge_units (id, domain, maturity, confidence, tags, created, modified, automerge_binary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      validated.id,
      validated.meta.domain,
      validated.meta.maturity,
      validated.meta.confidence.aggregate,
      JSON.stringify(validated.meta.tags),
      validated.meta.created,
      validated.meta.modified,
      Buffer.from(binary)
    )

    // Insert tags
    const tagStmt = this.db.prepare('INSERT OR IGNORE INTO ku_tags (ku_id, tag) VALUES (?, ?)')
    for (const tag of validated.meta.tags) {
      tagStmt.run(validated.id, tag)
    }

    // FTS index
    this.db.prepare('INSERT INTO ku_fts (id, title, summary, domain) VALUES (?, ?, ?, ?)')
      .run(validated.id, JSON.stringify(validated.meta.title), validated.narrative.summary, validated.meta.domain)

    // Persistent graph index
    this._persistGraphData(validated)

    // Track lineage
    if (parentId) {
      const lineageStmt = this.db.prepare('INSERT OR IGNORE INTO ku_lineage (child_id, ancestor_id) VALUES (?, ?)')
      lineageStmt.run(validated.id, parentId)
      // Also inherit parent's ancestors
      const parentAncestors = this.db.prepare('SELECT ancestor_id FROM ku_lineage WHERE child_id = ?').all(parentId) as Array<{ancestor_id: string}>
      for (const { ancestor_id } of parentAncestors) {
        lineageStmt.run(validated.id, ancestor_id)
      }
    }

    this.docs.set(validated.id, doc)
    return validated.id
  }

  /**
   * Supersede an existing KU with a corrected replacement.
   *
   * Creates the new KU (fork of the old), then adds a `superseded_by` relation
   * to the old KU pointing at the new one. The old KU's confidence will be
   * capped at 0.3 by the pipeline on next run; its maturity stays as-is until
   * a governance `maturity_override/demote` proposal passes (or the operator
   * calls it directly).
   *
   * Returns the new KU's id.
   */
  supersede(oldKuId: string, newKu: KnowledgeUnit): string | null {
    const old = this.read(oldKuId)
    if (!old) return null

    // Create the replacement KU (lineage: child of old)
    const newId = this.create(newKu, oldKuId)

    // Add superseded_by relation to the old KU and immediately demote its maturity
    this.update(oldKuId, (ku) => {
      ku.structured.relations.push({
        id: uuidv7(),
        type: 'superseded_by',
        sourceKuId: oldKuId,
        targetKuId: newId,
        confidence: 1.0,
        confirmedBy: [],
      } as unknown as typeof ku.structured.relations[0])
      if (ku.meta.maturity === 'stable' || ku.meta.maturity === 'validated') {
        ku.meta.maturity = 'proposed'
      }
    }, 'supersede')

    return newId
  }

  read(id: string): KnowledgeUnit | null {
    const doc = this.docs.get(id)
    if (!doc) return null
    return doc.ku as unknown as KnowledgeUnit
  }

  update(id: string, updater: (ku: KnowledgeUnit) => void, op = 'update'): boolean {
    const doc = this.docs.get(id)
    if (!doc) return false

    const binaryBefore = Automerge.save(doc)
    const sizeBefore = binaryBefore.byteLength

    const newDoc = Automerge.change(doc, (d) => {
      const ku = d.ku as unknown as KnowledgeUnit
      updater(ku)
      // Directly mutate modified field — avoid spreading Automerge proxies
      ku.meta.modified = new Date().toISOString()
    })

    const binaryAfter = Automerge.save(newDoc)
    const sizeAfter = binaryAfter.byteLength

    // Compute delta
    const changes = Automerge.getChanges(doc, newDoc)

    // Get the actual delta size (last change)
    let deltaBytes = sizeAfter - sizeBefore
    if (changes.length > 0) {
      deltaBytes = changes.reduce((s, c) => s + c.byteLength, 0)
    }

    this._logDelta({
      op,
      kuId: id,
      deltaBytes,
      docSizeBefore: sizeBefore,
      docSizeAfter: sizeAfter,
      timestamp: new Date().toISOString(),
    })

    // Update SQLite index and tags atomically
    const ku = newDoc.ku as unknown as KnowledgeUnit
    const updateTxn = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE knowledge_units SET domain=?, maturity=?, confidence=?, tags=?, modified=?, automerge_binary=?
        WHERE id=?
      `).run(
        ku.meta.domain,
        ku.meta.maturity,
        ku.meta.confidence.aggregate,
        JSON.stringify(ku.meta.tags),
        ku.meta.modified,
        Buffer.from(binaryAfter),
        id
      )
      this.db.prepare('DELETE FROM ku_tags WHERE ku_id = ?').run(id)
      const tagStmt = this.db.prepare('INSERT OR IGNORE INTO ku_tags (ku_id, tag) VALUES (?, ?)')
      for (const tag of ku.meta.tags) {
        tagStmt.run(id, tag)
      }
    })
    updateTxn()

    // Update FTS index: delete old entry, insert fresh one
    this.db.prepare("DELETE FROM ku_fts WHERE id = ?").run(id)
    this.db.prepare('INSERT INTO ku_fts (id, title, summary, domain) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(ku.meta.title), ku.narrative.summary, ku.meta.domain)

    // Keep persistent graph index in sync
    this._persistGraphData(ku)

    // Compact Automerge history when a KU reaches 'stable' maturity.
    // Automerge.load(Automerge.save(doc)) produces a clean snapshot with no
    // change history — the binary stays small regardless of review volume.
    const prevKu = doc.ku as unknown as KnowledgeUnit
    const prevMaturity = prevKu.meta?.maturity
    if (ku.meta.maturity === 'stable' && prevMaturity !== 'stable') {
      const compacted = Automerge.load<AKUDoc>(binaryAfter)
      this.docs.set(id, compacted)
      this._logDelta({ op: 'compact', kuId: id, deltaBytes: 0, docSizeBefore: sizeAfter, docSizeAfter: binaryAfter.byteLength, timestamp: new Date().toISOString() })
    } else {
      this.docs.set(id, newDoc)
    }
    return true
  }

  /**
   * Apply two sequential updates to the same KU atomically.
   * Both Automerge changes + SQLite writes are wrapped in a single transaction.
   * Returns false if the KU does not exist.
   */
  updateAtomic(id: string, updaters: Array<(ku: KnowledgeUnit) => void>, op = 'update_atomic'): boolean {
    if (!this.docs.has(id)) return false
    const txn = this.db.transaction(() => {
      for (const updater of updaters) {
        this.update(id, updater, op)
      }
    })
    txn()
    return true
  }

  delete(id: string): boolean {
    if (!this.docs.has(id)) return false
    this.db.prepare('DELETE FROM knowledge_units WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM ku_tags WHERE ku_id = ?').run(id)
    this.db.prepare("DELETE FROM ku_fts WHERE id = ?").run(id)
    this.db.prepare('DELETE FROM graph_edges WHERE ku_id = ? OR neighbor_id = ?').run(id, id)
    this.db.prepare('DELETE FROM graph_claims_index WHERE ku_id = ?').run(id)
    this.db.prepare('DELETE FROM graph_entities_index WHERE ku_id = ?').run(id)
    this.docs.delete(id)
    return true
  }

  /**
   * Full-text search over KU titles and summaries.
   * Uses SQLite FTS5 (Porter stemmer). Returns matching KUs sorted by BM25 rank.
   */
  search(query: string, params: { domain?: string; limit?: number } = {}): KnowledgeUnit[] {
    let sql = `
      SELECT k.id FROM ku_fts f
      JOIN knowledge_units k ON k.id = f.id
      WHERE ku_fts MATCH ?
    `
    const args: unknown[] = [query]
    if (params.domain) {
      sql += ' AND k.domain = ?'
      args.push(params.domain)
    }
    sql += ' ORDER BY rank LIMIT ?'
    args.push(params.limit ?? 20)

    try {
      const rows = this.db.prepare(sql).all(...args) as Array<{ id: string }>
      return rows.map(r => this.read(r.id)).filter(Boolean) as KnowledgeUnit[]
    } catch {
      // Malformed FTS query — return empty rather than crashing
      return []
    }
  }

  query(params: {
    domain?: string
    minConfidence?: number
    minMaturity?: 'draft' | 'proposed' | 'validated' | 'stable'
    tags?: string[]
    limit?: number
    offset?: number
  }): KnowledgeUnit[] {
    const maturityOrder = ['draft', 'proposed', 'validated', 'stable']

    let sql = 'SELECT DISTINCT k.id FROM knowledge_units k'
    const args: unknown[] = []
    const conditions: string[] = []

    if (params.tags && params.tags.length > 0) {
      sql += ' JOIN ku_tags t ON k.id = t.ku_id'
      conditions.push(`t.tag IN (${params.tags.map(() => '?').join(',')})`)
      args.push(...params.tags)
    }

    if (params.domain) {
      conditions.push('k.domain = ?')
      args.push(params.domain)
    }

    if (params.minConfidence != null) {
      conditions.push('k.confidence >= ?')
      args.push(params.minConfidence)
    }

    if (params.minMaturity) {
      const idx = maturityOrder.indexOf(params.minMaturity)
      const validMaturities = maturityOrder.slice(idx)
      conditions.push(`k.maturity IN (${validMaturities.map(() => '?').join(',')})`)
      args.push(...validMaturities)
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    sql += ' ORDER BY k.confidence DESC'

    if (params.limit) {
      sql += ' LIMIT ?'
      args.push(params.limit)
    }

    if (params.offset) {
      sql += ' OFFSET ?'
      args.push(params.offset)
    }

    const rows = this.db.prepare(sql).all(...args) as Array<{id: string}>
    return rows.map(r => this.read(r.id)).filter(Boolean) as KnowledgeUnit[]
  }

  getLineage(kuId: string): string[] {
    const rows = this.db.prepare('SELECT ancestor_id FROM ku_lineage WHERE child_id = ?').all(kuId) as Array<{ancestor_id: string}>
    return rows.map(r => r.ancestor_id)
  }

  getAutomergeBinary(id: string): Uint8Array | null {
    const doc = this.docs.get(id)
    if (!doc) return null
    return Automerge.save(doc)
  }

  mergeFrom(id: string, binary: Uint8Array): boolean {
    const localDoc = this.docs.get(id)
    if (!localDoc) {
      // New doc from remote
      const remoteDoc = Automerge.load<AKUDoc>(binary)
      const ku = remoteDoc.ku as unknown as KnowledgeUnit
      this.docs.set(id, remoteDoc)
      const bin = Automerge.save(remoteDoc)
      this.db.prepare(`
        INSERT OR REPLACE INTO knowledge_units (id, domain, maturity, confidence, tags, created, modified, automerge_binary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ku.meta.domain, ku.meta.maturity, ku.meta.confidence.aggregate, JSON.stringify(ku.meta.tags), ku.meta.created, ku.meta.modified, Buffer.from(bin))
      return true
    }

    const remoteDoc = Automerge.load<AKUDoc>(binary)
    const merged = Automerge.merge(localDoc, remoteDoc)
    const bin = Automerge.save(merged)
    const ku = merged.ku as unknown as KnowledgeUnit

    this.docs.set(id, merged)
    this.db.prepare(`
      UPDATE knowledge_units SET domain=?, maturity=?, confidence=?, modified=?, automerge_binary=? WHERE id=?
    `).run(ku.meta.domain, ku.meta.maturity, ku.meta.confidence.aggregate, ku.meta.modified, Buffer.from(bin), id)

    return true
  }

  getSyncState(_id: string): Automerge.SyncState {
    return Automerge.initSyncState()
  }

  generateSyncMessages(id: string, syncState: Automerge.SyncState): [Automerge.SyncState, Uint8Array | null] {
    // Use empty doc if we don't have it yet — lets a peer initiate sync for docs it hasn't received
    const doc = this.docs.get(id) ?? Automerge.init<AKUDoc>()
    return Automerge.generateSyncMessage(doc, syncState)
  }

  receiveSyncMessage(id: string, syncState: Automerge.SyncState, message: Uint8Array): [Automerge.SyncState, boolean] {
    let doc = this.docs.get(id)
    let changed = false
    if (!doc) {
      doc = Automerge.init<AKUDoc>()
    }
    const [newDoc, newSyncState] = Automerge.receiveSyncMessage(doc, syncState, message)
    if (newDoc !== doc) {
      const binary = Automerge.save(newDoc)
      const ku = newDoc.ku as unknown as KnowledgeUnit
      if (ku && ku.id) {
        // Validate merged document against schema before persisting —
        // a malicious sync peer can send CRDTs that merge cleanly but violate invariants.
        try {
          validateKU(ku)
        } catch {
          console.warn(`[AKP] Discarding sync KU ${id} — failed schema validation after merge`)
          return [newSyncState, false]
        }
        changed = true
        this.docs.set(id, newDoc)
        this.db.prepare(`
          INSERT OR REPLACE INTO knowledge_units (id, domain, maturity, confidence, tags, created, modified, automerge_binary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, ku.meta?.domain ?? '', ku.meta?.maturity ?? 'draft', ku.meta?.confidence?.aggregate ?? 0, JSON.stringify(ku.meta?.tags ?? []), ku.meta?.created ?? '', ku.meta?.modified ?? '', Buffer.from(binary))
        // Keep graph index in sync for KUs received via gossip sync
        this._persistGraphData(ku)
      }
    }
    return [newSyncState, changed]
  }

  allIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM knowledge_units').all() as Array<{id: string}>
    return rows.map(r => r.id)
  }

  /**
   * Compact a single KU by squashing its Automerge change history into a
   * single snapshot. Reduces storage and speeds up future merges on
   * heavily-edited documents.
   * Returns false if the document does not exist.
   */
  compact(id: string): boolean {
    const doc = this.docs.get(id)
    if (!doc) return false
    // save() serialises the current state; load() drops all change history
    const binary = Automerge.save(doc)
    const compacted = Automerge.load<AKUDoc>(binary)
    this.docs.set(id, compacted)
    this.db.prepare('UPDATE knowledge_units SET automerge_binary = ? WHERE id = ?')
      .run(Buffer.from(binary), id)
    return true
  }

  /**
   * Compact every document in the store.
   * Returns the number of documents compacted.
   * Run periodically (e.g. daily) to keep storage bounded.
   */
  compactAll(): number {
    let count = 0
    for (const id of this.docs.keys()) {
      if (this.compact(id)) count++
    }
    return count
  }

  /**
   * Build a RelationGraph from the persistent graph index tables.
   *
   * Fast path (normal): loads from graph_edges / graph_claims_index / graph_entities_index
   * — no Automerge deserialization required, O(rows) not O(KUs × doc size).
   *
   * Migration path (first run on old DB): any KUs not yet in the graph tables are
   * backfilled by reading their docs and calling _persistGraphData(), then the fast
   * path proceeds normally.
   */
  buildGraph(): RelationGraph {
    // One-time migration: backfill KUs missing from graph tables
    const allIds = this.allIds()
    if (allIds.length > 0) {
      const indexedIds = new Set(
        (this.db.prepare('SELECT DISTINCT ku_id FROM graph_claims_index').all() as Array<{ ku_id: string }>)
          .map(r => r.ku_id)
      )
      for (const id of allIds) {
        if (!indexedIds.has(id)) {
          const ku = this.read(id)
          if (ku) this._persistGraphData(ku)
        }
      }
    }

    // SQLite-backed graph — queries go to the DB, no in-memory Maps loaded.
    // At 100k nodes this saves ~25 MB of heap vs loading all rows.
    return new RelationGraph(this.db)
  }

  // ── DID Reputation (Blocker 2: Cryptographic Sybil Resistance) ───────────────

  /**
   * Register a DID the first time it is seen (INSERT OR IGNORE).
   * All DIDs start at reputation=0, weight=0.0.
   */
  ensureDid(did: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT OR IGNORE INTO did_reputation (did, reputation, review_count, first_seen_at, last_activity)
      VALUES (?, 0, 0, ?, ?)
    `).run(did, now, now)
  }

  /**
   * Adjust a DID's reputation by delta (positive = reward, negative = slash).
   * Negative total → permanent blacklist.
   * First time reaching graduationThreshold → sets graduated_at.
   */
  addReputation(did: string, delta: number): void {
    this.ensureDid(did)
    const row = this.db.prepare(
      'SELECT reputation, graduated_at, blacklisted FROM did_reputation WHERE did = ?'
    ).get(did) as { reputation: number; graduated_at: string | null; blacklisted: number }

    // Blacklisted DIDs cannot recover reputation
    if (row.blacklisted) return

    const newRep = row.reputation + delta
    const now = new Date().toISOString()
    const params = this.getGovernanceParameters()
    const threshold = params.graduationThreshold

    if (newRep < 0) {
      this.db.prepare(
        'UPDATE did_reputation SET reputation = ?, blacklisted = 1, last_activity = ? WHERE did = ?'
      ).run(newRep, now, did)
    } else if (threshold > 0 && newRep >= threshold && !row.graduated_at) {
      // First time crossing the graduation threshold
      this.db.prepare(
        'UPDATE did_reputation SET reputation = ?, graduated_at = ?, last_activity = ? WHERE did = ?'
      ).run(newRep, now, now, did)
    } else {
      this.db.prepare(
        'UPDATE did_reputation SET reputation = ?, last_activity = ? WHERE did = ?'
      ).run(newRep, now, did)
    }
  }

  /**
   * Increment a DID's review_count (called after a review is persisted).
   */
  recordReview(did: string): void {
    this.ensureDid(did)
    this.db.prepare(
      'UPDATE did_reputation SET review_count = review_count + 1, last_activity = ? WHERE did = ?'
    ).run(new Date().toISOString(), did)
  }

  /**
   * Returns the effective review/governance weight for a DID.
   * 0.0  — DID unknown, not graduated, or blacklisted.
   * Graduated weight is now proportional to accumulated reputation rather than
   * binary (0 / 1). Post-graduation weight = min(reputation / graduationThreshold,
   * MAX_WEIGHT) where MAX_WEIGHT = 3.0. A DID at exactly threshold gets 1.0; one
   * with 3× the threshold gets 3.0. This rewards sustained contribution without
   * allowing runaway monopoly (capped at 3× baseline).
   *
   * Pre-graduation weight remains 0.0 — the gate still exists, only the ceiling
   * is raised above 1.0 for established contributors.
   *
   * When graduationThreshold = 0 (dev/test default), all non-blacklisted DIDs
   * return 1.0 so existing tests continue to pass.
   */
  getEffectiveWeight(did: string): number {
    const row = this.db.prepare(
      'SELECT reputation, graduated_at, blacklisted FROM did_reputation WHERE did = ?'
    ).get(did) as { reputation: number; graduated_at: string | null; blacklisted: number } | undefined

    if (!row || row.blacklisted) return 0.0

    const params = this.getGovernanceParameters()
    if (params.graduationThreshold === 0) return 1.0   // dev mode — no gate

    // Temporal diversity: DID must be old enough and have enough reviews
    if (params.minAgeDays > 0 || params.minReviewCount > 0) {
      const row2 = this.db.prepare(
        'SELECT first_seen_at, review_count FROM did_reputation WHERE did = ?'
      ).get(did) as { first_seen_at: string; review_count: number } | undefined
      if (row2) {
        if (params.minAgeDays > 0) {
          const ageMs = Date.now() - new Date(row2.first_seen_at).getTime()
          if (ageMs < params.minAgeDays * 86_400_000) return 0
        }
        if (params.minReviewCount > 0 && row2.review_count < params.minReviewCount) return 0
      }
    }

    if (!row.graduated_at) return 0.0

    const MAX_WEIGHT = 3.0
    return Math.min(row.reputation / params.graduationThreshold, MAX_WEIGHT)
  }

  /** All reputation rows, sorted by reputation descending. */
  listReputations(): Array<{
    did: string
    reputation: number
    reviewCount: number
    firstSeenAt: string
    graduatedAt: string | null
    lastActivity: string
    blacklisted: boolean
    effectiveWeight: number
  }> {
    const rows = this.db.prepare(
      'SELECT * FROM did_reputation ORDER BY reputation DESC'
    ).all() as Array<{
      did: string; reputation: number; review_count: number
      first_seen_at: string; graduated_at: string | null
      last_activity: string; blacklisted: number
    }>
    return rows.map(r => ({
      did: r.did,
      reputation: r.reputation,
      reviewCount: r.review_count,
      firstSeenAt: r.first_seen_at,
      graduatedAt: r.graduated_at,
      lastActivity: r.last_activity,
      blacklisted: Boolean(r.blacklisted),
      effectiveWeight: this.getEffectiveWeight(r.did),
    }))
  }

  /** Full reputation row for a DID, or null if unseen. */
  getReputation(did: string): {
    reputation: number
    reviewCount: number
    firstSeenAt: string
    graduatedAt: string | null
    lastActivity: string
    blacklisted: boolean
  } | null {
    const row = this.db.prepare('SELECT * FROM did_reputation WHERE did = ?').get(did) as {
      reputation: number; review_count: number; first_seen_at: string
      graduated_at: string | null; last_activity: string; blacklisted: number
    } | undefined
    if (!row) return null
    return {
      reputation: row.reputation,
      reviewCount: row.review_count,
      firstSeenAt: row.first_seen_at,
      graduatedAt: row.graduated_at,
      lastActivity: row.last_activity,
      blacklisted: Boolean(row.blacklisted),
    }
  }

  // ── Commit-Reveal ─────────────────────────────────────────────────────────

  /**
   * Phase 1: Store a review commitment for a static claim.
   * commitHash = SHA-256(verdict + salt + reviewerDid) — hex string.
   * Returns false if the DID is blacklisted or a duplicate commit id is submitted.
   */
  commitReview(params: {
    id: string
    kuId: string
    reviewerDid: string
    commitHash: string
  }): boolean {
    this.ensureDid(params.reviewerDid)
    const rep = this.db.prepare('SELECT blacklisted FROM did_reputation WHERE did = ?')
      .get(params.reviewerDid) as { blacklisted: number } | undefined
    if (rep?.blacklisted) return false

    try {
      this.db.prepare(`
        INSERT INTO review_commits (id, ku_id, reviewer_did, commit_hash, committed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(params.id, params.kuId, params.reviewerDid, params.commitHash, new Date().toISOString())
      return true
    } catch {
      return false  // duplicate id
    }
  }

  /**
   * Phase 2: Reveal a previously committed review verdict.
   * The reveal window opens when BOTH conditions hold:
   *   • time elapsed since the first commit for this KU >= commitWindowMinutes
   *   • total commits for this KU >= commitWindowMinCount
   *
   * On success: verifies the hash, scores the verdict against the graduated-reviewer
   * consensus, updates DID reputation accordingly, and returns the reputation delta.
   * Returns { ok: false } on any validation failure.
   */
  revealReview(params: {
    commitId: string
    verdict: string
    salt: string
    reviewerDid: string
  }): { ok: boolean; reputationDelta?: number } {
    const commit = this.db.prepare(
      'SELECT * FROM review_commits WHERE id = ? AND reviewer_did = ?'
    ).get(params.commitId, params.reviewerDid) as {
      id: string; ku_id: string; reviewer_did: string; commit_hash: string
      committed_at: string; revealed_at: string | null
    } | undefined

    if (!commit) return { ok: false }
    if (commit.revealed_at) return { ok: false }  // already revealed

    // Check window: both time AND count conditions must hold
    const govParams = this.getGovernanceParameters()
    const firstCommit = this.db.prepare(
      'SELECT MIN(committed_at) as first FROM review_commits WHERE ku_id = ?'
    ).get(commit.ku_id) as { first: string | null }
    const minutesSinceFirst = firstCommit.first
      ? (Date.now() - new Date(firstCommit.first).getTime()) / 60_000
      : 0
    const commitCount = (this.db.prepare(
      'SELECT COUNT(*) as n FROM review_commits WHERE ku_id = ?'
    ).get(commit.ku_id) as { n: number }).n

    const windowOpen = minutesSinceFirst >= govParams.commitWindowMinutes
      && commitCount >= govParams.commitWindowMinCount
    if (!windowOpen) return { ok: false }

    // Verify the commitment hash: SHA-256(verdict \x00 salt \x00 reviewerDid)
    // Fields are null-byte delimited to prevent concatenation collisions
    // e.g. ("confirmed", "123", "did:...") ≠ ("confirmed123", "", "did:...")
    const expectedHash = createHash('sha256')
      .update(params.verdict).update('\x00')
      .update(params.salt).update('\x00')
      .update(params.reviewerDid)
      .digest('hex')
    if (expectedHash !== commit.commit_hash) return { ok: false }

    const now = new Date().toISOString()

    // Score against graduated-reviewer consensus (excluding this reviewer).
    // When graduationThreshold = 0 (dev mode), all non-blacklisted revealed verdicts count.
    const graduationThreshold = govParams.graduationThreshold
    const consensusRows = (graduationThreshold === 0
      ? this.db.prepare(`
          SELECT rc.verdict FROM review_commits rc
          JOIN did_reputation dr ON dr.did = rc.reviewer_did
          WHERE rc.ku_id = ? AND rc.revealed_at IS NOT NULL
            AND rc.reviewer_did != ? AND dr.blacklisted = 0
        `).all(commit.ku_id, params.reviewerDid)
      : this.db.prepare(`
          SELECT rc.verdict FROM review_commits rc
          JOIN did_reputation dr ON dr.did = rc.reviewer_did
          WHERE rc.ku_id = ? AND rc.revealed_at IS NOT NULL
            AND rc.reviewer_did != ?
            AND dr.graduated_at IS NOT NULL AND dr.blacklisted = 0
        `).all(commit.ku_id, params.reviewerDid)
    ) as Array<{ verdict: string }>

    let reputationDelta = 0
    if (consensusRows.length >= 2) {
      const counts: Record<string, number> = {}
      for (const r of consensusRows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
      const consensusVerdict = sorted[0][0]
      const total = consensusRows.length
      const majorityShare = sorted[0][1] / total

      if (params.verdict === consensusVerdict) {
        reputationDelta = 1
      } else {
        // For KUs with any 'contested' claim, suppress the slash when minority
        // is substantial (>30% of votes). Different architectures may legitimately
        // disagree on ambiguous facts — we should not blacklist them for it.
        const ku = this.read(commit.ku_id)
        const hasContestedClaim = ku?.structured.claims.some(c => c.type === 'contested') ?? false
        if (hasContestedClaim && majorityShare < 0.70) {
          reputationDelta = 0  // abstain — no reward, no slash
        } else {
          reputationDelta = -10
        }
      }
    }

    // Mark commit as revealed — WHERE revealed_at IS NULL makes this atomic:
    // a concurrent reveal of the same commit changes 0 rows and we return false.
    const markResult = this.db.prepare(`
      UPDATE review_commits SET revealed_at = ?, verdict = ?, salt = ?, valid = 1
      WHERE id = ? AND revealed_at IS NULL
    `).run(now, params.verdict, params.salt, params.commitId)
    if (markResult.changes === 0) return { ok: false }  // lost race — already revealed

    // Update reputation
    if (reputationDelta !== 0) this.addReputation(params.reviewerDid, reputationDelta)
    this.recordReview(params.reviewerDid)

    // Write review into the KU's Automerge document so computeReviewScore()
    // sees the accumulated review history on the next confidence recompute.
    // Weight is snapshotted at reveal time (not commit time) so late-graduating
    // reviewers carry their earned weight.
    const weight = this.getEffectiveWeight(params.reviewerDid)
    this.update(commit.ku_id, ku => {
      ku.reviews.push({
        id: uuidv7(),
        reviewerDid: params.reviewerDid,
        reviewerType: 'agent',
        timestamp: now,
        verdict: params.verdict as 'confirmed' | 'amended' | 'disputed' | 'rejected',
        scope: [],
        weight,
      } as unknown as typeof ku.reviews[0])
    }, 'review')

    return { ok: true, reputationDelta }
  }

  // ── Governance ──────────────────────────────────────────────────────────────

  /**
   * Persist a new proposal after verifying the proposer's Ed25519 signature.
   * Returns false if the proposal already exists or the signature is invalid.
   */
  async submitProposal(proposal: Proposal): Promise<boolean> {
    const validated = ProposalSchema.parse(proposal)

    // Fix 3: Check reputation bond against actual reputation value, not just graduated_at.
    // Previous code only checked graduated_at, so raising proposalReputationBond via
    // governance had no effect — any graduated DID could still propose regardless of score.
    this.ensureDid(validated.proposerDid)
    const govParams = this.getGovernanceParameters()
    if (govParams.proposalReputationBond > 0) {
      const repRow = this.db.prepare(
        'SELECT reputation, graduated_at, blacklisted FROM did_reputation WHERE did = ?'
      ).get(validated.proposerDid) as { reputation: number; graduated_at: string | null; blacklisted: number } | undefined
      if (!repRow || repRow.blacklisted || !repRow.graduated_at) return false
      if (repRow.reputation < govParams.proposalReputationBond) return false
    }

    // Verify Ed25519 signature over canonical fields
    try {
      const pubKeyHex = extractPublicKeyFromDid(validated.proposerDid)
      const canonical = canonicalProposalPayload(validated)
      const ok = await verifyBytes(canonical, validated.signature, pubKeyHex)
      if (!ok) return false
    } catch {
      return false
    }
    try {
      this.db.prepare(`
        INSERT INTO governance_proposals (id, type, proposer_did, payload, created_at, expires_at, signature, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.id,
        validated.type,
        validated.proposerDid,
        JSON.stringify(validated.payload),
        validated.createdAt,
        validated.expiresAt,
        validated.signature,
        validated.status,
      )
      return true
    } catch {
      return false  // duplicate id
    }
  }

  /**
   * Cast a vote after verifying the voter's Ed25519 signature.
   * Returns false if the voter already voted or the signature is invalid.
   */
  async castVote(vote: Vote): Promise<boolean> {
    const validated = VoteSchema.parse(vote)

    // Register DID and check graduation (unless graduationThreshold = 0)
    this.ensureDid(validated.voterDid)
    const effectiveWeight = this.getEffectiveWeight(validated.voterDid)
    if (effectiveWeight === 0.0) return false  // not graduated or blacklisted

    try {
      const pubKeyHex = extractPublicKeyFromDid(validated.voterDid)
      const canonical = canonicalVotePayload(validated)
      const ok = await verifyBytes(canonical, validated.signature, pubKeyHex)
      if (!ok) return false
    } catch {
      return false
    }
    try {
      this.db.prepare(`
        INSERT INTO governance_votes (id, proposal_id, voter_did, choice, cast_at, weight, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.id,
        validated.proposalId,
        validated.voterDid,
        validated.choice,
        validated.castAt,
        validated.weight,
        validated.signature,
      )
      return true
    } catch {
      return false  // already voted
    }
  }

  /** Retrieve all votes for a proposal. */
  getVotes(proposalId: string): Vote[] {
    const rows = this.db.prepare('SELECT * FROM governance_votes WHERE proposal_id = ?').all(proposalId) as Array<{
      id: string; proposal_id: string; voter_did: string; choice: string; cast_at: string; weight: number; signature: string
    }>
    return rows.map(r => VoteSchema.parse({
      id: r.id, proposalId: r.proposal_id, voterDid: r.voter_did,
      choice: r.choice, castAt: r.cast_at, weight: r.weight, signature: r.signature,
    }))
  }

  /** Retrieve proposals filtered by status. */
  getProposals(status?: Proposal['status']): Proposal[] {
    const sql = status
      ? 'SELECT * FROM governance_proposals WHERE status = ?'
      : 'SELECT * FROM governance_proposals'
    const rows = (status
      ? this.db.prepare(sql).all(status)
      : this.db.prepare(sql).all()) as Array<{
        id: string; type: string; proposer_did: string; payload: string;
        created_at: string; expires_at: string; signature: string; status: string
      }>
    return rows.map(r => ProposalSchema.parse({
      id: r.id, type: r.type, proposerDid: r.proposer_did,
      payload: JSON.parse(r.payload), createdAt: r.created_at,
      expiresAt: r.expires_at, signature: r.signature, status: r.status,
    }))
  }

  /** Get / initialise governance parameters. */
  getGovernanceParameters(): GovernanceParameters {
    const row = this.db.prepare('SELECT params_json FROM governance_parameters WHERE singleton = 1').get() as { params_json: string } | undefined
    if (!row) return GovernanceParametersSchema.parse({})
    return GovernanceParametersSchema.parse(JSON.parse(row.params_json))
  }

  /** Persist updated governance parameters. */
  saveGovernanceParameters(params: GovernanceParameters): void {
    const validated = GovernanceParametersSchema.parse(params)
    this.db.prepare(`
      INSERT INTO governance_parameters (singleton, params_json) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET params_json = excluded.params_json
    `).run(JSON.stringify(validated))
  }

  /**
   * Finalize all open proposals whose vote tally has reached a verdict or
   * whose TTL has expired. Updates each proposal status in SQLite, applies
   * maturity overrides / parameter changes, and returns the list of outcomes.
   */
  finalizeExpired(): Array<{ proposalId: string; verdict: string }> {
    const params = this.getGovernanceParameters()
    const openProposals = this.getProposals('open')
    const results: Array<{ proposalId: string; verdict: string }> = []

    for (const proposal of openProposals) {
      const votes = this.getVotes(proposal.id)
      // Re-derive each voter's weight from live reputation rather than the snapshot
      // stored at cast time. A voter who is slashed after casting must not retain
      // their original weight at tally.
      const liveVotes = votes.map(v => ({ ...v, weight: this.getEffectiveWeight(v.voterDid) }))
      const tally = tallyVotes(proposal, liveVotes, params)

      if (tally.verdict === 'pending') continue

      // Update proposal status
      this.db.prepare('UPDATE governance_proposals SET status = ? WHERE id = ?')
        .run(tally.verdict === 'accepted' ? 'accepted' : tally.verdict === 'rejected' ? 'rejected' : 'expired', proposal.id)

      // Apply side effects of accepted proposals
      if (tally.verdict === 'accepted') {
        if (proposal.type === 'parameter_change') {
          const newParams = GovernanceEngine.applyParameterChange(params, proposal.payload as import('./governance.js').ParameterChangePayload)
          this.saveGovernanceParameters(newParams)
        } else if (proposal.type === 'maturity_override') {
          const p = proposal.payload as import('./governance.js').MaturityOverridePayload
          this.update(p.kuId, ku => {
            ku.meta.maturity = p.targetMaturity
          }, 'governance_maturity_override')
        } else if (proposal.type === 'agent_flag') {
          const p = proposal.payload as import('./governance.js').AgentFlagPayload
          const current = this.getGovernanceParameters()
          if (!current.suspendedAgents.includes(p.targetDid)) {
            current.suspendedAgents.push(p.targetDid)
          }
          this.saveGovernanceParameters(current)
          // Hard slash: immediately destroy reputation and blacklist
          this.ensureDid(p.targetDid)
          this.db.prepare(
            'UPDATE did_reputation SET reputation = -999, blacklisted = 1, last_activity = ? WHERE did = ?'
          ).run(new Date().toISOString(), p.targetDid)
        }
      }

      results.push({ proposalId: proposal.id, verdict: tally.verdict })
    }

    return results
  }

  /**
   * Compute the full GovernanceState from SQLite (proposals, votes, outcomes,
   * parameter overrides). Suitable for attaching to pipeline or RPC responses.
   */
  computeGovernanceState(): GovernanceState {
    const params = this.getGovernanceParameters()
    const openProposals = this.getProposals('open')

    // Reconstruct outcomes from non-open proposals
    const closedProposals = this.getProposals().filter(p => p.status !== 'open')
    const outcomes: import('./governance.js').GovernanceOutcome[] = closedProposals.map(p => {
      const votes = this.getVotes(p.id)
      const tally = tallyVotes(p, votes, params)
      return {
        proposalId: p.id,
        verdict: p.status as 'accepted' | 'rejected' | 'expired',
        finalizedAt: p.expiresAt,  // best approximation without storing separately
        yesCount: tally.yesCount,
        noCount: tally.noCount,
        abstainCount: tally.abstainCount,
        totalWeight: tally.totalWeight,
        threshold: tally.threshold,
        achievedRatio: tally.achievedRatio,
      }
    })

    // Build maturity override map from accepted maturity_override proposals
    const maturityOverrides: Record<string, 'draft' | 'proposed' | 'validated' | 'stable'> = {}
    const maturityOverrideSource: Record<string, string> = {}
    for (const p of closedProposals) {
      if (p.type === 'maturity_override' && p.status === 'accepted') {
        const payload = p.payload as import('./governance.js').MaturityOverridePayload
        maturityOverrides[payload.kuId] = payload.targetMaturity
        maturityOverrideSource[payload.kuId] = p.id
      }
    }

    return GovernanceStateSchema.parse({
      parameters: params,
      openProposals,
      outcomes,
      maturityOverrides,
      maturityOverrideSource,
    })
  }

  /**
   * Seed the network with a genesis cohort so new agents can earn reputation
   * immediately, breaking the graduation deadlock.
   *
   * Inserts two pre-graduated genesis DIDs and one anchor KU that they have
   * both already confirmed.  When any new agent reveals a 'confirmed' verdict
   * on the anchor KU, they see consensusRows.length === 2 and earn +1 reputation.
   * After `graduationThreshold` correct reveals they graduate and become real
   * scorers for all subsequent KUs — no rule changes required.
   *
   * Safe to call multiple times: uses INSERT OR IGNORE / checks existence first.
   */
  seedGenesisAnchor(): string {
    // Idempotent: return existing anchor ID if already seeded
    const existing = this.db.prepare(
      "SELECT id FROM knowledge_units WHERE domain = 'meta/akp' LIMIT 1"
    ).get() as { id: string } | undefined
    if (existing) return existing.id

    const now = new Date().toISOString()
    const genesisDids = ['did:key:genesis-1', 'did:key:genesis-2']

    // 1. Insert pre-graduated genesis DIDs
    for (const did of genesisDids) {
      this.db.prepare(`
        INSERT OR IGNORE INTO did_reputation
          (did, reputation, review_count, first_seen_at, last_activity, graduated_at)
        VALUES (?, 100, 1, ?, ?, ?)
      `).run(did, now, now, now)
    }

    // 2. Create the anchor KU (lets store.create() assign a valid UUID)
    const prov = createProvenance({ did: genesisDids[0], type: 'agent', method: 'observation' })
    const anchorKu = createKU({
      domain: 'meta/akp',
      title: { en: 'AKP Genesis Anchor' },
      summary: 'The AKP protocol uses commit-reveal with Ed25519-signed DIDs for peer verification.',
      provenance: prov,
    })
    anchorKu.structured.claims = [{
      id: uuidv7(),
      type: 'factual',
      subject: 'akp',
      predicate: 'uses_mechanism',
      object: 'commit-reveal',
      confidence: 1.0,
      provenanceRef: prov.id,
      replications: [],
    }]

    const anchorKuId = this.create(anchorKu)

    // 3. Insert pre-revealed review rows from both genesis DIDs
    for (const did of genesisDids) {
      // commit_hash irrelevant — row is pre-revealed; hash check only runs during revealReview()
      this.db.prepare(`
        INSERT OR IGNORE INTO review_commits
          (id, ku_id, reviewer_did, commit_hash, committed_at, revealed_at, verdict, salt, valid)
        VALUES (?, ?, ?, 'genesis-prehash', ?, ?, 'confirmed', 'genesis-salt', 1)
      `).run(uuidv7(), anchorKuId, did, now, now)
    }

    return anchorKuId
  }

  close() {
    this.db.close()
  }
}
