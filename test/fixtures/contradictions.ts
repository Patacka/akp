import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { v7 as uuidv7 } from 'uuid'
import type { KnowledgeUnit } from '../../src/core/ku.js'

export interface ContradictionPair {
  kuA: KnowledgeUnit
  kuB: KnowledgeUnit
  hopDistance: 1 | 2 | 3 | 4
  isContradiction: boolean
  description: string
}

const prov = createProvenance({ did: 'did:key:fixture', type: 'agent', method: 'observation' })

function ku(domain: string, subject: string, predicate: string, object: unknown, type: 'factual' | 'quantitative' = 'factual'): KnowledgeUnit {
  const k = createKU({ domain, title: { en: `${subject} ${predicate}` }, provenance: prov })
  k.structured.claims.push(createClaim({ type, subject, predicate, object, confidence: 0.95, provenanceRef: prov.id }))
  return k
}

function chain(...kus: KnowledgeUnit[]): KnowledgeUnit[] {
  for (let i = 0; i < kus.length - 1; i++) {
    kus[i].structured.relations.push({
      id: uuidv7(), type: 'related',
      sourceKuId: kus[i].id, targetKuId: kus[i + 1].id,
      confidence: 0.9, confirmedBy: ['did:key:agent1', 'did:key:agent2'],
    })
  }
  return kus
}

export function buildContradictionPairs(): ContradictionPair[] {
  const pairs: ContradictionPair[] = []

  // === HOP 1 CONTRADICTIONS ===
  const hop1: Array<[string, string, string, unknown, unknown, string]> = [
    ['chemistry', 'water', 'boilingPointCelsius', 100, 90, 'Water boiling point: 100°C vs 90°C'],
    ['chemistry', 'ethanol', 'boilingPointCelsius', 78.4, 85, 'Ethanol boiling point: 78.4 vs 85'],
    ['chemistry', 'caffeine', 'molecularWeightGMol', 194.19, 180.16, 'Caffeine vs glucose MW'],
    ['chemistry', 'hydrogen', 'atomicNumber', 1, 2, 'Hydrogen atomic number: 1 vs 2'],
    ['medicine', 'aspirin', 'mechanismOfAction', 'COX inhibitor', 'ACE inhibitor', 'Aspirin mechanism'],
    ['medicine', 'penicillin', 'discoveredBy', 'Alexander Fleming', 'Louis Pasteur', 'Penicillin discovery'],
    ['medicine', 'insulin', 'producedBy', 'pancreatic beta cells', 'adrenal gland', 'Insulin source'],
    ['medicine', 'DNA', 'structureType', 'double helix', 'triple helix', 'DNA structure'],
    ['chemistry', 'oxygen', 'atomicNumber', 8, 16, 'Oxygen atomic number: 8 vs 16'],
    ['medicine', 'BRCA1', 'chromosomeLocation', 'chromosome 17', 'chromosome 13', 'BRCA1 location'],
  ]
  for (const [domain, subject, predicate, objA, objB, desc] of hop1) {
    const a = ku(domain, subject, predicate, objA, typeof objA === 'number' ? 'quantitative' : 'factual')
    const b = ku(domain, subject, predicate, objB, typeof objB === 'number' ? 'quantitative' : 'factual')
    chain(a, b)
    pairs.push({ kuA: a, kuB: b, hopDistance: 1, isContradiction: true, description: desc })
  }

  // === HOP 2 CONTRADICTIONS ===
  const hop2: Array<[string, string, string, unknown, unknown, string]> = [
    ['chemistry', 'water', 'meltingPointCelsius', 0, -10, 'Water melting point via intermediate'],
    ['medicine', 'glucose', 'carbonAtoms', 6, 5, 'Glucose carbon atoms via intermediate'],
    ['chemistry', 'sodium chloride', 'molarMass', 58.44, 74.55, 'NaCl molar mass via intermediate'],
    ['medicine', 'neuron', 'primaryNeurotransmitter', 'acetylcholine', 'serotonin', 'Neuron neurotransmitter'],
    ['chemistry', 'nitrogen', 'boilingPointCelsius', -196, -183, 'Nitrogen bp: -196 vs -183 (oxygen)'],
    ['medicine', 'cortisol', 'producedBy', 'adrenal cortex', 'adrenal medulla', 'Cortisol source'],
    ['chemistry', 'sulfuric acid', 'acidStrength', 'strong acid', 'weak acid', 'H2SO4 strength'],
    ['medicine', 'mRNA', 'direction', 'nucleus to ribosome', 'ribosome to nucleus', 'mRNA direction'],
    ['medicine', 'CRISPR', 'cutsDNA', 'yes', 'no', 'CRISPR DNA cutting'],
    ['chemistry', 'diamond', 'hardnessMohs', 10, 9, 'Diamond hardness: 10 vs 9'],
  ]
  for (const [domain, subject, predicate, objA, objB, desc] of hop2) {
    const mid = ku(domain, subject + '-mid', 'relatedTo', `${subject}-context`)
    const a = ku(domain, subject, predicate, objA, typeof objA === 'number' ? 'quantitative' : 'factual')
    const b = ku(domain, subject, predicate, objB, typeof objB === 'number' ? 'quantitative' : 'factual')
    chain(a, mid, b)
    pairs.push({ kuA: a, kuB: b, hopDistance: 2, isContradiction: true, description: desc })
  }

  // === HOP 3 CONTRADICTIONS (synthetic) ===
  for (let i = 0; i < 15; i++) {
    const m1 = ku('chemistry', `c3-${i}`, 'class', `cls-${i}`)
    const m2 = ku('chemistry', `c3-${i}`, 'subclass', `sub-${i}`)
    const a = ku('chemistry', `c3-${i}`, `prop-${i}`, `val-a-${i}`)
    const b = ku('chemistry', `c3-${i}`, `prop-${i}`, `val-b-${i}`)
    chain(a, m1, m2, b)
    pairs.push({ kuA: a, kuB: b, hopDistance: 3, isContradiction: true, description: `Hop-3 contradiction ${i}` })
  }

  // === HOP 4 CONTRADICTIONS (synthetic) ===
  for (let i = 0; i < 5; i++) {
    const m1 = ku('medicine', `c4-${i}`, 'type', `t-${i}`)
    const m2 = ku('medicine', `c4-${i}`, 'subtype', `st-${i}`)
    const m3 = ku('medicine', `c4-${i}`, 'variant', `v-${i}`)
    const a = ku('medicine', `c4-${i}`, `prop-${i}`, `val-a-${i}`)
    const b = ku('medicine', `c4-${i}`, `prop-${i}`, `val-b-${i}`)
    chain(a, m1, m2, m3, b)
    pairs.push({ kuA: a, kuB: b, hopDistance: 4, isContradiction: true, description: `Hop-4 contradiction ${i}` })
  }

  // === TRUE NEGATIVES (20) ===
  for (let i = 0; i < 20; i++) {
    const a = ku('chemistry', `tn-a-${i}`, `pred-${i}`, `val-${i}`)
    const b = ku('chemistry', `tn-b-${i}`, `pred-${i}`, `val-${i}`) // different subject
    pairs.push({ kuA: a, kuB: b, hopDistance: 1, isContradiction: false, description: `True negative ${i}` })
  }

  return pairs
}
