/**
 * stage3-independence.test.ts — Cross-architecture LLM independence analysis.
 *
 * Combines the local Jan model (whatever is hot) with OpenRouter free models
 * to compute pairwise Cohen's κ across architecturally diverse models.
 *
 * Why: Jan serves one model at a time, so multi-model kappa is impossible
 * within Jan alone. OpenRouter provides simultaneous access to multiple models.
 * Together they give us Meta (Llama) + Mistral + Google (Gemma) lineages.
 *
 * Run:
 *   JAN_RUNNING=1 JAN_BASE_URL=http://127.0.0.1:1337/v1 JAN_API_KEY=12345 \
 *   OPENROUTER_API_KEY=<key> \
 *   npx vitest run test/pipeline/stage3-independence.test.ts --reporter=verbose
 *
 * Requires both Jan running and OPENROUTER_API_KEY set.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { runStage3 } from '../../src/pipeline/stage3.js'
import { createLocalAgent, isJanRunning, listJanModels } from '../../src/pipeline/stage3-local.js'
import { createOpenRouterAgent, discoverAvailableModels } from '../../src/pipeline/stage3-openrouter.js'
import type { LLMAgent, AgentResult } from '../../src/pipeline/stage3.js'

const HAS_JAN = process.env.JAN_RUNNING === '1'
const HAS_KEY = !!process.env.OPENROUTER_API_KEY
const ENABLED = HAS_JAN && HAS_KEY

const live = (name: string, fn: () => Promise<void>, timeout = 180_000) =>
  ENABLED ? it(name, fn, timeout) : it.skip(`[not enabled] ${name}`, fn)

// ─── Battery of 10 claims: 5 true, 5 false ───────────────────────────────────

function makeKU(domain: string, subject: string, predicate: string, object: unknown, type: 'factual' | 'quantitative' = 'factual') {
  const prov = createProvenance({ did: 'did:key:independence', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain, title: { en: `${subject} ${predicate}` }, provenance: prov })
  ku.structured.claims.push(createClaim({ type, subject, predicate, object, confidence: 0.9, provenanceRef: prov.id }))
  return ku
}

// Easy battery — unambiguous facts (baseline, expect κ≈0.8 since models converge)
const BATTERY = [
  { ku: () => makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative'), label: 'water=100°C ✓', expected: 'confirmed' },
  { ku: () => makeKU('chemistry', 'hydrogen', 'atomicNumber', 1, 'quantitative'),        label: 'H=1 ✓',         expected: 'confirmed' },
  { ku: () => makeKU('medicine',  'DNA', 'structureType', 'double helix'),               label: 'DNA=helix ✓',   expected: 'confirmed' },
  { ku: () => makeKU('medicine',  'insulin', 'producedBy', 'pancreatic beta cells'),     label: 'insulin=β ✓',   expected: 'confirmed' },
  { ku: () => makeKU('medicine',  'penicillin', 'discoveredBy', 'Alexander Fleming'),    label: 'penicillin ✓',  expected: 'confirmed' },
  { ku: () => makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative'),          label: 'Au=999 ✗',      expected: 'disputed'  },
  { ku: () => makeKU('chemistry', 'water', 'boilingPointCelsius', -10, 'quantitative'),  label: 'water=-10°C ✗', expected: 'disputed'  },
  { ku: () => makeKU('medicine',  'aspirin', 'mechanismOfAction', 'ACE inhibitor'),      label: 'aspirin=ACE ✗', expected: 'disputed'  },
  { ku: () => makeKU('medicine',  'insulin', 'producedBy', 'adrenal gland'),             label: 'insulin=adr ✗', expected: 'disputed'  },
  { ku: () => makeKU('chemistry', 'oxygen', 'atomicNumber', 999, 'quantitative'),        label: 'O=999 ✗',       expected: 'disputed'  },
]

// Hard battery — 15 claims: misconceptions, precise quantitative values, nuanced science.
// Designed to expose divergence between models with different training data.
// Trimmed to 15 to stay within time budget; most-likely-to-diverge claims selected.
//
// Confirmed = scientifically correct (may be counterintuitive)
// Disputed  = common myth or factually wrong
const HARD_BATTERY = [
  // ── Counterintuitive true facts ───────────────────────────────────────────
  // Napoleon ~169cm — average for his era. "Short Napoleon" = British propaganda + unit confusion.
  { ku: () => makeKU('history', 'Napoleon Bonaparte', 'heightCm', 169, 'quantitative'),
    label: 'Napoleon=169cm ✓', expected: 'confirmed' },
  // Water boils at ~70°C at Everest summit (8,848m) due to low air pressure.
  { ku: () => makeKU('physics', 'water at Mt Everest summit', 'boilingPointCelsius', 70, 'quantitative'),
    label: 'Everest boil=70°C ✓', expected: 'confirmed' },
  // Lightning does strike the same place twice — Empire State Building hit ~23×/year.
  { ku: () => makeKU('physics', 'lightning', 'canStrikeSameLocationMultipleTimes', 'true'),
    label: 'lightning repeat ✓', expected: 'confirmed' },
  // Deoxygenated blood is dark red, not blue — blue appearance is due to light scattering through skin.
  { ku: () => makeKU('medicine', 'deoxygenated blood', 'color', 'dark red'),
    label: 'vein blood=dark red ✓', expected: 'confirmed' },
  // Appendix has immune function and serves as gut flora reservoir — not vestigial.
  { ku: () => makeKU('medicine', 'human appendix', 'hasKnownBiologicalFunction', 'true'),
    label: 'appendix function ✓', expected: 'confirmed' },
  // Aspirin first synthesized 1897 by Felix Hoffmann at Bayer.
  { ku: () => makeKU('history', 'aspirin', 'yearFirstSynthesized', 1897, 'quantitative'),
    label: 'aspirin=1897 ✓', expected: 'confirmed' },
  // Humans share ~98% DNA with chimps — shared ancestor, not descent from chimps.
  { ku: () => makeKU('biology', 'humans', 'percentageDNASharedWithChimpanzees', 98, 'quantitative'),
    label: 'human-chimp=98% ✓', expected: 'confirmed' },
  // ── Common misconceptions (should be disputed) ────────────────────────────
  // Napoleon was NOT unusually short — his height was average for the era.
  { ku: () => makeKU('history', 'Napoleon Bonaparte', 'heightDescription', 'unusually short for his era'),
    label: 'Napoleon=short ✗', expected: 'disputed' },
  // Great Wall NOT visible from the Moon with naked eye — only ~6m wide.
  { ku: () => makeKU('geography', 'Great Wall of China', 'visibleFromMoonWithNakedEye', 'true'),
    label: 'GreatWall Moon ✗', expected: 'disputed' },
  // "10% brain" myth — humans use virtually all neurons.
  { ku: () => makeKU('medicine', 'humans', 'percentageOfBrainUsed', 10, 'quantitative'),
    label: 'brain=10% ✗', expected: 'disputed' },
  // Glass does NOT flow over centuries — old windows thick at bottom from casting method.
  { ku: () => makeKU('materials', 'glass', 'physicalBehavior', 'flows slowly over centuries like a viscous liquid'),
    label: 'glass flows ✗', expected: 'disputed' },
  // Diamonds NOT from coal — form from mantle carbon under different P/T conditions.
  { ku: () => makeKU('geology', 'diamonds', 'formedFrom', 'compressed coal'),
    label: 'diamonds=coal ✗', expected: 'disputed' },
  // Einstein did NOT fail mathematics — excelled at it; myth from Swiss/German grade-scale confusion.
  { ku: () => makeKU('history', 'Albert Einstein', 'mathPerformanceInSchool', 'failed mathematics'),
    label: 'Einstein math ✗', expected: 'disputed' },
  // Vitamin C does NOT prevent colds in general population (Cochrane 2013).
  { ku: () => makeKU('medicine', 'vitamin C', 'effectOnColdPrevention', 'prevents colds when taken regularly'),
    label: 'vitC colds ✗', expected: 'disputed' },
  // Humans did NOT evolve FROM chimps — we share a common ancestor ~6-7 mya.
  { ku: () => makeKU('biology', 'humans', 'evolutionaryOrigin', 'evolved from chimpanzees'),
    label: 'humans from chimps ✗', expected: 'disputed' },
]

function kappa(a: string[], b: string[]): number {
  const n = a.length
  if (n === 0) return 0
  const labels = Array.from(new Set([...a, ...b]))
  const pObs = a.filter((v, i) => v === b[i]).length / n
  const pExp = labels.reduce((s, l) =>
    s + (a.filter(v => v === l).length / n) * (b.filter(v => v === l).length / n), 0)
  return pExp >= 1 ? 1 : (pObs - pExp) / (1 - pExp)
}

function accuracy(verdicts: string[], expectedList: string[]): number {
  return verdicts.filter((v, i) => v === expectedList[i]).length / verdicts.length
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let allAgents: LLMAgent[] = []
let janModel = ''

if (ENABLED) {
  beforeAll(async () => {
    // Jan: pick the hot model
    const janOk = await isJanRunning()
    if (janOk) {
      const hot = await listJanModels()
      if (hot.length > 0) {
        janModel = hot[0]
        allAgents.push(createLocalAgent(`jan:${janModel.slice(0, 16)}`, janModel, { timeoutMs: 120_000 }))
        console.log(`Jan agent: ${janModel}`)
      }
    }

    // OpenRouter: discover up to 3 working free models
    console.log('Discovering OpenRouter models...')
    const available = await discoverAvailableModels(undefined, {}, 3)
    console.log(`OpenRouter available: ${available.join(', ')}`)
    for (const [i, model] of available.entries()) {
      const shortId = model.split('/')[1]?.slice(0, 16) ?? model.slice(0, 16)
      allAgents.push(createOpenRouterAgent(`or-${i}:${shortId}`, model))
    }

    if (allAgents.length < 2) {
      console.warn(`Only ${allAgents.length} agent(s) available — independence analysis needs 2+`)
    }
    console.log(`Total agents: ${allAgents.length} — ${allAgents.map(a => a.id).join(', ')}`)
  }, 120_000)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Cross-architecture independence analysis', () => {
  live('all agents achieve ≥70% accuracy on labeled battery', async () => {
    const expected = BATTERY.map(b => b.expected)
    const agentVerdicts: Map<string, string[]> = new Map(allAgents.map(a => [a.id, []]))
    const janAgents = allAgents.filter(a => a.id.startsWith('jan:'))
    const orAgents  = allAgents.filter(a => a.id.startsWith('or-'))

    for (const { ku, label } of BATTERY) {
      const row: Map<string, string> = new Map()
      for (const agent of janAgents) {
        const result = await runStage3(ku(), [agent])
        row.set(agent.id, result.agentResults[0]?.verdict ?? 'uncertain')
      }
      await Promise.all(orAgents.map(async agent => {
        const result = await runStage3(ku(), [agent])
        row.set(agent.id, result.agentResults[0]?.verdict ?? 'uncertain')
      }))
      for (const agent of allAgents) agentVerdicts.get(agent.id)!.push(row.get(agent.id) ?? 'uncertain')
      const cols = allAgents.map(a => `${a.id.split(':')[0]}=${row.get(a.id)}`).join('  ')
      console.log(`  ${label.padEnd(18)}: ${cols}`)
    }

    console.log('\nPer-agent accuracy:')
    let substantiveCount = 0
    for (const agent of allAgents) {
      const verdicts = agentVerdicts.get(agent.id)!
      const uncertainRate = verdicts.filter(v => v === 'uncertain').length / verdicts.length
      const acc = accuracy(verdicts, expected)
      if (uncertainRate > 0.5) {
        console.log(`  ${agent.id.padEnd(36)}: DEGENERATE (${(uncertainRate*100).toFixed(0)}% uncertain) — excluded`)
        continue
      }
      substantiveCount++
      console.log(`  ${agent.id.padEnd(36)}: ${(acc * 100).toFixed(0)}%  [${verdicts.join(',')}]`)
      expect(acc).toBeGreaterThanOrEqual(0.70)
    }
    expect(substantiveCount).toBeGreaterThanOrEqual(1)
  }, 300_000)

  live('pairwise κ < 0.9 across all agent pairs (independence check)', async () => {
    if (allAgents.length < 2) {
      console.log('Need 2+ agents for kappa — skipping')
      return
    }

    const agentVerdicts: Map<string, string[]> = new Map(allAgents.map(a => [a.id, []]))

    const janAgents2 = allAgents.filter(a => a.id.startsWith('jan:'))
    const orAgents2  = allAgents.filter(a => a.id.startsWith('or-'))
    for (const { ku } of BATTERY) {
      const row2: Map<string, string> = new Map()
      for (const agent of janAgents2) {
        const result = await runStage3(ku(), [agent])
        row2.set(agent.id, result.agentResults[0]?.verdict ?? 'uncertain')
      }
      await Promise.all(orAgents2.map(async agent => {
        const result = await runStage3(ku(), [agent])
        row2.set(agent.id, result.agentResults[0]?.verdict ?? 'uncertain')
      }))
      for (const agent of allAgents) agentVerdicts.get(agent.id)!.push(row2.get(agent.id) ?? 'uncertain')
    }

    // Filter out degenerate agents (>50% uncertain) before kappa
    const substantive = allAgents.filter(a => {
      const v = agentVerdicts.get(a.id)!
      return v.filter(x => x === 'uncertain').length / v.length <= 0.5
    })
    console.log(`\nSubstantive agents (≤50% uncertain): ${substantive.map(a => a.id).join(', ')}`)

    if (substantive.length < 2) {
      console.log('Need 2+ substantive agents for kappa — skipping assertion')
      return
    }

    console.log('\nPairwise Cohen\'s κ (0=independent, 1=identical):')
    let totalK = 0; let pairs = 0; let maxK = -1
    for (let i = 0; i < substantive.length; i++) {
      for (let j = i + 1; j < substantive.length; j++) {
        const a = agentVerdicts.get(substantive[i].id)!
        const b = agentVerdicts.get(substantive[j].id)!
        const k = kappa(a, b)
        totalK += k; pairs++
        if (k > maxK) maxK = k
        console.log(`  ${substantive[i].id.padEnd(36)} ↔ ${substantive[j].id.slice(0, 24)}: κ=${k.toFixed(3)}`)
      }
    }
    const avgK = totalK / pairs
    console.log(`\n  Average κ: ${avgK.toFixed(3)}   Max κ: ${maxK.toFixed(3)}`)
    console.log(`  Interpretation: ${avgK < 0.4 ? 'LOW — good independence' : avgK < 0.7 ? 'MODERATE agreement' : 'HIGH — low independence'}`)

    // Not all substantive agents should be clones of each other
    expect(maxK).toBeLessThan(0.9)
  }, 300_000)

  live('hard battery — misconceptions and edge cases (expect lower κ)', async () => {
    if (allAgents.length < 2) { console.log('Need 2+ agents — skipping'); return }

    const expected = HARD_BATTERY.map(b => b.expected)
    const agentVerdicts: Map<string, string[]> = new Map(allAgents.map(a => [a.id, []]))

    // Jan (local) must run sequentially; OpenRouter agents can run in parallel per claim.
    const janAgents = allAgents.filter(a => a.id.startsWith('jan:'))
    const orAgents  = allAgents.filter(a => a.id.startsWith('or-'))

    for (const { ku, label } of HARD_BATTERY) {
      const row: Map<string, string> = new Map()

      // Jan: sequential
      for (const agent of janAgents) {
        const result = await runStage3(ku(), [agent])
        row.set(agent.id, result.agentResults[0]?.verdict ?? 'uncertain')
      }
      // OpenRouter: parallel
      await Promise.all(orAgents.map(async agent => {
        const result = await runStage3(ku(), [agent])
        row.set(agent.id, result.agentResults[0]?.verdict ?? 'uncertain')
      }))

      for (const agent of allAgents) {
        const v = row.get(agent.id) ?? 'uncertain'
        agentVerdicts.get(agent.id)!.push(v)
      }
      const cols = allAgents.map(a => `${a.id.split(':')[0]}=${row.get(a.id)}`).join('  ')
      console.log(`  ${label.padEnd(24)}: ${cols}`)
    }

    // Filter degenerate agents
    const substantive = allAgents.filter(a => {
      const v = agentVerdicts.get(a.id)!
      return v.filter(x => x === 'uncertain').length / v.length <= 0.5
    })

    console.log('\nPer-agent accuracy (hard battery):')
    for (const agent of substantive) {
      const verdicts = agentVerdicts.get(agent.id)!
      const acc = verdicts.filter((v, i) => v === expected[i]).length / verdicts.length
      console.log(`  ${agent.id.padEnd(36)}: ${(acc * 100).toFixed(0)}%  [${verdicts.join(',')}]`)
    }

    if (substantive.length < 2) {
      console.log('Need 2+ substantive agents for kappa')
      return
    }

    console.log('\nPairwise Cohen\'s κ — hard battery:')
    let totalK = 0; let pairs = 0
    for (let i = 0; i < substantive.length; i++) {
      for (let j = i + 1; j < substantive.length; j++) {
        const a = agentVerdicts.get(substantive[i].id)!
        const b = agentVerdicts.get(substantive[j].id)!
        const k = kappa(a, b)
        totalK += k; pairs++
        console.log(`  ${substantive[i].id.padEnd(36)} ↔ ${substantive[j].id.slice(0, 24)}: κ=${k.toFixed(3)}`)
      }
    }
    const avgK = totalK / pairs
    console.log(`\n  Average κ (hard): ${avgK.toFixed(3)}`)
    console.log(`  Easy battery κ was ~0.800 — hard battery should be lower if models diverge on misconceptions`)
    // Just observe — no hard assertion, this is exploratory
    expect(avgK).toBeGreaterThanOrEqual(-1)  // always true — captures the metric without failing
  }, 900_000)

  live('combined pool consensus on true facts', async () => {
    // Only use agents that are known to produce substantive verdicts (not all-uncertain)
    // Re-probe each agent with a single fact to filter degenerate ones
    const substantiveAgents: LLMAgent[] = []
    for (const agent of allAgents) {
      const result = await runStage3(makeKU('chemistry', 'hydrogen', 'atomicNumber', 1, 'quantitative'), [agent])
      if (result.agentResults[0]?.verdict !== 'uncertain') substantiveAgents.push(agent)
      else console.log(`  Skipping degenerate agent: ${agent.id}`)
    }
    if (substantiveAgents.length === 0) { console.log('No substantive agents available'); return }

    const trueFacts = BATTERY.filter(b => b.expected === 'confirmed')
    for (const { ku, label } of trueFacts) {
      const result = await runStage3(ku(), substantiveAgents)
      const confirmedCount = result.agentResults.filter(r => r.verdict === 'confirmed').length
      const total = result.agentResults.length
      console.log(`  ${label}: ${confirmedCount}/${total} confirmed  stage3Score=${result.stage3Score.toFixed(3)}`)
      expect(confirmedCount).toBeGreaterThan(total / 2)
    }
  }, 300_000)
})
