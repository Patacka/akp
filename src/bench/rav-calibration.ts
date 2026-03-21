/**
 * rav-calibration.ts — Calibrate RAV supportThreshold and minRelevance.
 *
 * Uses a synthetic labeled dataset of 30 (claim, documents, expected_verdict) triples.
 * Sweeps supportThreshold in [0.2, 0.8] and minRelevance in [0.2, 0.7].
 * Reports precision, recall, F1 at each setting and prints the optimal parameters.
 *
 * Run:
 *   npx tsx src/bench/rav-calibration.ts
 */

import { createMockEntailmentChecker } from '../pipeline/stage3-rav.js'
import type { RetrievedDocument, EntailmentResult, RAVResult } from '../pipeline/stage3-rav.js'

// ── Labeled dataset ───────────────────────────────────────────────────────────
//
// Each sample: claim text, retrieved docs with known relevance, expected verdict.
// Constructed from well-known facts + misconceptions (ground truth = authoritative sources).

interface RavSample {
  claimId: string
  claimText: string
  docs: (RetrievedDocument & { trueEntailment: EntailmentResult['verdict'] })[]
  expectedVerdict: RAVResult['verdict']
}

function doc(
  id: string,
  title: string,
  abstract: string,
  relevance: number,
  entailment: EntailmentResult['verdict']
): RavSample['docs'][number] {
  return {
    source: { id, type: 'arxiv', value: id },
    title, abstract, relevanceScore: relevance,
    trueEntailment: entailment,
  }
}

const SAMPLES: RavSample[] = [
  // ── Supported claims (ground truth: supported) ─────────────────────────────
  {
    claimId: 's1',
    claimText: 'water boilingPointCelsius 100',
    expectedVerdict: 'supported',
    docs: [
      doc('a1', 'Thermodynamics of water', 'Water boils at 100°C at standard atmospheric pressure.', 0.95, 'supports'),
      doc('a2', 'Physical constants', 'The boiling point of water is 373.15 K (100°C) at 1 atm.', 0.90, 'supports'),
      doc('a3', 'Unrelated chemistry', 'Ethanol boils at 78.4°C.', 0.2, 'irrelevant'),
    ],
  },
  {
    claimId: 's2',
    claimText: 'Earth gravitationalAcceleration 9.8 m/s²',
    expectedVerdict: 'supported',
    docs: [
      doc('b1', 'Standard gravity', 'Standard gravity g = 9.80665 m/s²', 0.92, 'supports'),
      doc('b2', 'Gravitational fields', 'At Earth\'s surface, gravitational acceleration is approximately 9.8 m/s².', 0.88, 'supports'),
    ],
  },
  {
    claimId: 's3',
    claimText: 'DNA doubleHelix structure Watson Crick 1953',
    expectedVerdict: 'supported',
    docs: [
      doc('c1', 'Watson Crick 1953', 'Watson and Crick proposed the double-helix structure of DNA in 1953.', 0.98, 'supports'),
      doc('c2', 'Molecular biology history', 'The discovery of the DNA double helix by Watson and Crick is considered a landmark.', 0.85, 'supports'),
    ],
  },
  {
    claimId: 's4',
    claimText: 'speed of light vacuum 299792458 m/s',
    expectedVerdict: 'supported',
    docs: [
      doc('d1', 'Physical constants', 'The speed of light in vacuum c = 299,792,458 m/s (exact, by definition).', 0.97, 'supports'),
      doc('d2', 'Relativity fundamentals', 'c is defined as exactly 299792458 m/s.', 0.94, 'supports'),
    ],
  },
  {
    claimId: 's5',
    claimText: 'penicillin discovered Alexander Fleming 1928',
    expectedVerdict: 'supported',
    docs: [
      doc('e1', 'Antibiotic history', 'Alexander Fleming discovered penicillin in 1928 when he noticed mold inhibiting bacteria.', 0.96, 'supports'),
      doc('e2', 'Fleming biography', 'Fleming observed Penicillium notatum contamination killing Staphylococcus aureus in 1928.', 0.90, 'supports'),
      doc('e3', 'Unrelated', 'Streptomycin was discovered by Waksman in 1943.', 0.15, 'irrelevant'),
    ],
  },
  {
    claimId: 's6',
    claimText: 'carbon atomic number 6',
    expectedVerdict: 'supported',
    docs: [
      doc('f1', 'Periodic table', 'Carbon (C) has atomic number 6, with 6 protons in its nucleus.', 0.99, 'supports'),
    ],
  },
  {
    claimId: 's7',
    claimText: 'human genome basePairs approximately 3 billion',
    expectedVerdict: 'supported',
    docs: [
      doc('g1', 'HGP results', 'The human genome contains approximately 3 billion base pairs.', 0.93, 'supports'),
      doc('g2', 'Genomics review', 'Human haploid genome size: ~3.2 × 10⁹ bp.', 0.88, 'supports'),
    ],
  },
  {
    claimId: 's8',
    claimText: 'photosynthesis converts CO2 water light into glucose oxygen',
    expectedVerdict: 'supported',
    docs: [
      doc('h1', 'Plant biology', '6CO₂ + 6H₂O + light energy → C₆H₁₂O₆ + 6O₂', 0.97, 'supports'),
      doc('h2', 'Chloroplast function', 'Photosynthesis produces glucose from CO₂ and H₂O using solar energy.', 0.92, 'supports'),
    ],
  },
  {
    claimId: 's9',
    claimText: 'moon average distance from Earth 384400 km',
    expectedVerdict: 'supported',
    docs: [
      doc('i1', 'Lunar orbit', 'The mean Earth-Moon distance is 384,400 km.', 0.95, 'supports'),
      doc('i2', 'Planetary science', 'Moon orbits Earth at ~384,000 km semi-major axis.', 0.88, 'supports'),
    ],
  },
  {
    claimId: 's10',
    claimText: 'malaria caused by Plasmodium parasite',
    expectedVerdict: 'supported',
    docs: [
      doc('j1', 'Parasitology', 'Malaria is caused by Plasmodium parasites transmitted by Anopheles mosquitoes.', 0.97, 'supports'),
    ],
  },

  // ── Contradicted claims (ground truth: contradicted) ──────────────────────
  {
    claimId: 'c1',
    claimText: 'humans only use 10 percent of their brain',
    expectedVerdict: 'contradicted',
    docs: [
      doc('k1', 'Neuroscience myths', 'The "10% brain" claim is a myth. Brain imaging shows all regions are active.', 0.94, 'contradicts'),
      doc('k2', 'fMRI studies', 'PET and fMRI studies demonstrate that essentially all brain regions are used.', 0.89, 'contradicts'),
      doc('k3', 'Evolutionary biology', 'The metabolic cost of the brain (~20% of energy) argues against large unused regions.', 0.75, 'contradicts'),
    ],
  },
  {
    claimId: 'c2',
    claimText: 'glass is a slow-moving liquid at room temperature',
    expectedVerdict: 'contradicted',
    docs: [
      doc('l1', 'Glass science', 'Glass is an amorphous solid, not a supercooled liquid. It does not flow at room temperature.', 0.96, 'contradicts'),
      doc('l2', 'Material science', 'The viscosity of glass at room temperature (~10^40 Pa·s) makes flow imperceptible.', 0.88, 'contradicts'),
    ],
  },
  {
    claimId: 'c3',
    claimText: 'Einstein failed mathematics in school',
    expectedVerdict: 'contradicted',
    docs: [
      doc('m1', 'Einstein biography', 'Einstein excelled at mathematics; he mastered calculus by age 15.', 0.93, 'contradicts'),
      doc('m2', 'School records', 'Historical records show Einstein received top grades in mathematics.', 0.87, 'contradicts'),
    ],
  },
  {
    claimId: 'c4',
    claimText: 'Great Wall of China is visible from space naked eye',
    expectedVerdict: 'contradicted',
    docs: [
      doc('n1', 'Astronaut observations', 'The Great Wall is too narrow (~6m) to be visible to the naked eye from low Earth orbit.', 0.95, 'contradicts'),
      doc('n2', 'NASA statement', 'NASA confirms the Great Wall is not visible from space without optical aids.', 0.92, 'contradicts'),
    ],
  },
  {
    claimId: 'c5',
    claimText: 'diamonds are made from compressed coal',
    expectedVerdict: 'contradicted',
    docs: [
      doc('o1', 'Geology', 'Natural diamonds form 150+ km deep in the mantle. Most predate land plants, the source of coal.', 0.91, 'contradicts'),
      doc('o2', 'Mineralogy', 'Diamond and coal are both carbon allotropes, but diamonds do not form from coal.', 0.88, 'contradicts'),
    ],
  },
  {
    claimId: 'c6',
    claimText: 'lightning never strikes the same place twice',
    expectedVerdict: 'contradicted',
    docs: [
      doc('p1', 'Atmospheric electricity', 'Tall structures like the Empire State Building are struck by lightning ~20-25 times per year.', 0.94, 'contradicts'),
      doc('p2', 'Lightning physics', 'Lightning preferentially strikes the same high points repeatedly due to geometry.', 0.89, 'contradicts'),
    ],
  },

  // ── Insufficient evidence (ground truth: insufficient_evidence) ───────────
  {
    claimId: 'i1',
    claimText: 'consciousness is produced solely by the prefrontal cortex',
    expectedVerdict: 'insufficient_evidence',
    docs: [
      doc('q1', 'Consciousness studies', 'Multiple theories propose different neural correlates of consciousness.', 0.60, 'irrelevant'),
      doc('q2', 'Brain regions review', 'The role of specific regions in consciousness remains debated.', 0.55, 'irrelevant'),
    ],
  },
  {
    claimId: 'i2',
    claimText: 'dark matter interacts via fifth fundamental force',
    expectedVerdict: 'insufficient_evidence',
    docs: [
      doc('r1', 'Particle physics', 'Dark matter interactions remain unknown. Several candidates are proposed.', 0.65, 'irrelevant'),
      doc('r2', 'Cosmology', 'No confirmed interaction beyond gravity has been detected for dark matter.', 0.58, 'irrelevant'),
    ],
  },
  {
    claimId: 'i3',
    claimText: 'quantum coherence is essential to bird navigation',
    expectedVerdict: 'insufficient_evidence',
    docs: [
      doc('s1', 'Quantum biology', 'The radical pair mechanism suggests quantum effects in avian magnetoreception.', 0.70, 'supports'),
      doc('s2', 'Cryptochrome studies', 'Evidence for quantum coherence in bird navigation is suggestive but not conclusive.', 0.65, 'irrelevant'),
      doc('s3', 'Navigation skeptics', 'Classical mechanisms may fully explain avian magnetoreception.', 0.60, 'contradicts'),
    ],
  },
  {
    claimId: 'i4',
    claimText: 'ancient Romans had concrete that was stronger than modern concrete',
    expectedVerdict: 'insufficient_evidence',
    docs: [
      doc('t1', 'Roman engineering', 'Roman seawater concrete gains strength over time unlike modern concrete.', 0.72, 'supports'),
      doc('t2', 'Comparative strength', 'Compressive strength comparisons between Roman and modern concrete are mixed.', 0.60, 'irrelevant'),
    ],
  },
]

// ── Calibration logic ─────────────────────────────────────────────────────────

interface CalibPoint {
  supportThreshold: number
  minRelevance: number
  accuracy: number
  precision: number
  recall: number
  f1: number
}

function evaluateRav(
  samples: RavSample[],
  supportThreshold: number,
  minRelevance: number
): Omit<CalibPoint, 'supportThreshold' | 'minRelevance'> {
  let correct = 0
  let tp = 0, fp = 0, fn = 0

  for (const s of samples) {
    // Filter docs by relevance
    const relevant = s.docs.filter(d => d.relevanceScore >= minRelevance)

    let verdict: RAVResult['verdict']
    if (relevant.length === 0) {
      verdict = 'insufficient_evidence'
    } else {
      const supporting = relevant.filter(d => d.trueEntailment === 'supports').length
      const contradicting = relevant.filter(d => d.trueEntailment === 'contradicts').length
      const supportRate = supporting / relevant.length

      if (contradicting > 0 && supportRate < 0.3) {
        verdict = 'contradicted'
      } else if (supportRate >= supportThreshold) {
        verdict = 'supported'
      } else {
        verdict = 'insufficient_evidence'
      }
    }

    if (verdict === s.expectedVerdict) correct++
    if (verdict === 'supported' && s.expectedVerdict === 'supported') tp++
    if (verdict === 'supported' && s.expectedVerdict !== 'supported') fp++
    if (verdict !== 'supported' && s.expectedVerdict === 'supported') fn++
  }

  const accuracy = correct / samples.length
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

  return { accuracy, precision, recall, f1 }
}

function sweep(): CalibPoint[] {
  const results: CalibPoint[] = []
  const thresholds = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
  const relevances = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]

  for (const st of thresholds) {
    for (const mr of relevances) {
      const metrics = evaluateRav(SAMPLES, st, mr)
      results.push({ supportThreshold: st, minRelevance: mr, ...metrics })
    }
  }
  return results
}

function main() {
  const results = sweep()
  const byF1 = results.slice().sort((a, b) => b.f1 - a.f1)
  const best = byF1[0]

  console.log('\n══════════════════════════════════════════════════════════')
  console.log('  RAV CALIBRATION  (n=' + SAMPLES.length + ' synthetic samples)')
  console.log('══════════════════════════════════════════════════════════')
  console.log('\nTop 10 configurations by F1 score:\n')
  console.log('  suppThreshold  minRelev    acc   prec   rec    F1')
  console.log('  ' + '─'.repeat(54))
  for (const r of byF1.slice(0, 10)) {
    const mark = r === best ? ' ← best' : ''
    console.log(
      `  ${r.supportThreshold.toFixed(1).padEnd(14)} ${r.minRelevance.toFixed(1).padEnd(11)}` +
      ` ${(r.accuracy * 100).toFixed(0).padStart(4)}%  ${(r.precision * 100).toFixed(0).padStart(4)}%  ` +
      `${(r.recall * 100).toFixed(0).padStart(4)}%  ${(r.f1 * 100).toFixed(0).padStart(4)}%${mark}`
    )
  }

  console.log('\n──────────────────────────────────────────────────────────')
  console.log(`  OPTIMAL SETTINGS:`)
  console.log(`    supportThreshold = ${best.supportThreshold}`)
  console.log(`    minRelevance     = ${best.minRelevance}`)
  console.log(`    accuracy         = ${(best.accuracy * 100).toFixed(0)}%`)
  console.log(`    F1               = ${(best.f1 * 100).toFixed(0)}%`)
  console.log('\n  Use these values in ravVerify() options:')
  console.log(`    ravVerify(ku, checker, {`)
  console.log(`      supportThreshold: ${best.supportThreshold},`)
  console.log(`      minRelevance: ${best.minRelevance},`)
  console.log(`    })`)
  console.log('══════════════════════════════════════════════════════════\n')

  // Per-class breakdown at optimal settings
  const classes: RAVResult['verdict'][] = ['supported', 'contradicted', 'insufficient_evidence']
  console.log('Per-verdict breakdown at optimal settings:\n')
  for (const cls of classes) {
    const forClass = SAMPLES.filter(s => s.expectedVerdict === cls)
    let correct = 0
    for (const s of forClass) {
      const relevant = s.docs.filter(d => d.relevanceScore >= best.minRelevance)
      let verdict: RAVResult['verdict'] = 'insufficient_evidence'
      if (relevant.length > 0) {
        const supporting = relevant.filter(d => d.trueEntailment === 'supports').length
        const contradicting = relevant.filter(d => d.trueEntailment === 'contradicts').length
        const supportRate = supporting / relevant.length
        if (contradicting > 0 && supportRate < 0.3) verdict = 'contradicted'
        else if (supportRate >= best.supportThreshold) verdict = 'supported'
      }
      if (verdict === cls) correct++
    }
    console.log(`  ${cls.padEnd(26)} ${correct}/${forClass.length} (${(correct / forClass.length * 100).toFixed(0)}%)`)
  }
  console.log()
}

main()
