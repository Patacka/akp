import { RelationGraph } from '../core/graph.js'
import { createKU, createProvenance, createClaim } from '../core/ku.js'
import { v7 as uuidv7 } from 'uuid'

export interface GraphScaleResult {
  graphSize: number
  buildTimeMs: number
  memoryMB: number
  stage2MedianMs: number
  stage2P95Ms: number
  contradictionsFound: number
  degreeDistribution: 'uniform' | 'power-law'
}

function buildUniformGraph(size: number): { graph: RelationGraph; kuIds: string[] } {
  const graph = new RelationGraph()
  const kuIds: string[] = []
  const prov = createProvenance({ did: 'did:key:bench', type: 'agent', method: 'synthesis' })

  for (let i = 0; i < size; i++) {
    const ku = createKU({ domain: 'benchmark', title: { en: `KU ${i}` }, provenance: prov })
    const claimCount = 2 + (i % 3)
    for (let c = 0; c < claimCount; c++) {
      ku.structured.claims.push(createClaim({
        type: 'factual',
        subject: `entity-${i % Math.max(1, Math.floor(size / 10))}`,
        predicate: `predicate-${c % 5}`,
        object: `value-${i}-${c}`,
        confidence: 0.8,
        provenanceRef: prov.id,
      }))
    }
    if (i > 0) {
      const relationCount = 1 + (i % 2)
      for (let r = 0; r < relationCount; r++) {
        const targetIdx = Math.floor(Math.random() * i)
        ku.structured.relations.push({
          id: uuidv7(), type: 'related',
          sourceKuId: ku.id, targetKuId: kuIds[targetIdx],
          confidence: 0.8, confirmedBy: [],
        })
      }
    }
    graph.addKU(ku)
    kuIds.push(ku.id)
  }

  return { graph, kuIds }
}

/**
 * Power-law (Barabási–Albert preferential attachment) graph.
 * Each new node attaches to m=3 existing nodes, chosen proportional to degree.
 */
function buildPowerLawGraph(size: number, m = 3): { graph: RelationGraph; kuIds: string[] } {
  const graph = new RelationGraph()
  const kuIds: string[] = []
  const degrees: number[] = []
  const prov = createProvenance({ did: 'did:key:bench-pl', type: 'agent', method: 'synthesis' })

  for (let i = 0; i < size; i++) {
    const ku = createKU({ domain: 'benchmark', title: { en: `PL-KU ${i}` }, provenance: prov })
    ku.structured.claims.push(createClaim({
      type: 'factual',
      subject: `entity-${i % Math.max(1, Math.floor(size / 20))}`,
      predicate: `predicate-${i % 5}`,
      object: `value-${i}`,
      confidence: 0.8,
      provenanceRef: prov.id,
    }))

    if (i >= m) {
      // Preferential attachment: pick m targets, weighted by degree
      const totalDegree = degrees.reduce((s, d) => s + d + 1, 0)
      const chosen = new Set<number>()
      let attempts = 0
      while (chosen.size < Math.min(m, i) && attempts < i * 3) {
        attempts++
        let rand = Math.random() * totalDegree
        for (let j = 0; j < i; j++) {
          rand -= degrees[j] + 1
          if (rand <= 0 && !chosen.has(j)) {
            chosen.add(j)
            break
          }
        }
      }
      for (const targetIdx of chosen) {
        ku.structured.relations.push({
          id: uuidv7(), type: 'related',
          sourceKuId: ku.id, targetKuId: kuIds[targetIdx],
          confidence: 0.8, confirmedBy: [],
        })
        degrees[targetIdx] = (degrees[targetIdx] ?? 0) + 1
      }
    }

    graph.addKU(ku)
    kuIds.push(ku.id)
    degrees.push(0)
  }

  return { graph, kuIds }
}

function measureMemoryMB(): number {
  const mem = process.memoryUsage()
  return Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10
}

async function benchmarkSingleSize(
  size: number,
  builder: (n: number) => { graph: RelationGraph; kuIds: string[] },
  label: 'uniform' | 'power-law'
): Promise<GraphScaleResult> {
  const gcBefore = measureMemoryMB()
  const buildStart = performance.now()
  const { graph, kuIds } = builder(size)
  const buildTimeMs = Math.round((performance.now() - buildStart) * 10) / 10
  const memoryMB = Math.max(0, measureMemoryMB() - gcBefore)

  const prov = createProvenance({ did: 'did:key:bench', type: 'agent', method: 'synthesis' })
  const times: number[] = []
  let contradictionsFound = 0

  const sampleSize = Math.min(50, size)
  for (let i = 0; i < sampleSize; i++) {
    const targetKuId = kuIds[Math.floor(Math.random() * kuIds.length)]
    const newClaim = createClaim({
      type: 'factual',
      subject: `entity-${i % Math.max(1, Math.floor(size / 10))}`,
      predicate: `predicate-${i % 5}`,
      object: `conflict-value-${i}`,
      confidence: 0.7,
      provenanceRef: prov.id,
    })

    const start = performance.now()
    const contradictions = graph.checkContradictions(newClaim, targetKuId, 2)
    times.push(performance.now() - start)
    contradictionsFound += contradictions.length
  }

  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0

  return {
    graphSize: size,
    buildTimeMs,
    memoryMB,
    stage2MedianMs: Math.round(median * 1000) / 1000,
    stage2P95Ms: Math.round(p95 * 1000) / 1000,
    contradictionsFound,
    degreeDistribution: label,
  }
}

export async function benchmarkGraphScale(
  sizes = [100, 1000, 10000]
): Promise<GraphScaleResult[]> {
  const results: GraphScaleResult[] = []
  for (const size of sizes) {
    results.push(await benchmarkSingleSize(size, buildUniformGraph, 'uniform'))
  }
  return results
}

export async function benchmarkGraphScalePowerLaw(
  sizes = [100, 1000, 10000]
): Promise<GraphScaleResult[]> {
  const results: GraphScaleResult[] = []
  for (const size of sizes) {
    results.push(await benchmarkSingleSize(size, buildPowerLawGraph, 'power-law'))
  }
  return results
}

export async function benchmarkGraphScale100k(): Promise<GraphScaleResult> {
  return benchmarkSingleSize(100_000, buildUniformGraph, 'uniform')
}
