import { describe, it, expect } from 'vitest'
import {
  ConsilienceEngine,
  LifecycleRule,
  CausalOrderRule,
  UniqueIdentityRule,
  defaultConsilienceEngine,
} from '../../src/core/consilience.js'
import { normalizePredicateAlias, IMMUTABLE_PREDICATES } from '../../src/core/predicate-aliases.js'
import { RelationGraph } from '../../src/core/graph.js'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProv() {
  return createProvenance({ did: 'did:key:test', type: 'agent', method: 'synthesis' })
}

function makeGraph() {
  return new RelationGraph()
}

/** Add a single claim to a fresh KU in the graph; return the claim. */
function addClaimToGraph(
  graph: RelationGraph,
  subject: string,
  predicate: string,
  object: string | number,
  validFrom?: string
) {
  const prov = makeProv()
  const ku = createKU({ domain: 'test', title: { en: subject }, provenance: prov })
  const claim = createClaim({
    type: 'factual',
    subject,
    predicate,
    object,
    confidence: 0.9,
    provenanceRef: prov.id,
    ...(validFrom ? { validFrom } : {}),
  })
  ku.structured.claims.push(claim)
  graph.addKU(ku)
  return { claim, ku }
}

// ── normalizePredicateAlias ───────────────────────────────────────────────────

describe('normalizePredicateAlias', () => {
  it('canonicalizes death aliases', () => {
    expect(normalizePredicateAlias('died_at')).toBe('died_at')
    expect(normalizePredicateAlias('death_year')).toBe('died_at')
    expect(normalizePredicateAlias('deathDate')).toBe('died_at')
    expect(normalizePredicateAlias('died')).toBe('died_at')
    expect(normalizePredicateAlias('date_of_death')).toBe('died_at')
  })

  it('canonicalizes birth aliases', () => {
    expect(normalizePredicateAlias('born_at')).toBe('born_at')
    expect(normalizePredicateAlias('birth_year')).toBe('born_at')
    expect(normalizePredicateAlias('birthdate')).toBe('born_at')
    expect(normalizePredicateAlias('date_of_birth')).toBe('born_at')
  })

  it('canonicalizes chemistry aliases', () => {
    expect(normalizePredicateAlias('molecular_formula')).toBe('chemical_formula')
    expect(normalizePredicateAlias('proton_number')).toBe('atomic_number')
  })

  it('returns predicate unchanged when no alias exists', () => {
    expect(normalizePredicateAlias('boilingPoint')).toBe('boilingpoint')
    expect(normalizePredicateAlias('unknown_predicate')).toBe('unknown_predicate')
  })
})

// ── RelationGraph.findClaims ──────────────────────────────────────────────────

describe('RelationGraph.findClaims', () => {
  it('finds claims by subject across the full graph', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)
    addClaimToGraph(graph, 'caesar', 'born_at', -100)
    addClaimToGraph(graph, 'augustus', 'died_at', 14)

    const refs = graph.findClaims({ subject: 'caesar' })
    expect(refs).toHaveLength(2)
    expect(refs.every(r => r.claim.subject.toLowerCase() === 'caesar')).toBe(true)
  })

  it('finds claims by canonical predicate across the full graph', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)
    addClaimToGraph(graph, 'caesar', 'death_year', -44)  // alias
    addClaimToGraph(graph, 'augustus', 'born_at', -63)

    // Both 'died_at' and 'death_year' should appear under canonical 'died_at'
    const refs = graph.findClaims({ canonicalPredicate: 'died_at' })
    expect(refs).toHaveLength(2)
  })

  it('intersects subject + canonicalPredicate correctly', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)
    addClaimToGraph(graph, 'caesar', 'born_at', -100)
    addClaimToGraph(graph, 'augustus', 'died_at', 14)

    const refs = graph.findClaims({ subject: 'caesar', canonicalPredicate: 'died_at' })
    expect(refs).toHaveLength(1)
    expect(refs[0].claim.object).toBe(-44)
  })

  it('returns empty array when no match', () => {
    const graph = makeGraph()
    const refs = graph.findClaims({ subject: 'nobody', canonicalPredicate: 'died_at' })
    expect(refs).toHaveLength(0)
  })

  it('cleans up inverted indices on removeKU', () => {
    const graph = makeGraph()
    const { ku } = addClaimToGraph(graph, 'caesar', 'died_at', -44)
    expect(graph.findClaims({ subject: 'caesar' })).toHaveLength(1)
    graph.removeKU(ku.id)
    expect(graph.findClaims({ subject: 'caesar' })).toHaveLength(0)
  })
})

// ── LifecycleRule ─────────────────────────────────────────────────────────────

describe('LifecycleRule', () => {
  it('rejects activity after known death year', () => {
    const graph = makeGraph()
    // Caesar died 44 BC = year -44
    addClaimToGraph(graph, 'caesar', 'died_at', -44)

    // New claim: Caesar wrote something in 40 BC = year -40 (after death)
    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'writing' }, provenance: prov })
    const activityClaim = createClaim({
      type: 'factual', subject: 'caesar', predicate: 'wrote', object: 'De Bello Gallico',
      confidence: 0.8, provenanceRef: prov.id, validFrom: '-40',
    })
    ku.structured.claims.push(activityClaim)
    graph.addKU(ku)

    const violations = LifecycleRule.check(activityClaim, ku.id, graph)
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('reject')
    expect(violations[0].ruleId).toBe('lifecycle')
    expect(violations[0].reason).toMatch(/after/)
  })

  it('accepts activity within lifetime', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)
    addClaimToGraph(graph, 'caesar', 'born_at', -100)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'battle' }, provenance: prov })
    const activityClaim = createClaim({
      type: 'factual', subject: 'caesar', predicate: 'fought_at', object: 'Gaul',
      confidence: 0.9, provenanceRef: prov.id, validFrom: '-58',
    })
    ku.structured.claims.push(activityClaim)
    graph.addKU(ku)

    const violations = LifecycleRule.check(activityClaim, ku.id, graph)
    expect(violations).toHaveLength(0)
  })

  it('rejects activity before known birth year', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'einstein', 'born_at', 1879)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'paper' }, provenance: prov })
    const preBirthClaim = createClaim({
      type: 'factual', subject: 'einstein', predicate: 'published', object: 'special relativity',
      confidence: 0.9, provenanceRef: prov.id, validFrom: '1850',
    })
    ku.structured.claims.push(preBirthClaim)
    graph.addKU(ku)

    const violations = LifecycleRule.check(preBirthClaim, ku.id, graph)
    expect(violations).toHaveLength(1)
    expect(violations[0].reason).toMatch(/before/)
  })

  it('skips lifecycle claims themselves', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'born_at', -100)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'death' }, provenance: prov })
    // A death claim about Caesar — should NOT be flagged against the birth claim
    const deathClaim = createClaim({
      type: 'factual', subject: 'caesar', predicate: 'died_at', object: -44,
      confidence: 0.99, provenanceRef: prov.id,
    })
    ku.structured.claims.push(deathClaim)
    graph.addKU(ku)

    const violations = LifecycleRule.check(deathClaim, ku.id, graph)
    expect(violations).toHaveLength(0)
  })

  it('works without temporal data (no validFrom, non-year object) — no violation', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'trait' }, provenance: prov })
    const noYearClaim = createClaim({
      type: 'factual', subject: 'caesar', predicate: 'was_known_for', object: 'military genius',
      confidence: 0.9, provenanceRef: prov.id,
    })
    ku.structured.claims.push(noYearClaim)
    graph.addKU(ku)

    const violations = LifecycleRule.check(noYearClaim, ku.id, graph)
    expect(violations).toHaveLength(0)
  })
})

// ── CausalOrderRule ───────────────────────────────────────────────────────────

describe('CausalOrderRule', () => {
  it('warns when cause is after known effect', () => {
    const graph = makeGraph()
    // The effect happened in 1945
    addClaimToGraph(graph, 'wwii_end', 'occurred_at', 1945)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'cause' }, provenance: prov })
    // Retrocausal: claiming the bomb (in 1950) caused the 1945 event
    const causalClaim = createClaim({
      type: 'causal', subject: 'atomic_bomb_test', predicate: 'caused', object: 'wwii_end',
      confidence: 0.7, provenanceRef: prov.id, validFrom: '1950',
    })
    ku.structured.claims.push(causalClaim)
    graph.addKU(ku)

    const violations = CausalOrderRule.check(causalClaim, ku.id, graph)
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('warn')
    expect(violations[0].ruleId).toBe('causal_order')
  })

  it('skips non-causal claims', () => {
    const graph = makeGraph()
    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'fact' }, provenance: prov })
    const factClaim = createClaim({
      type: 'factual', subject: 'water', predicate: 'boils_at', object: 100,
      confidence: 0.99, provenanceRef: prov.id,
    })
    ku.structured.claims.push(factClaim)
    graph.addKU(ku)

    const violations = CausalOrderRule.check(factClaim, ku.id, graph)
    expect(violations).toHaveLength(0)
  })
})

// ── UniqueIdentityRule ────────────────────────────────────────────────────────

describe('UniqueIdentityRule', () => {
  it('rejects conflicting atomic numbers', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'gold', 'atomic_number', 79)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'wrong gold' }, provenance: prov })
    const wrongClaim = createClaim({
      type: 'quantitative', subject: 'gold', predicate: 'atomic_number', object: 80,
      confidence: 0.5, provenanceRef: prov.id,
    })
    ku.structured.claims.push(wrongClaim)
    graph.addKU(ku)

    const violations = UniqueIdentityRule.check(wrongClaim, ku.id, graph)
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe('reject')
    expect(violations[0].reason).toMatch(/atomic_number/)
    expect(violations[0].reason).toMatch(/gold/)
  })

  it('accepts consistent atomic number', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'gold', 'atomic_number', 79)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'gold confirmed' }, provenance: prov })
    const sameClaim = createClaim({
      type: 'quantitative', subject: 'gold', predicate: 'proton_number', object: 79, // alias
      confidence: 0.99, provenanceRef: prov.id,
    })
    ku.structured.claims.push(sameClaim)
    graph.addKU(ku)

    const violations = UniqueIdentityRule.check(sameClaim, ku.id, graph)
    expect(violations).toHaveLength(0)
  })

  it('ignores non-immutable predicates', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'water', 'boilingPoint', 100)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'water alt' }, provenance: prov })
    const diffClaim = createClaim({
      type: 'quantitative', subject: 'water', predicate: 'boilingPoint', object: 99,
      confidence: 0.5, provenanceRef: prov.id,
    })
    ku.structured.claims.push(diffClaim)
    graph.addKU(ku)

    // boilingPoint is NOT in IMMUTABLE_PREDICATES → no unique identity violation
    const violations = UniqueIdentityRule.check(diffClaim, ku.id, graph)
    expect(violations).toHaveLength(0)
  })
})

// ── ConsilienceEngine (integration) ──────────────────────────────────────────

describe('ConsilienceEngine', () => {
  it('runs all three rules and aggregates violations', () => {
    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)
    addClaimToGraph(graph, 'gold', 'atomic_number', 79)

    const engine = new ConsilienceEngine()

    // Lifecycle violation
    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'multi' }, provenance: prov })
    const postDeathClaim = createClaim({
      type: 'factual', subject: 'caesar', predicate: 'wrote', object: 'something',
      confidence: 0.5, provenanceRef: prov.id, validFrom: '-40',
    })
    const wrongAtom = createClaim({
      type: 'quantitative', subject: 'gold', predicate: 'atomic_number', object: 80,
      confidence: 0.5, provenanceRef: prov.id,
    })
    ku.structured.claims.push(postDeathClaim, wrongAtom)
    graph.addKU(ku)

    const violations = engine.checkKU(ku, graph)
    expect(violations.length).toBeGreaterThanOrEqual(2)
    expect(violations.some(v => v.ruleId === 'lifecycle')).toBe(true)
    expect(violations.some(v => v.ruleId === 'unique_identity')).toBe(true)
  })

  it('defaultConsilienceEngine is exported and functional', () => {
    expect(defaultConsilienceEngine).toBeInstanceOf(ConsilienceEngine)
  })

  it('supports custom rule sets', () => {
    const onlyLifecycle = new ConsilienceEngine([LifecycleRule])
    const graph = makeGraph()
    addClaimToGraph(graph, 'gold', 'atomic_number', 79)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'custom' }, provenance: prov })
    const wrongAtom = createClaim({
      type: 'quantitative', subject: 'gold', predicate: 'atomic_number', object: 80,
      confidence: 0.5, provenanceRef: prov.id,
    })
    ku.structured.claims.push(wrongAtom)
    graph.addKU(ku)

    // Only LifecycleRule active — UniqueIdentityRule should NOT fire
    const violations = onlyLifecycle.checkKU(ku, graph)
    expect(violations.every(v => v.ruleId === 'lifecycle')).toBe(true)
  })
})

// ── Stage2 integration ────────────────────────────────────────────────────────

describe('runStage2 with consilience', () => {
  it('includes consilienceViolations in result', async () => {
    const { runStage2 } = await import('../../src/pipeline/stage2.js')

    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'test' }, provenance: prov })
    const badClaim = createClaim({
      type: 'factual', subject: 'caesar', predicate: 'wrote', object: 'impossible text',
      confidence: 0.5, provenanceRef: prov.id, validFrom: '-40',
    })
    ku.structured.claims.push(badClaim)
    graph.addKU(ku)

    const result = await runStage2(ku, graph)
    expect(result.consilienceViolations.length).toBeGreaterThan(0)
    expect(result.stage2Score).toBeLessThan(1.0)
  })

  it('stage2Score penalized by reject violations more than warn', async () => {
    const { runStage2 } = await import('../../src/pipeline/stage2.js')

    const graph = makeGraph()
    addClaimToGraph(graph, 'caesar', 'died_at', -44)
    addClaimToGraph(graph, 'gold', 'atomic_number', 79)

    const prov = makeProv()
    const ku = createKU({ domain: 'test', title: { en: 'clean ku' }, provenance: prov })
    const cleanClaim = createClaim({
      type: 'factual', subject: 'water', predicate: 'boils_at', object: 100,
      confidence: 0.99, provenanceRef: prov.id,
    })
    ku.structured.claims.push(cleanClaim)
    graph.addKU(ku)
    const cleanResult = await runStage2(ku, graph)

    const prov2 = makeProv()
    const ku2 = createKU({ domain: 'test', title: { en: 'bad ku' }, provenance: prov2 })
    const rejectClaim = createClaim({
      type: 'quantitative', subject: 'gold', predicate: 'atomic_number', object: 80,
      confidence: 0.5, provenanceRef: prov2.id,
    })
    ku2.structured.claims.push(rejectClaim)
    graph.addKU(ku2)
    const badResult = await runStage2(ku2, graph)

    expect(cleanResult.stage2Score).toBeGreaterThan(badResult.stage2Score)
  })
})
