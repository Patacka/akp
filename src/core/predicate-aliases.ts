/**
 * predicate-aliases.ts — Canonical predicate normalization.
 *
 * Agents may use different predicate names for the same concept ("died_at",
 * "death_year", "deathDate"). This module provides a single mapping so the
 * ConsilienceEngine and RelationGraph inverted indices operate on canonical
 * forms regardless of how individual agents phrased a claim.
 *
 * To extend: add more aliases to PREDICATE_ALIASES. The value is the
 * canonical form all aliases collapse to.
 */

export const PREDICATE_ALIASES: Readonly<Record<string, string>> = {
  // ── Death ─────────────────────────────────────────────────────────────────
  died_at:       'died_at',
  death_year:    'died_at',
  deathdate:     'died_at',
  death_date:    'died_at',
  died:          'died_at',
  year_of_death: 'died_at',
  date_of_death: 'died_at',
  death_year_ce: 'died_at',

  // ── Birth ─────────────────────────────────────────────────────────────────
  born_at:       'born_at',
  birth_year:    'born_at',
  birthdate:     'born_at',
  birth_date:    'born_at',
  born:          'born_at',
  year_of_birth: 'born_at',
  date_of_birth: 'born_at',
  birth_year_ce: 'born_at',

  // ── Place ─────────────────────────────────────────────────────────────────
  birth_place:    'birth_place',
  birthplace:     'birth_place',
  place_of_birth: 'birth_place',
  hometown:       'birth_place',

  // ── Identity ──────────────────────────────────────────────────────────────
  nationality:       'nationality',
  citizenship:       'nationality',

  // ── Chemistry / Biology ───────────────────────────────────────────────────
  species:              'species',
  taxon:                'species',
  chemical_formula:     'chemical_formula',
  molecular_formula:    'chemical_formula',
  empirical_formula:    'chemical_formula',
  atomic_number:        'atomic_number',
  proton_number:        'atomic_number',
  atomic_symbol:        'atomic_symbol',
  element_symbol:       'atomic_symbol',
}

/**
 * Properties whose value must be unique for a given subject.
 * Two claims asserting different values for the same subject + immutable
 * predicate constitute a UniqueIdentity violation (severity: 'reject').
 */
export const IMMUTABLE_PREDICATES = new Set([
  'born_at',
  'died_at',
  'birth_place',
  'atomic_number',
  'chemical_formula',
  'atomic_symbol',
  'species',
])

/**
 * Normalize a raw predicate string to its canonical form.
 * Lowercases and replaces spaces/hyphens/dots with underscores,
 * then applies PREDICATE_ALIASES if a mapping exists.
 */
export function normalizePredicateAlias(predicate: string): string {
  const key = predicate.toLowerCase().replace(/[\s\-.]/g, '_')
  return PREDICATE_ALIASES[key] ?? key
}
