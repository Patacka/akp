/**
 * consilience.ts — Global constraint satisfaction for the knowledge graph.
 *
 * The ConsilienceEngine checks incoming claims against invariant rules that
 * span the entire graph (not just the 2-hop neighborhood). This catches
 * "deep contradictions" such as:
 *
 *   - "Caesar wrote X in 40 BC"  ←  violates LifecycleRule (died 44 BC)
 *   - "gold has atomic number 80" ←  violates UniqueIdentityRule (it's 79)
 *   - "Event B causes Event A, where A happened before B" ← CausalOrderRule
 *
 * Rules return ConsilienceViolation objects with severity:
 *   'reject' — hard logical impossibility; stage2Score → 0
 *   'warn'   — soft inconsistency; partial score penalty
 *
 * Architecture note: rules use RelationGraph.findClaims() for O(1) index
 * lookup, so rule evaluation is O(k) in the number of claims about the same
 * subject/predicate — not O(n) in the full graph size.
 */

import type { Claim } from './ku.js'
import type { RelationGraph } from './graph.js'
import { normalizePredicateAlias, IMMUTABLE_PREDICATES } from './predicate-aliases.js'

// ── Public types ──────────────────────────────────────────────────────────────

export interface ConsilienceViolation {
  ruleId: string
  severity: 'reject' | 'warn'
  claimA: { claim: Claim; kuId: string }
  claimB: { claim: Claim; kuId: string }
  reason: string
}

export interface ConsilienceRule {
  id: string
  description: string
  check(claim: Claim, kuId: string, graph: RelationGraph): ConsilienceViolation[]
}

// ── Year extraction helpers ───────────────────────────────────────────────────

/**
 * Parse a raw value (string or number) as a year, supporting negative years
 * for BCE dates (e.g. "-44", -44). Returns null if unparseable.
 */
function parseYear(val: unknown): number | null {
  if (typeof val === 'number' && isFinite(val)) return Math.round(val)
  if (typeof val === 'string') {
    // Strip everything except digits, minus sign, and decimal point
    const n = parseInt(val.replace(/[^\d-]/g, ''), 10)
    return isNaN(n) ? null : n
  }
  return null
}

/**
 * Extract the most meaningful year from a claim.
 * Priority: validFrom > validUntil > object (if it looks like a year).
 */
function claimYear(claim: Claim): number | null {
  if (claim.validFrom) {
    const n = parseInt(claim.validFrom.slice(0, 5), 10)
    if (!isNaN(n)) return n
  }
  if (claim.validUntil) {
    const n = parseInt(claim.validUntil.slice(0, 5), 10)
    if (!isNaN(n)) return n
  }
  // Only treat object as a year if it looks like one (|val| < 10000)
  const y = parseYear(claim.object)
  if (y !== null && Math.abs(y) <= 9999) return y
  return null
}

// ── Rule 1: LifecycleRule ────────────────────────────────────────────────────
//
// If we know when a subject was born/died, any activity claim that falls
// outside that window is a logical impossibility.

export const LifecycleRule: ConsilienceRule = {
  id: 'lifecycle',
  description: "Activity claims must fall within the subject's known lifecycle (born_at..died_at)",

  check(claim, kuId, graph) {
    const violations: ConsilienceViolation[] = []

    // Only claims that carry a temporal component
    const activityYear = claimYear(claim)
    if (activityYear === null) return []

    const normPred = normalizePredicateAlias(claim.predicate)
    // Skip the lifecycle claims themselves to avoid self-contradiction
    if (normPred === 'born_at' || normPred === 'died_at') return []

    // ── Check against known death date ────────────────────────────────────
    for (const { claim: dc, kuId: dkId } of graph.findClaims({
      subject: claim.subject,
      canonicalPredicate: 'died_at',
    })) {
      if (dc.id === claim.id) continue
      const deathYear = claimYear(dc)
      if (deathYear === null) continue
      if (activityYear > deathYear) {
        violations.push({
          ruleId: 'lifecycle',
          severity: 'reject',
          claimA: { claim, kuId },
          claimB: { claim: dc, kuId: dkId },
          reason: `"${claim.subject}" activity at year ${activityYear} is after recorded death at year ${deathYear}`,
        })
      }
    }

    // ── Check against known birth date ────────────────────────────────────
    for (const { claim: bc, kuId: bkId } of graph.findClaims({
      subject: claim.subject,
      canonicalPredicate: 'born_at',
    })) {
      if (bc.id === claim.id) continue
      const birthYear = claimYear(bc)
      if (birthYear === null) continue
      if (activityYear < birthYear) {
        violations.push({
          ruleId: 'lifecycle',
          severity: 'reject',
          claimA: { claim, kuId },
          claimB: { claim: bc, kuId: bkId },
          reason: `"${claim.subject}" activity at year ${activityYear} is before recorded birth at year ${birthYear}`,
        })
      }
    }

    return violations
  },
}

// ── Rule 2: CausalOrderRule ──────────────────────────────────────────────────
//
// If claim A says "X causes Y", and we know when Y occurred, then X must not
// have happened strictly after Y (retrocausality is a logical error).

export const CausalOrderRule: ConsilienceRule = {
  id: 'causal_order',
  description: 'Cause must not occur after its known effect (no retrocausality)',

  check(claim, kuId, graph) {
    const violations: ConsilienceViolation[] = []
    if (claim.type !== 'causal') return []

    const causeYear = claimYear(claim)
    if (causeYear === null) return []

    // claim.object names the effect entity/event
    const effectSubject = String(claim.object)
    for (const { claim: ec, kuId: ekId } of graph.findClaims({ subject: effectSubject })) {
      if (ec.id === claim.id) continue
      const effectYear = claimYear(ec)
      if (effectYear === null) continue
      if (causeYear > effectYear) {
        violations.push({
          ruleId: 'causal_order',
          severity: 'warn',
          claimA: { claim, kuId },
          claimB: { claim: ec, kuId: ekId },
          reason: `Cause "${claim.subject}" at year ${causeYear} appears after effect "${effectSubject}" at year ${effectYear}`,
        })
      }
    }

    return violations
  },
}

// ── Rule 3: UniqueIdentityRule ───────────────────────────────────────────────
//
// Immutable properties (birth date, atomic number, chemical formula, etc.)
// cannot have two different values for the same subject. If they do, at least
// one claim must be wrong.

export const UniqueIdentityRule: ConsilienceRule = {
  id: 'unique_identity',
  description: 'Immutable properties cannot have conflicting values for the same subject',

  check(claim, kuId, graph) {
    const violations: ConsilienceViolation[] = []

    const normPred = normalizePredicateAlias(claim.predicate)
    if (!IMMUTABLE_PREDICATES.has(normPred)) return []

    for (const { claim: ec, kuId: ekId } of graph.findClaims({
      subject: claim.subject,
      canonicalPredicate: normPred,
    })) {
      if (ec.id === claim.id) continue
      if (JSON.stringify(ec.object) !== JSON.stringify(claim.object)) {
        violations.push({
          ruleId: 'unique_identity',
          severity: 'reject',
          claimA: { claim, kuId },
          claimB: { claim: ec, kuId: ekId },
          reason: `Conflicting immutable property "${normPred}" for "${claim.subject}": ` +
            `${JSON.stringify(claim.object)} vs ${JSON.stringify(ec.object)}`,
        })
      }
    }

    return violations
  },
}

// ── ConsilienceEngine ─────────────────────────────────────────────────────────

export class ConsilienceEngine {
  private rules: ConsilienceRule[]

  constructor(rules: ConsilienceRule[] = [LifecycleRule, CausalOrderRule, UniqueIdentityRule]) {
    this.rules = rules
  }

  /** Check a single claim against all registered rules. */
  check(claim: Claim, kuId: string, graph: RelationGraph): ConsilienceViolation[] {
    const violations: ConsilienceViolation[] = []
    for (const rule of this.rules) {
      violations.push(...rule.check(claim, kuId, graph))
    }
    return violations
  }

  /** Check all claims in a KU. Convenience wrapper over check(). */
  checkKU(
    ku: { id: string; structured: { claims: Claim[] } },
    graph: RelationGraph
  ): ConsilienceViolation[] {
    const violations: ConsilienceViolation[] = []
    for (const claim of ku.structured.claims) {
      violations.push(...this.check(claim, ku.id, graph))
    }
    return violations
  }
}

/** Shared default engine used by stage2 unless overridden. */
export const defaultConsilienceEngine = new ConsilienceEngine()
