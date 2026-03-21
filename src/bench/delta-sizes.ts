import { KUStore } from '../core/store.js'
import { createKU, createProvenance, createClaim } from '../core/ku.js'
import { v7 as uuidv7 } from 'uuid'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

export interface DeltaBenchResult {
  op: string
  samples: number
  median: number
  p95: number
  p99: number
  min: number
  max: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.floor((p / 100) * sorted.length)
  return sorted[Math.min(idx, sorted.length - 1)]
}

// Measure a single operation on a fresh document each time.
// This avoids document-growth bias where each Automerge.save()
// becomes slower as the doc accumulates hundreds of prior changes.
function measureOp(
  tmpDir: string,
  opName: string,
  setup: (store: KUStore, prov: ReturnType<typeof createProvenance>) => string,
  op: (store: KUStore, kuId: string, i: number, prov: ReturnType<typeof createProvenance>) => void,
  repetitions: number
): number[] {
  const sizes: number[] = []

  for (let i = 0; i < repetitions; i++) {
    const dbPath = join(tmpDir, `${opName}-${i}.db`)
    const store = new KUStore({ dbPath })
    const prov = createProvenance({ did: 'did:key:bench', type: 'agent', method: 'synthesis' })
    const kuId = setup(store, prov)

    const before = store.getAutomergeBinary(kuId)!.byteLength
    op(store, kuId, i, prov)
    const after = store.getAutomergeBinary(kuId)!.byteLength

    sizes.push(after - before)
    store.close()
  }

  return sizes
}

function freshKU(store: KUStore, prov: ReturnType<typeof createProvenance>): string {
  const ku = createKU({
    domain: 'benchmark',
    title: { en: 'Benchmark KU' },
    summary: 'A benchmark knowledge unit',
    provenance: prov,
  })
  return store.create(ku)
}

function freshKUWithClaim(store: KUStore, prov: ReturnType<typeof createProvenance>): string {
  const ku = createKU({
    domain: 'benchmark',
    title: { en: 'Benchmark KU' },
    summary: 'A benchmark knowledge unit',
    provenance: prov,
  })
  const kuId = store.create(ku)
  store.update(kuId, (k) => {
    k.structured.claims.push(createClaim({
      type: 'factual',
      subject: 'seed-entity',
      predicate: 'hasProperty',
      object: 'seed-value',
      confidence: 0.8,
      provenanceRef: prov.id,
    }))
  }, 'seed_claim')
  return kuId
}

export async function benchmarkDeltaSizes(
  repetitions = 1000,
  tmpDir = 'C:/Temp/akp-bench-delta'
): Promise<DeltaBenchResult[]> {
  mkdirSync(tmpDir, { recursive: true })

  const ops: Array<{
    name: string
    setup: (store: KUStore, prov: ReturnType<typeof createProvenance>) => string
    op: (store: KUStore, kuId: string, i: number, prov: ReturnType<typeof createProvenance>) => void
  }> = [
    {
      name: 'add_claim',
      setup: freshKU,
      op: (store, kuId, i, prov) => store.update(kuId, (ku) => {
        ku.structured.claims.push(createClaim({
          type: 'factual',
          subject: `entity-${i}`,
          predicate: 'hasProperty',
          object: `value-${i}`,
          confidence: 0.8,
          provenanceRef: prov.id,
        }))
      }, 'add_claim'),
    },
    {
      name: 'edit_narrative',
      setup: freshKU,
      op: (store, kuId, i) => store.update(kuId, (ku) => {
        ku.narrative.body = `Paragraph ${i}: This is narrative content added to measure delta sizes for text edits.`
      }, 'edit_narrative'),
    },
    {
      name: 'add_tag',
      setup: freshKU,
      op: (store, kuId, i) => store.update(kuId, (ku) => {
        ku.meta.tags.push(`tag-${i}`)
      }, 'add_tag'),
    },
    {
      name: 'add_review',
      setup: freshKU,
      op: (store, kuId, i) => store.update(kuId, (ku) => {
        ku.reviews.push({
          id: uuidv7(),
          reviewerDid: `did:key:reviewer-${i}`,
          reviewerType: 'agent',
          timestamp: new Date().toISOString(),
          verdict: 'confirmed',
          scope: [],
          weight: 0.5,
        })
      }, 'add_review'),
    },
    {
      name: 'edit_claim_confidence',
      setup: freshKUWithClaim,
      op: (store, kuId, i) => store.update(kuId, (ku) => {
        ku.structured.claims[0].confidence = 0.5 + (i % 5) * 0.1
      }, 'edit_claim_confidence'),
    },
    {
      name: 'change_maturity',
      setup: freshKU,
      op: (store, kuId, i) => {
        const maturities: Array<'draft' | 'proposed' | 'validated' | 'stable'> = ['draft', 'proposed', 'validated', 'stable']
        store.update(kuId, (ku) => {
          ku.meta.maturity = maturities[i % 4]
        }, 'change_maturity')
      },
    },
  ]

  const results: DeltaBenchResult[] = []

  for (const { name, setup, op } of ops) {
    const opDir = join(tmpDir, name)
    mkdirSync(opDir, { recursive: true })
    const sizes = measureOp(opDir, name, setup, op, repetitions)
    const sorted = [...sizes].sort((a, b) => a - b)
    results.push({
      op: name,
      samples: sorted.length,
      median: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    })
    // Clean up per-op dbs to save space
    try { rmSync(opDir, { recursive: true }) } catch { /* ignore */ }
  }

  return results
}
