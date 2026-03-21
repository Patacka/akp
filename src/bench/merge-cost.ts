import * as Automerge from '@automerge/automerge'
import { createKU, createProvenance, createClaim } from '../core/ku.js'
import { v7 as uuidv7 } from 'uuid'

export interface MergeCostResult {
  concurrentWriters: number
  changesPerWriter: number
  totalMergeMs: number
  perOpMedianMs: number
  finalDocBytes: number
}

type AKUDoc = { ku: Record<string, unknown> }

function applyChanges(
  baseDoc: Automerge.Doc<AKUDoc>,
  writerIdx: number,
  changesCount: number,
  provId: string
): Automerge.Doc<AKUDoc> {
  let doc = Automerge.clone(baseDoc)
  for (let i = 0; i < changesCount; i++) {
    doc = Automerge.change(doc, (d) => {
      const claims = (d.ku as Record<string, unknown>).structured as Record<string, unknown>
      const claimsArr = claims.claims as Array<Record<string, unknown>>
      claimsArr.push({
        id: uuidv7(),
        type: 'factual',
        subject: `writer-${writerIdx}-entity-${i}`,
        predicate: 'hasValue',
        object: `val-${i}`,
        confidence: 0.8,
        provenanceRef: provId,
      })
    })
  }
  return doc
}

export async function benchmarkMergeCost(
  writerCounts = [1, 2, 5, 10],
  changesPerWriter = 10
): Promise<MergeCostResult[]> {
  const results: MergeCostResult[] = []
  const prov = createProvenance({ did: 'did:key:bench', type: 'agent', method: 'synthesis' })

  for (const writerCount of writerCounts) {
    // Create base document
    const ku = createKU({
      domain: 'benchmark',
      title: { en: 'Merge benchmark KU' },
      provenance: prov,
    })

    let baseDoc = Automerge.init<AKUDoc>()
    baseDoc = Automerge.change(baseDoc, (d) => {
      d.ku = JSON.parse(JSON.stringify(ku)) as Record<string, unknown>
    })

    // Each writer independently applies changes from base
    const writerDocs: Automerge.Doc<AKUDoc>[] = []
    for (let w = 0; w < writerCount; w++) {
      writerDocs.push(applyChanges(baseDoc, w, changesPerWriter, prov.id))
    }

    // Merge all writers sequentially, measure time
    const start = performance.now()
    let merged = writerDocs[0]
    for (let w = 1; w < writerDocs.length; w++) {
      merged = Automerge.merge(merged, writerDocs[w])
    }
    const totalMs = performance.now() - start

    const finalBinary = Automerge.save(merged)
    const totalOps = writerCount * changesPerWriter
    const perOpMedianMs = totalMs / totalOps

    results.push({
      concurrentWriters: writerCount,
      changesPerWriter,
      totalMergeMs: Math.round(totalMs * 100) / 100,
      perOpMedianMs: Math.round(perOpMedianMs * 1000) / 1000,
      finalDocBytes: finalBinary.byteLength,
    })
  }

  return results
}
