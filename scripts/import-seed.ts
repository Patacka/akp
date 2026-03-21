#!/usr/bin/env npx tsx
import { KUStore } from '../src/core/store.js'
import { RelationGraph } from '../src/core/graph.js'
import { createKU, createProvenance, createClaim } from '../src/core/ku.js'
import { runPipeline } from '../src/pipeline/index.js'
import { readFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../data/seed')
const DEFAULT_DB = join(__dirname, '../data/akp-seed.db')

async function importWikidata(store: KUStore, graph: RelationGraph): Promise<number> {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'wikidata-sample.json'), 'utf8')) as WikidataEntity[]
  let count = 0

  for (const entity of raw) {
    const label = entity.labels?.en ?? entity.id
    const description = entity.descriptions?.en ?? ''

    const prov = createProvenance({
      did: 'did:key:wikidata-importer',
      type: 'agent',
      method: 'retrieval',
      sources: [{
        id: crypto.randomUUID(),
        type: 'url',
        value: `https://www.wikidata.org/wiki/${entity.id}`,
        title: label,
      }],
    })

    const ku = createKU({
      domain: 'encyclopedic',
      title: { en: label },
      summary: description,
      tags: ['wikidata', entity.id],
      provenance: prov,
    })

    // Convert Wikidata claims to AKP claims
    if (entity.claims) {
      for (const [prop, claimValues] of Object.entries(entity.claims)) {
        for (const cv of claimValues.slice(0, 3)) {
          if (cv.value && typeof cv.value !== 'object') {
            ku.structured.claims.push(createClaim({
              type: 'factual',
              subject: label,
              predicate: prop,
              object: String(cv.value),
              confidence: 0.85,
              provenanceRef: prov.id,
            }))
          } else if (cv.value && typeof cv.value === 'object' && 'amount' in cv.value) {
            ku.structured.claims.push(createClaim({
              type: 'quantitative',
              subject: label,
              predicate: prop,
              object: cv.value.amount,
              confidence: 0.85,
              provenanceRef: prov.id,
            }))
          }
        }
      }
    }

    ku.narrative.body = description

    const result = await runPipeline(ku, graph, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity

    store.create(ku)
    graph.addKU(ku)
    count++
  }

  return count
}

interface WikidataEntity {
  id: string
  labels?: Record<string, string>
  descriptions?: Record<string, string>
  claims?: Record<string, Array<{ value: unknown }>>
}

interface PubMedArticle {
  pmid: string
  title: string
  abstract?: string
  authors?: string[]
  year?: number
}

async function importPubMed(store: KUStore, graph: RelationGraph): Promise<number> {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'pubmed-sample.json'), 'utf8')) as PubMedArticle[]
  let count = 0

  for (const article of raw) {
    const prov = createProvenance({
      did: 'did:key:pubmed-importer',
      type: 'agent',
      method: 'retrieval',
      sources: [{
        id: crypto.randomUUID(),
        type: 'pubmed',
        value: article.pmid,
        title: article.title,
        authors: article.authors,
        year: article.year,
      }],
    })

    const ku = createKU({
      domain: 'medicine',
      title: { en: article.title },
      summary: (article.abstract ?? '').slice(0, 200),
      tags: ['pubmed', `pmid:${article.pmid}`],
      provenance: prov,
    })

    ku.narrative.body = article.abstract ?? ''
    ku.narrative.summary = (article.abstract ?? '').slice(0, 200)

    const result = await runPipeline(ku, graph, { mockStage1: true })
    ku.meta.confidence = { aggregate: result.confidence.aggregate, lastComputed: result.checkedAt }
    ku.meta.maturity = result.maturity

    store.create(ku)
    graph.addKU(ku)
    count++
  }

  return count
}

// Main
const dbPath = process.argv[2] ?? DEFAULT_DB
mkdirSync(dirname(dbPath), { recursive: true })

const store = new KUStore({ dbPath })
const graph = new RelationGraph()

console.log(`Importing seed data into ${dbPath}...`)
const wikiCount = await importWikidata(store, graph)
console.log(`  Wikidata: ${wikiCount} KUs`)
const pubmedCount = await importPubMed(store, graph)
console.log(`  PubMed:   ${pubmedCount} KUs`)
console.log(`  Total:    ${wikiCount + pubmedCount} KUs`)
console.log('Done.')
store.close()
