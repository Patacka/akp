/**
 * stage3-local.test.ts — Stage 3 corroboration using self-hosted models via Jan.
 *
 * Jan serves ONE model at a time. This test explicitly loads/unloads models
 * using the Jan management API before each call.
 *
 * Run: JAN_RUNNING=1 npx vitest run test/pipeline/stage3-local.test.ts --reporter=verbose
 *
 * Models downloaded in Jan (update DOWNLOADED_MODELS to match your Jan catalog):
 *   - gemma-2-9b-it-abliterated-IQ4_XS   ~5.5GB
 *   - Mistral-7B-Instruct-v0_3_IQ4_XS    ~4.1GB
 *   - llama3.1-8b-instruct               ~5.4GB  (optional, add for 3-agent pool)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createKU, createProvenance, createClaim } from '../../src/core/ku.js'
import { runStage3, createMockAgent } from '../../src/pipeline/stage3.js'
import { createDefaultGovernanceState } from '../../src/core/governance.js'
import { RelationGraph as _RelGraph } from '../../src/core/graph.js'
import {
  createLocalAgent,
  isJanRunning,
  listJanModels,
  startJanModel,
} from '../../src/pipeline/stage3-local.js'
import { runPipeline } from '../../src/pipeline/index.js'
import { RelationGraph } from '../../src/core/graph.js'
import type { LLMAgent, AgentResult } from '../../src/pipeline/stage3.js'

const JAN_ACTIVE = process.env.JAN_RUNNING === '1'
const live = (name: string, fn: () => Promise<void>, timeout = 180_000) =>
  JAN_ACTIVE ? it(name, fn, timeout) : it.skip(`[Jan not running] ${name}`, fn)

/**
 * Models you have downloaded in Jan — use exact IDs from Jan's model catalog.
 * Jan auto-swaps when a different model is requested via the start API.
 */
const DOWNLOADED_MODELS = [
  'gemma-2-9b-it-abliterated-IQ4_XS',
  'Mistral-7B-Instruct-v0_3_IQ4_XS',
  'Llama-3_1-8B-Instruct-IQ4_XS',
]

let hotModel: string = ''

function kappa(a: string[], b: string[]): number {
  const n = a.length; if (n === 0) return 0
  const labels = Array.from(new Set([...a, ...b]))
  const pObs = a.filter((v, i) => v === b[i]).length / n
  const pExp = labels.reduce((s, l) =>
    s + (a.filter(v => v === l).length / n) * (b.filter(v => v === l).length / n), 0)
  return pExp >= 1 ? 1 : (pObs - pExp) / (1 - pExp)
}

function makeKU(domain: string, subject: string, predicate: string, object: unknown, type: 'factual' | 'quantitative' = 'factual') {
  const prov = createProvenance({ did: 'did:key:local', type: 'agent', method: 'synthesis' })
  const ku = createKU({ domain, title: { en: `${subject} ${predicate}` }, provenance: prov })
  ku.structured.claims.push(createClaim({ type, subject, predicate, object, confidence: 0.9, provenanceRef: prov.id }))
  return ku
}

if (JAN_ACTIVE) {
  beforeAll(async () => {
    const running = await isJanRunning()
    if (!running) throw new Error('Jan server not reachable at ' + (process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'))
    const loaded = await listJanModels()
    hotModel = loaded[0] ?? DOWNLOADED_MODELS[0]
    console.log(`Jan currently hot: ${loaded.join(', ') || '(none)'}`)
    console.log(`Downloaded pool: ${DOWNLOADED_MODELS.join(', ')}`)
    console.log(`Will use for battery: ${hotModel}`)
  }, 15_000)
}

// ─── Server health ────────────────────────────────────────────────────────────

describe('Jan server', () => {
  live('is reachable and lists models', async () => {
    expect(await isJanRunning()).toBe(true)
    const models = await listJanModels()
    console.log(`Hot models: ${models.join(', ')}`)
    expect(models.length).toBeGreaterThan(0)
  })
})

// ─── Factual accuracy battery (runs on currently hot model) ──────────────────

describe('Stage 3 — factual accuracy battery', () => {
  const battery = [
    { ku: () => makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative'), label: 'water=100°C', expected: 'confirmed', variant: 'reproduction' as const },
    { ku: () => makeKU('chemistry', 'water', 'boilingPointCelsius', -10, 'quantitative'), label: 'water=-10°C (false)', expected: 'disputed', variant: 'falsification' as const },
    { ku: () => makeKU('chemistry', 'hydrogen', 'atomicNumber', 1, 'quantitative'), label: 'H atomicNumber=1', expected: 'confirmed', variant: 'reproduction' as const },
    { ku: () => makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative'), label: 'Au atomicNumber=999 (false)', expected: 'disputed', variant: 'falsification' as const },
    { ku: () => makeKU('medicine', 'DNA', 'structureType', 'double helix'), label: 'DNA=double helix', expected: 'confirmed', variant: 'triangulation' as const },
    { ku: () => makeKU('medicine', 'aspirin', 'mechanismOfAction', 'ACE inhibitor'), label: 'aspirin=ACE inhibitor (false)', expected: 'disputed', variant: 'falsification' as const },
    { ku: () => makeKU('medicine', 'insulin', 'producedBy', 'pancreatic beta cells'), label: 'insulin=beta cells', expected: 'confirmed', variant: 'triangulation' as const },
    { ku: () => makeKU('medicine', 'penicillin', 'discoveredBy', 'Alexander Fleming'), label: 'penicillin=Fleming', expected: 'confirmed', variant: 'triangulation' as const },
  ]

  for (const { label, expected, variant, ku: makeTestKU } of battery) {
    live(`[${expected}] ${label}`, async () => {
      // Ensure the hot model is loaded (Jan may have unloaded it)
      await startJanModel(hotModel)
      const agent = createLocalAgent('battery-agent', hotModel, { timeoutMs: 120_000 })
      const result = await runStage3(makeTestKU(), [agent], { variant })
      const ar = result.agentResults[0]
      console.log(`  [${agent.model}] ${label}`)
      console.log(`    verdict=${ar.verdict} conf=${ar.confidence?.toFixed(2)}`)
      console.log(`    reasoning: ${ar.reasoning?.slice(0, 120)}`)
      if (ar.counterexamples?.length) console.log(`    counterexamples: ${ar.counterexamples.join('; ')}`)
      expect(ar.verdict).toBe(expected)
    })
  }
})

// ─── Independence analysis (uses models currently hot in Jan) ─────────────────
//
// Jan's model management API (/start, /stop) is not exposed in all versions —
// model loading is controlled via the Jan desktop UI.
//
// To run the full independence analysis:
//   1. Load each model in Jan one at a time and run this test suite
//   2. Or: run with JAN_MODEL_OVERRIDE=<id> to test a specific model
//      e.g. JAN_MODEL_OVERRIDE=Llama-3_1-8B-Instruct-IQ4_XS JAN_RUNNING=1 npx vitest run ...
//
// When only 1 model is hot this test still passes — it logs verdicts and skips kappa.

describe('Independence analysis — pairwise kappa', () => {
  live('measures inter-model agreement across mixed true/false claims', async () => {
    // Determine which downloaded models are currently hot
    const currentlyHot = await listJanModels()
    const activeModels = DOWNLOADED_MODELS.filter(m => currentlyHot.includes(m))

    if (activeModels.length === 0) {
      console.log('No downloaded models are currently hot in Jan — skipping independence analysis')
      console.log(`Hot: ${currentlyHot.join(', ') || '(none)'}`)
      console.log(`Downloaded pool: ${DOWNLOADED_MODELS.join(', ')}`)
      return
    }

    if (activeModels.length < 2) {
      console.log(`Only 1 downloaded model is hot: ${activeModels[0]}`)
      console.log('Load 2+ models in Jan for full independence analysis.')
      console.log('Recommended: switch between models in Jan UI and re-run this test.')
    }

    const battery = [
      { ku: makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative'), label: 'water=100°C ✓' },
      { ku: makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative'), label: 'Au=999 ✗' },
      { ku: makeKU('medicine', 'DNA', 'structureType', 'double helix'), label: 'DNA=helix ✓' },
      { ku: makeKU('medicine', 'aspirin', 'mechanismOfAction', 'ACE inhibitor'), label: 'aspirin=ACE ✗' },
      { ku: makeKU('chemistry', 'hydrogen', 'atomicNumber', 1, 'quantitative'), label: 'H=1 ✓' },
      { ku: makeKU('medicine', 'insulin', 'producedBy', 'adrenal gland'), label: 'insulin=adrenal ✗' },
    ]

    // Collect verdicts for each active model
    const modelVerdicts: Map<string, string[]> = new Map(activeModels.map(m => [m, []]))

    for (const { ku, label } of battery) {
      const rowVerdicts: string[] = []
      for (const modelId of activeModels) {
        const agent = createLocalAgent(modelId, modelId, { timeoutMs: 120_000 })
        const result = await runStage3(ku, [agent])
        const verdict = result.agentResults[0]?.verdict ?? 'uncertain'
        modelVerdicts.get(modelId)!.push(verdict)
        rowVerdicts.push(verdict)
      }
      const modelLabels = activeModels.map((m, i) => m.slice(0, 12) + '=' + rowVerdicts[i])
      console.log(`  ${label.padEnd(22)}: ${modelLabels.join('  ')}`)
    }

    // Pairwise kappa — only meaningful with 2+ models
    if (activeModels.length >= 2) {
      console.log('\nPairwise Cohen\'s κ:')
      let totalK = 0; let pairs = 0
      for (let i = 0; i < activeModels.length; i++) {
        for (let j = i + 1; j < activeModels.length; j++) {
          const a = modelVerdicts.get(activeModels[i])!
          const b = modelVerdicts.get(activeModels[j])!
          const k = kappa(a, b)
          totalK += k; pairs++
          console.log(`  ${activeModels[i].slice(0, 20)} ↔ ${activeModels[j].slice(0, 20)}: κ=${k.toFixed(3)}`)
        }
      }
      const avgK = totalK / pairs
      console.log(`  Average κ: ${avgK.toFixed(3)} (0=independent, 1=identical)`)
      expect(avgK).toBeLessThan(1.0)
    } else {
      console.log('\nSkipping kappa — need 2+ models hot simultaneously.')
      console.log('Load multiple models in Jan UI and re-run for independence metrics.')
    }
  }, 300_000)
})

// ─── Full pipeline ─────────────────────────────────────────────────────────────

describe('Full pipeline — local Stage 3', () => {
  live('true claim confidence rises with Stage 3 corroboration', async () => {
    await startJanModel(hotModel)
    const agent = createLocalAgent('pipeline-agent', hotModel, { timeoutMs: 120_000 })
    const graph = new RelationGraph()
    const ku = makeKU('chemistry', 'water', 'boilingPointCelsius', 100, 'quantitative')
    graph.addKU(ku)

    const withoutS3 = await runPipeline(ku, graph, { mockStage1: true })
    const withS3 = await runPipeline(ku, graph, { mockStage1: true, runStage3: true, agents: [agent] })

    console.log(`Without Stage3: ${withoutS3.confidence.aggregate.toFixed(3)} (${withoutS3.maturity})`)
    console.log(`With Stage3:    ${withS3.confidence.aggregate.toFixed(3)} (${withS3.maturity})`)
    console.log(`Stage3 score:   ${withS3.stage3?.stage3Score.toFixed(3)}  consensus=${withS3.stage3?.consensusReached}`)
    console.log(`Model: ${hotModel}`)

    expect(withS3.confidence.aggregate).toBeGreaterThanOrEqual(withoutS3.confidence.aggregate)
  })

  live('false claim Stage3 score is low (agents dispute it)', async () => {
    await startJanModel(hotModel)
    const agent = createLocalAgent('pipeline-agent', hotModel, { timeoutMs: 120_000 })
    const graph = new RelationGraph()
    const ku = makeKU('chemistry', 'gold', 'atomicNumber', 999, 'quantitative')
    graph.addKU(ku)

    const result = await runPipeline(ku, graph, {
      mockStage1: true, runStage3: true, agents: [agent], weights: undefined,
    })
    console.log(`False claim: conf=${result.confidence.aggregate.toFixed(3)} stage3=${result.stage3?.stage3Score.toFixed(3)} maturity=${result.maturity}`)
    expect(result.stage3?.stage3Score ?? 1).toBeLessThan(0.5)
    expect(result.maturity).not.toBe('stable')
  })
})

// ── minCalibrationAccuracy gating (unit tests, no external LLM) ───────────────

describe('minCalibrationAccuracy gating', () => {
  function makeSimpleKU() {
    const prov = createProvenance({ did: 'did:key:test', type: 'agent', method: 'observation' })
    return createKU({ domain: 'test', title: { en: 'Calibration gate test' }, provenance: prov })
  }

  it('runs stage3 when minCalibrationAccuracy is 0 (default)', async () => {
    const ku = makeSimpleKU()
    const graph = new _RelGraph()
    graph.addKU(ku)
    const agent = createMockAgent('a1', 'mock', 'confirm')
    const gov = createDefaultGovernanceState()  // minCalibrationAccuracy defaults to 0

    const result = await runPipeline(ku, graph, {
      mockStage1: true,
      runStage3: true,
      agents: [agent],
      governance: gov,
    })
    // With threshold=0 calibration is skipped entirely; stage3 should run
    expect(result.stage3).toBeDefined()
  })

  it('blocks stage3 when agent fails calibration threshold', async () => {
    const ku = makeSimpleKU()
    const graph = new _RelGraph()
    graph.addKU(ku)

    // An agent that always returns garbage — will fail calibration
    const badAgent = {
      id: 'bad', model: 'bad-model',
      async call(_s: string, _u: string) { return '{"verdict":"unknown"}' },
    }
    const gov = createDefaultGovernanceState()
    gov.parameters.minCalibrationAccuracy = 0.99  // near-impossible threshold

    const result = await runPipeline(ku, graph, {
      mockStage1: true,
      runStage3: true,
      agents: [badAgent],
      governance: gov,
    })
    // All agents filtered out — stage3 should be undefined
    expect(result.stage3).toBeUndefined()
  })

  it('passes stage3 when agent meets calibration threshold', async () => {
    const ku = makeSimpleKU()
    const graph = new _RelGraph()
    graph.addKU(ku)

    // A perfect mock agent: always returns the expected battery answers
    // The battery alternates confirmed/disputed; build an agent that always
    // returns 'confirmed' — it will score 50% (10/20), which passes a 0.4 threshold
    const okAgent = createMockAgent('ok', 'mock', 'confirm')
    const gov = createDefaultGovernanceState()
    gov.parameters.minCalibrationAccuracy = 0.4

    const result = await runPipeline(ku, graph, {
      mockStage1: true,
      runStage3: true,
      agents: [okAgent],
      governance: gov,
    })
    expect(result.stage3).toBeDefined()
  })
})
