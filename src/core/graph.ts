import type { KnowledgeUnit, Claim, Relation } from './ku.js'
import { normalizePredicateAlias } from './predicate-aliases.js'
import type Database from 'better-sqlite3'

// ── Row types for SQLite-backed graph persistence ─────────────────────────────

export interface GraphEdgeRow {
  ku_id: string
  neighbor_id: string
}

export interface GraphClaimRow {
  ku_id: string
  claim_id: string
  subject_orig: string
  subject_lc: string
  predicate_orig: string
  predicate_canonical: string
  object_val: string        // JSON.stringify'd
  claim_type: string
  valid_from: string | null
  valid_until: string | null
}

export interface GraphEntityRow {
  ku_id: string
  entity_label: string      // lowercased
}

export interface Contradiction {
  claimA: { kuId: string; claim: Claim }
  claimB: { kuId: string; claim: Claim }
  reason: string
  hopDistance: number
}

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  claimCount: number
}

export interface ClaimRef {
  claim: Claim
  kuId: string
}

export interface FindClaimsCriteria {
  /** Match claims whose subject equals this (case-insensitive). */
  subject?: string
  /**
   * Match claims whose predicate normalizes to this canonical form.
   * Use the canonical form (e.g. 'died_at', not 'death_year').
   */
  canonicalPredicate?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToClaim(c: GraphClaimRow): Claim {
  return {
    id: c.claim_id,
    type: c.claim_type as Claim['type'],
    subject: c.subject_orig,
    predicate: c.predicate_orig,
    object: (() => { try { return JSON.parse(c.object_val) } catch { return c.object_val } })(),
    confidence: 0,
    provenanceRef: '',
    replications: [],
    ...(c.valid_from  ? { validFrom:  c.valid_from  } : {}),
    ...(c.valid_until ? { validUntil: c.valid_until } : {}),
  }
}

// ── RelationGraph ─────────────────────────────────────────────────────────────

export class RelationGraph {
  // ── SQLite mode (production) ──────────────────────────────────────────────
  private readonly db: Database.Database | null

  // Prepared statements — initialised lazily in SQLite mode
  private stmts: {
    neighbors: Database.Statement
    neighborsBfs: Database.Statement
    claimsByKu: Database.Statement
    claimsBySubject: Database.Statement
    claimsByPredicate: Database.Statement
    claimsByBoth: Database.Statement
    countNodes: Database.Statement
    countEdges: Database.Statement
    countClaims: Database.Statement
  } | null = null

  // ── In-memory mode (tests / experiments) ─────────────────────────────────
  private adjacency: Map<string, Set<string>> = new Map()
  private claimIndex: Map<string, Claim[]> = new Map()
  private relationIndex: Map<string, Relation[]> = new Map()
  private entityIndex: Map<string, string[]> = new Map()
  private subjectIndex: Map<string, ClaimRef[]> = new Map()
  private predicateIndex: Map<string, ClaimRef[]> = new Map()

  /**
   * @param db  When provided, all queries go to SQLite and addKU/removeKU are
   *            no-ops (the store's _persistGraphData handles persistence).
   *            When omitted, the class uses in-memory Maps — required for tests
   *            and experiments that don't have a backing store.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? null
    if (this.db) this._prepareStatements(this.db)
  }

  private _prepareStatements(db: Database.Database) {
    this.stmts = {
      // Direct 1-hop neighbors
      neighbors: db.prepare(
        'SELECT neighbor_id FROM graph_edges WHERE ku_id = ?'
      ),

      // Recursive BFS up to :maxHops hops
      neighborsBfs: db.prepare(`
        WITH RECURSIVE nbrs(ku_id, hop) AS (
          SELECT neighbor_id, 1 FROM graph_edges WHERE ku_id = :root
          UNION
          SELECT e.neighbor_id, n.hop + 1
          FROM graph_edges e JOIN nbrs n ON e.ku_id = n.ku_id
          WHERE n.hop < :maxHops
        )
        SELECT ku_id, MIN(hop) AS hop FROM nbrs
        WHERE ku_id != :root
        GROUP BY ku_id
      `),

      // All claims for a set of KU ids is done via a two-step approach (see checkContradictions)
      claimsByKu: db.prepare(
        'SELECT * FROM graph_claims_index WHERE ku_id = ?'
      ),

      claimsBySubject: db.prepare(
        'SELECT * FROM graph_claims_index WHERE subject_lc = ?'
      ),

      claimsByPredicate: db.prepare(
        'SELECT * FROM graph_claims_index WHERE predicate_canonical = ?'
      ),

      claimsByBoth: db.prepare(
        'SELECT * FROM graph_claims_index WHERE subject_lc = ? AND predicate_canonical = ?'
      ),

      countNodes: db.prepare(
        'SELECT COUNT(DISTINCT ku_id) AS n FROM graph_edges'
      ),

      countEdges: db.prepare(
        'SELECT COUNT(*) / 2 AS n FROM graph_edges'
      ),

      countClaims: db.prepare(
        'SELECT COUNT(*) AS n FROM graph_claims_index'
      ),
    }
  }

  // ── Public API — SQLite path ───────────────────────────────────────────────

  /** No-op in SQLite mode — the store's _persistGraphData() handles this. */
  addKU(ku: KnowledgeUnit): void {
    if (this.db) return
    this._addKUInMemory(ku)
  }

  /** No-op in SQLite mode — the store's delete/update handles this. */
  removeKU(kuId: string): void {
    if (this.db) return
    this._removeKUInMemory(kuId)
  }

  /** No-op in SQLite mode — data already in DB. Kept for backward compat. */
  populateFromRows(
    edges: GraphEdgeRow[],
    claims: GraphClaimRow[],
    entities: GraphEntityRow[],
  ): void {
    if (this.db) return
    this._populateFromRowsInMemory(edges, claims, entities)
  }

  getNeighbors(kuId: string, maxHops = 1): Map<string, number> {
    if (this.db) return this._getNeighborsSql(kuId, maxHops)
    return this._getNeighborsInMemory(kuId, maxHops)
  }

  findClaims(criteria: FindClaimsCriteria): ClaimRef[] {
    if (this.db) return this._findClaimsSql(criteria)
    return this._findClaimsInMemory(criteria)
  }

  checkContradictions(
    newClaim: Claim,
    sourceKuId: string,
    maxHops = 3
  ): Contradiction[] {
    if (this.db) return this._checkContradictionsSql(newClaim, sourceKuId, maxHops)
    return this._checkContradictionsInMemory(newClaim, sourceKuId, maxHops)
  }

  computeCoherence(kuId: string, minConfirmations = 2): number {
    if (this.db) return this._computeCoherenceSql(kuId, minConfirmations)
    return this._computeCoherenceInMemory(kuId, minConfirmations)
  }

  getStats(): GraphStats {
    if (this.db) {
      const s = this.stmts!
      return {
        nodeCount: (s.countNodes.get() as { n: number }).n,
        edgeCount: (s.countEdges.get() as { n: number }).n,
        claimCount: (s.countClaims.get() as { n: number }).n,
      }
    }
    return this._getStatsInMemory()
  }

  // ── SQLite implementations ─────────────────────────────────────────────────

  private _getNeighborsSql(kuId: string, maxHops: number): Map<string, number> {
    if (maxHops === 1) {
      const rows = this.stmts!.neighbors.all(kuId) as Array<{ neighbor_id: string }>
      const result = new Map<string, number>()
      for (const r of rows) result.set(r.neighbor_id, 1)
      return result
    }

    const rows = this.stmts!.neighborsBfs.all({ root: kuId, maxHops }) as Array<{ ku_id: string; hop: number }>
    const result = new Map<string, number>()
    for (const r of rows) result.set(r.ku_id, r.hop)
    return result
  }

  private _findClaimsSql(criteria: FindClaimsCriteria): ClaimRef[] {
    let rows: GraphClaimRow[]

    if (criteria.subject !== undefined && criteria.canonicalPredicate !== undefined) {
      rows = this.stmts!.claimsByBoth.all(
        criteria.subject.toLowerCase(),
        criteria.canonicalPredicate
      ) as GraphClaimRow[]
    } else if (criteria.subject !== undefined) {
      rows = this.stmts!.claimsBySubject.all(criteria.subject.toLowerCase()) as GraphClaimRow[]
    } else if (criteria.canonicalPredicate !== undefined) {
      rows = this.stmts!.claimsByPredicate.all(criteria.canonicalPredicate) as GraphClaimRow[]
    } else {
      return []
    }

    return rows.map(r => ({ claim: rowToClaim(r), kuId: r.ku_id }))
  }

  private _checkContradictionsSql(newClaim: Claim, sourceKuId: string, maxHops: number): Contradiction[] {
    const contradictions: Contradiction[] = []

    // Get neighborhood (including self at hop 0)
    const neighborhood = this._getNeighborsSql(sourceKuId, maxHops)
    neighborhood.set(sourceKuId, 0)

    // Only look at KUs that share the same subject+predicate — use the index
    const candidateRows = this.stmts!.claimsByBoth.all(
      newClaim.subject.toLowerCase(),
      normalizePredicateAlias(newClaim.predicate)
    ) as GraphClaimRow[]

    for (const row of candidateRows) {
      if (!neighborhood.has(row.ku_id)) continue
      const existing = rowToClaim(row)
      if (existing.id === newClaim.id) continue

      const hopDist = neighborhood.get(row.ku_id)!
      const reason = this._checkClaimPair(newClaim, existing, hopDist)
      if (reason) {
        contradictions.push({
          claimA: { kuId: sourceKuId, claim: newClaim },
          claimB: { kuId: row.ku_id, claim: existing },
          reason,
          hopDistance: hopDist,
        })
      }
    }

    return contradictions
  }

  private _computeCoherenceSql(kuId: string, _minConfirmations: number): number {
    // Get own claims
    const ownClaims = (this.stmts!.claimsByKu.all(kuId) as GraphClaimRow[]).map(rowToClaim)
    if (ownClaims.length === 0) return 0.5

    // Get 2-hop neighborhood
    const neighborhood = this._getNeighborsSql(kuId, 2)
    if (neighborhood.size === 0) return 0.5

    let supportCount = 0
    let contradictionCount = 0

    // For each neighbor that has a direct edge (hop=1), check its claims
    for (const [neighborId, hop] of neighborhood) {
      if (hop > 1) continue  // Only direct neighbors for coherence
      const neighborClaims = (this.stmts!.claimsByKu.all(neighborId) as GraphClaimRow[]).map(rowToClaim)

      for (const claim of ownClaims) {
        const contradicting = neighborClaims.filter(nc =>
          nc.subject.toLowerCase() === claim.subject.toLowerCase() &&
          nc.predicate.toLowerCase() === claim.predicate.toLowerCase() &&
          JSON.stringify(nc.object) !== JSON.stringify(claim.object)
        )
        const supporting = neighborClaims.filter(nc =>
          nc.subject.toLowerCase() === claim.subject.toLowerCase() &&
          nc.predicate.toLowerCase() === claim.predicate.toLowerCase() &&
          JSON.stringify(nc.object) === JSON.stringify(claim.object)
        )
        if (contradicting.length > 0) contradictionCount++
        else if (supporting.length > 0) supportCount++
      }
    }

    const total = supportCount + contradictionCount
    return total === 0 ? 0.5 : supportCount / total
  }

  // ── In-memory implementations (tests / experiments) ───────────────────────

  private _addKUInMemory(ku: KnowledgeUnit) {
    const kuId = ku.id
    this.claimIndex.set(kuId, ku.structured.claims)

    for (const claim of ku.structured.claims) {
      const ref: ClaimRef = { claim, kuId }

      const subjectKey = claim.subject.toLowerCase()
      const subs = this.subjectIndex.get(subjectKey) ?? []
      subs.push(ref)
      this.subjectIndex.set(subjectKey, subs)

      const predicateKey = normalizePredicateAlias(claim.predicate)
      const preds = this.predicateIndex.get(predicateKey) ?? []
      preds.push(ref)
      this.predicateIndex.set(predicateKey, preds)
    }

    for (const entity of ku.structured.entities) {
      const existing = this.entityIndex.get(entity.label.toLowerCase()) ?? []
      if (!existing.includes(kuId)) {
        existing.push(kuId)
        this.entityIndex.set(entity.label.toLowerCase(), existing)
      }
    }

    const rels = ku.structured.relations
    this.relationIndex.set(kuId, rels)

    if (!this.adjacency.has(kuId)) this.adjacency.set(kuId, new Set())
    for (const rel of rels) {
      const target = rel.targetKuId !== kuId ? rel.targetKuId : rel.sourceKuId
      this.adjacency.get(kuId)!.add(target)
      if (!this.adjacency.has(target)) this.adjacency.set(target, new Set())
      this.adjacency.get(target)!.add(kuId)
    }
  }

  private _removeKUInMemory(kuId: string) {
    const neighbors = this.adjacency.get(kuId) ?? new Set()
    for (const neighbor of neighbors) this.adjacency.get(neighbor)?.delete(kuId)
    this.adjacency.delete(kuId)
    this.claimIndex.delete(kuId)
    this.relationIndex.delete(kuId)

    for (const [key, ids] of this.entityIndex) {
      const filtered = ids.filter(id => id !== kuId)
      if (filtered.length === 0) this.entityIndex.delete(key)
      else this.entityIndex.set(key, filtered)
    }
    for (const [key, refs] of this.subjectIndex) {
      const filtered = refs.filter(r => r.kuId !== kuId)
      if (filtered.length === 0) this.subjectIndex.delete(key)
      else this.subjectIndex.set(key, filtered)
    }
    for (const [key, refs] of this.predicateIndex) {
      const filtered = refs.filter(r => r.kuId !== kuId)
      if (filtered.length === 0) this.predicateIndex.delete(key)
      else this.predicateIndex.set(key, filtered)
    }
  }

  private _populateFromRowsInMemory(
    edges: GraphEdgeRow[],
    claims: GraphClaimRow[],
    entities: GraphEntityRow[],
  ): void {
    for (const e of edges) {
      if (!this.adjacency.has(e.ku_id)) this.adjacency.set(e.ku_id, new Set())
      this.adjacency.get(e.ku_id)!.add(e.neighbor_id)
    }

    for (const c of claims) {
      const claim = rowToClaim(c)
      const existing = this.claimIndex.get(c.ku_id) ?? []
      existing.push(claim)
      this.claimIndex.set(c.ku_id, existing)

      const ref: ClaimRef = { claim, kuId: c.ku_id }
      const subs = this.subjectIndex.get(c.subject_lc) ?? []
      subs.push(ref)
      this.subjectIndex.set(c.subject_lc, subs)

      const preds = this.predicateIndex.get(c.predicate_canonical) ?? []
      preds.push(ref)
      this.predicateIndex.set(c.predicate_canonical, preds)
    }

    for (const e of entities) {
      const existing = this.entityIndex.get(e.entity_label) ?? []
      if (!existing.includes(e.ku_id)) existing.push(e.ku_id)
      this.entityIndex.set(e.entity_label, existing)
    }
  }

  private _getNeighborsInMemory(kuId: string, maxHops: number): Map<string, number> {
    const visited = new Map<string, number>()
    const queue: Array<[string, number]> = [[kuId, 0]]
    while (queue.length > 0) {
      const [current, hop] = queue.shift()!
      if (visited.has(current)) continue
      visited.set(current, hop)
      if (hop < maxHops) {
        for (const neighbor of this.adjacency.get(current) ?? new Set()) {
          if (!visited.has(neighbor)) queue.push([neighbor, hop + 1])
        }
      }
    }
    visited.delete(kuId)
    return visited
  }

  private _findClaimsInMemory(criteria: FindClaimsCriteria): ClaimRef[] {
    let result: ClaimRef[] | null = null
    if (criteria.subject !== undefined) {
      result = this.subjectIndex.get(criteria.subject.toLowerCase()) ?? []
    }
    if (criteria.canonicalPredicate !== undefined) {
      const byPredicate = this.predicateIndex.get(criteria.canonicalPredicate) ?? []
      result = result === null ? byPredicate : result.filter(r => byPredicate.includes(r))
    }
    return result ?? []
  }

  private _checkContradictionsInMemory(newClaim: Claim, sourceKuId: string, maxHops: number): Contradiction[] {
    const contradictions: Contradiction[] = []
    const neighborhood = this._getNeighborsInMemory(sourceKuId, maxHops)
    neighborhood.set(sourceKuId, 0)

    for (const [kuId, hopDist] of neighborhood) {
      for (const existing of this.claimIndex.get(kuId) ?? []) {
        if (existing.id === newClaim.id) continue
        const reason = this._checkClaimPair(newClaim, existing, hopDist)
        if (reason) {
          contradictions.push({
            claimA: { kuId: sourceKuId, claim: newClaim },
            claimB: { kuId, claim: existing },
            reason,
            hopDistance: hopDist,
          })
        }
      }
    }
    return contradictions
  }

  private _computeCoherenceInMemory(kuId: string, minConfirmations: number): number {
    const claims = this.claimIndex.get(kuId) ?? []
    if (claims.length === 0) return 0

    const neighborhood = this._getNeighborsInMemory(kuId, 2)
    let supportCount = 0
    let contradictionCount = 0

    for (const claim of claims) {
      for (const [neighborId] of neighborhood) {
        const neighborClaims = this.claimIndex.get(neighborId) ?? []
        const neighborRelations = this.relationIndex.get(neighborId) ?? []

        const confirmedRelations = neighborRelations.filter(r => r.confirmedBy.length >= minConfirmations)
        const hasRelation = confirmedRelations.some(
          r => r.targetKuId === kuId || r.sourceKuId === kuId
        )

        if (hasRelation) {
          const contradictions = neighborClaims.filter(nc =>
            nc.subject.toLowerCase() === claim.subject.toLowerCase() &&
            nc.predicate.toLowerCase() === claim.predicate.toLowerCase() &&
            JSON.stringify(nc.object) !== JSON.stringify(claim.object)
          )
          if (contradictions.length > 0) contradictionCount++
          else {
            const supporting = neighborClaims.filter(nc =>
              nc.subject.toLowerCase() === claim.subject.toLowerCase() &&
              nc.predicate.toLowerCase() === claim.predicate.toLowerCase() &&
              JSON.stringify(nc.object) === JSON.stringify(claim.object)
            )
            if (supporting.length > 0) supportCount++
          }
        }
      }
    }

    const total = supportCount + contradictionCount
    if (total === 0) return 0.5
    return supportCount / total
  }

  private _getStatsInMemory(): GraphStats {
    let edgeCount = 0
    for (const neighbors of this.adjacency.values()) edgeCount += neighbors.size
    let claimCount = 0
    for (const claims of this.claimIndex.values()) claimCount += claims.length
    return { nodeCount: this.adjacency.size, edgeCount: edgeCount / 2, claimCount }
  }

  // ── Shared logic (both modes) ─────────────────────────────────────────────

  private _checkClaimPair(a: Claim, b: Claim, _hopDist: number): string | null {
    if (a.subject.toLowerCase() !== b.subject.toLowerCase()) return null
    if (a.predicate.toLowerCase() !== b.predicate.toLowerCase()) return null
    if (a.type !== b.type) return null

    if (a.type === 'factual') {
      if (JSON.stringify(a.object) !== JSON.stringify(b.object)) {
        return `Factual contradiction: "${a.subject} ${a.predicate}" has conflicting values`
      }
    }

    if (a.type === 'quantitative') {
      const aVal = Number(a.object)
      const bVal = Number(b.object)
      if (!isNaN(aVal) && !isNaN(bVal)) {
        const mean = (aVal + bVal) / 2
        const diff = Math.abs(aVal - bVal)
        if (mean > 0 && diff / mean > 0.1) {
          return `Quantitative contradiction: ${a.subject} ${a.predicate} = ${aVal} vs ${bVal}`
        }
      }
    }

    if (a.type === 'temporal' && a.validFrom && a.validUntil && b.validFrom && b.validUntil) {
      const aFrom  = new Date(a.validFrom).getTime()
      const aUntil = new Date(a.validUntil).getTime()
      const bFrom  = new Date(b.validFrom).getTime()
      const bUntil = new Date(b.validUntil).getTime()
      if (aFrom <= bUntil && bFrom <= aUntil && JSON.stringify(a.object) !== JSON.stringify(b.object)) {
        return `Temporal contradiction: overlapping valid periods with different values`
      }
    }

    return null
  }
}
