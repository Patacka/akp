/**
 * experiments.ts — Five AKP network experiments for multi-agent evaluation.
 *
 * Each experiment creates a fresh in-memory store + graph, spawns N AgentRunners,
 * runs R rounds of commit-reveal, and returns a MetricsCollector.
 *
 * LLM mode: pass a pre-constructed LLMAgent (from stage3-llamacpp or stage3-local).
 * Fallback mode: omit llmAgent to run deterministically with fixed verdicts —
 *   fast CI runs without a GPU.
 */

import { KUStore } from '../core/store.js'
import { RelationGraph } from '../core/graph.js'
import { createProvenance, createKU } from '../core/ku.js'
import { v7 as uuidv7 } from 'uuid'
import { MetricsCollector } from './metrics.js'
import { createAgentRunner, type AgentRunner } from './agent-runner.js'
import type { LLMAgent } from '../pipeline/stage3.js'
import type { Verdict } from './metrics.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeEphemeralStore(): { store: KUStore; anchorKuId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'akp-exp-'))
  const store = new KUStore({ dbPath: join(dir, 'exp.db') })
  // Disable time-based commit window so experiments can reveal in the same process run.
  const params = store.getGovernanceParameters()
  store.saveGovernanceParameters({ ...params, commitWindowMinutes: 0, commitWindowMinCount: 3 })
  // Seed genesis anchor so agents can earn reputation from round 1 (Solution 3).
  const anchorKuId = store.seedGenesisAnchor()
  return { store, anchorKuId }
}

function makeGraph(): RelationGraph {
  return new RelationGraph()
}

/** Seed KU content pools for each experiment domain */
const PYTHON_KUS = [
  {
    domain: 'software/python',
    title: 'Python requests library latest version',
    summary: 'The requests library is at version 2.32.3 on PyPI as of 2025-01.',
    claims: [{
      type: 'quantitative' as const,
      subject: 'requests',
      predicate: 'latest_version',
      object: '2.32.3',
      confidence: 0.95,
    }],
  },
  {
    domain: 'software/python',
    title: 'NumPy 2.0 release date',
    summary: 'NumPy 2.0.0 was released on 2024-06-16.',
    claims: [{
      type: 'temporal' as const,
      subject: 'numpy',
      predicate: 'release_date',
      object: '2024-06-16',
      confidence: 0.99,
    }],
  },
  {
    domain: 'software/python',
    title: 'CPython version 3.13 feature: JIT compiler',
    summary: 'CPython 3.13 introduced an experimental JIT compiler.',
    claims: [{
      type: 'factual' as const,
      subject: 'cpython-3.13',
      predicate: 'includes_feature',
      object: 'experimental-jit',
      confidence: 0.97,
    }],
  },
  {
    domain: 'software/python',
    title: 'FastAPI default ASGI server',
    summary: 'FastAPI uses Uvicorn as its recommended ASGI server.',
    claims: [{
      type: 'factual' as const,
      subject: 'fastapi',
      predicate: 'recommended_server',
      object: 'uvicorn',
      confidence: 0.98,
    }],
  },
  {
    domain: 'software/python',
    title: 'Pydantic v2 rewrite in Rust',
    summary: 'Pydantic v2 core validation layer was rewritten in Rust for performance.',
    claims: [{
      type: 'factual' as const,
      subject: 'pydantic-v2',
      predicate: 'core_language',
      object: 'rust',
      confidence: 0.99,
    }],
  },
]

const FALSE_KUS = [
  {
    domain: 'software/python',
    title: 'Python 4.0 released in 2023',
    summary: 'Python 4.0 was released on 2023-01-01 with full backward compatibility.',
    claims: [{
      type: 'temporal' as const,
      subject: 'python-4.0',
      predicate: 'release_date',
      object: '2023-01-01',
      confidence: 0.9,
    }],
  },
]

async function spawnAgents(
  count: number,
  store: KUStore,
  graph: RelationGraph,
  metrics: MetricsCollector,
  opts: {
    fallbackVerdict?: Verdict
    llm?: LLMAgent
    verbose?: boolean
    prefix?: string
  } = {}
): Promise<AgentRunner[]> {
  const agents: AgentRunner[] = []
  for (let i = 0; i < count; i++) {
    const agent = await createAgentRunner(`${opts.prefix ?? 'agent'}-${i + 1}`, {
      store,
      graph,
      metrics,
      fallbackVerdict: opts.fallbackVerdict ?? 'confirmed',
      llm: opts.llm,
      verbose: opts.verbose ?? false,
    })
    agents.push(agent)
  }
  return agents
}

async function runRounds(
  agents: AgentRunner[],
  kuIds: string[],
  rounds: number,
  metrics: MetricsCollector,
  groundTruth: Verdict = 'confirmed',
  /**
   * KU IDs that every agent should always vote 'confirmed' on, regardless of
   * their fallbackVerdict.  Used for the genesis anchor so agents with a
   * 'disputed' fallback don't self-blacklist by disputing the anchor.
   */
  alwaysConfirmIds: Set<string> = new Set()
) {
  for (let round = 1; round <= rounds; round++) {
    // Phase 1: all agents commit on all KUs they haven't reviewed yet
    for (const agent of agents) {
      for (const kuId of kuIds) {
        const override: Verdict | undefined = alwaysConfirmIds.has(kuId) ? 'confirmed' : undefined
        await agent.commitReview(kuId, round, alwaysConfirmIds.has(kuId) ? 'confirmed' : groundTruth, override)
      }
    }

    // Phase 2: reveal
    for (const agent of agents) {
      await agent.revealPending(round)
    }

    // Phase 3: recompute confidence once per KU (batched — not per-reveal)
    const allDirty = new Set<string>()
    for (const agent of agents) {
      for (const id of agent.dirtyKuIds) allDirty.add(id)
    }
    if (allDirty.size > 0) {
      // Use first agent's store/graph to run pipeline (shared references)
      await agents[0]!.recomputeDirty()
      // Clear dirty flags on remaining agents
      for (const agent of agents.slice(1)) agent.dirtyKuIds.clear()
    }

    // Snapshot state
    for (const agent of agents) {
      agent.snapshotReputation(round)
    }
    for (const kuId of kuIds) {
      agents[0]?.snapshotKuConfidence(kuId, round)
    }
  }
}

// ── E1: Consensus Formation ───────────────────────────────────────────────────

/**
 * E1 — Consensus Formation
 *
 * 5 honest agents review 5 factually-correct KUs across 10 rounds.
 * All agents use fallback verdict 'confirmed' (or LLM if provided).
 *
 * Expected outcomes:
 *   - Consensus latency < 3 rounds
 *   - Verdict accuracy ≈ 100%
 *   - KU confidence converges toward ~0.75 (ceiling with mock stage-1, no stage-3)
 *   - Gini coefficient stays low (equal reputation gain)
 */
export async function experimentE1ConsensusFormation(opts: {
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E1-consensus-formation')

  const llm = opts.llmAgent

  // Seed KUs from a contributor agent
  const contributor = await createAgentRunner('contributor', { store, graph, metrics, verbose: false })
  const kuIds: string[] = [anchorKuId]
  for (const ku of PYTHON_KUS) {
    const id = await contributor.contribute(ku, 0)
    kuIds.push(id)
  }

  // Spawn 5 honest agents
  const agents = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    llm,
    verbose: opts.verbose,
    prefix: 'honest',
  })

  await runRounds(agents, kuIds, opts.rounds ?? 10, metrics, 'confirmed')

  return metrics
}

// ── E2: Adversarial Detection ─────────────────────────────────────────────────

/**
 * E2 — Adversarial Agent Detection
 *
 * 4 honest agents + 1 adversarial agent (always disputes true claims).
 * The adversarial agent should accumulate negative reputation and eventually
 * be blacklisted, while KU confidence still converges correctly.
 *
 * Expected outcomes:
 *   - Adversarial agent blacklisted within ~5 rounds
 *   - KU confidence still converges (majority rules)
 *   - Honest agents unaffected after blacklist
 */
export async function experimentE2AdversarialDetection(opts: {
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E2-adversarial-detection')

  const llm = opts.llmAgent

  const contributor = await createAgentRunner('contributor', { store, graph, metrics, verbose: false })
  const kuIds: string[] = [anchorKuId]
  for (const ku of PYTHON_KUS) {
    const id = await contributor.contribute(ku, 0)
    kuIds.push(id)
  }

  const honestAgents = await spawnAgents(4, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    llm,
    verbose: opts.verbose,
    prefix: 'honest',
  })

  const adversarialAgent = await createAgentRunner('adversarial-1', {
    store,
    graph,
    metrics,
    fallbackVerdict: 'disputed',  // always disputes correct claims
    verbose: opts.verbose,
  })

  const allAgents = [...honestAgents, adversarialAgent]

  await runRounds(allAgents, kuIds, opts.rounds ?? 15, metrics, 'confirmed')

  return metrics
}

// ── E3: Sybil Resistance ──────────────────────────────────────────────────────

/**
 * E3 — Sybil Attack Resistance
 *
 * 1 honest agent vs N Sybil agents (all confirming a FALSE claim).
 * Tests whether the commit-reveal + reputation weighting prevents false
 * knowledge from reaching validated maturity.
 *
 * Expected outcomes (if protocol is robust):
 *   - False KU confidence stays low despite Sybil majority
 *   - Sybils gain temporary reputation boost but can't push false KU to 'stable'
 *   - Honest agent reputation rises proportionally
 *
 * Note: With weight-0 new agents, early rounds are especially revealing.
 */
export async function experimentE3SybilResistance(opts: {
  sybilCount?: number
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const sybilCount = opts.sybilCount ?? 10
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector(`E3-sybil-resistance-${sybilCount}x`)

  // Sybil contributes a FALSE KU
  const sybilContributor = await createAgentRunner('sybil-0', { store, graph, metrics, verbose: false })
  const falseKuId = await sybilContributor.contribute(FALSE_KUS[0], 0)

  // Sybils: confirm anchor (to graduate honestly) + confirm the false KU (adversarial role)
  const sybils = await spawnAgents(sybilCount, store, graph, metrics, {
    fallbackVerdict: 'confirmed',   // confirms both anchor and false KU
    verbose: opts.verbose,
    prefix: 'sybil',
  })

  // 3 honest agents: confirm anchor, dispute the false KU
  // Using fallbackVerdict='disputed' but anchor is always-confirmed via alwaysConfirmIds.
  const honestAgents = await spawnAgents(3, store, graph, metrics, {
    fallbackVerdict: 'disputed',
    verbose: opts.verbose,
    prefix: 'honest',
  })

  // Run with anchor protected — honest agents won't self-blacklist by disputing it.
  // groundTruth='disputed' means the false KU is the target; sybils confirming it = inaccurate.
  const allAgents = [...sybils, ...honestAgents]
  const allKuIds = [anchorKuId, falseKuId]
  await runRounds(allAgents, allKuIds, opts.rounds ?? 20, metrics, 'disputed', new Set([anchorKuId]))

  return metrics
}

// ── E4: Knowledge Quality Evolution ──────────────────────────────────────────

/**
 * E4 — Knowledge Quality Evolution
 *
 * Agents both contribute new KUs and cross-review each other's contributions.
 * Tracks how KU confidence and maturity evolve over time as more reviewers
 * accumulate reputation.
 *
 * Expected outcomes:
 *   - Average confidence increases monotonically with rounds
 *   - Maturity distribution shifts from draft → proposed → stable
 *   - Graduated agents' reviews carry more weight, accelerating later convergence
 */
export async function experimentE4KnowledgeQualityEvolution(opts: {
  agentCount?: number
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const agentCount = opts.agentCount ?? 5
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E4-knowledge-quality-evolution')

  const llm = opts.llmAgent

  const agents = await spawnAgents(agentCount, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    llm,
    verbose: opts.verbose,
    prefix: 'peer',
  })

  // Each agent contributes one KU before reviews start
  const allKuIds: string[] = [anchorKuId]
  for (let i = 0; i < agents.length; i++) {
    const ku = PYTHON_KUS[i % PYTHON_KUS.length]
    const id = await agents[i].contribute({ ...ku, title: `${ku.title} (agent ${i + 1})` }, 0)
    allKuIds.push(id)
  }

  // Run rounds — agents review each other's KUs (including anchor each round)
  const rounds = opts.rounds ?? 15
  for (let round = 1; round <= rounds; round++) {
    for (const agent of agents) {
      for (const kuId of allKuIds) {
        await agent.commitReview(kuId, round, 'confirmed')
      }
    }
    for (const agent of agents) {
      await agent.revealPending(round)
    }
    await agents[0]!.recomputeDirty()
    for (const agent of agents.slice(1)) agent.dirtyKuIds.clear()

    for (const agent of agents) {
      agent.snapshotReputation(round)
    }
    for (const kuId of allKuIds) {
      agents[0].snapshotKuConfidence(kuId, round)
    }

    // Every 5 rounds, agents contribute new KUs (organic growth)
    if (round % 5 === 0) {
      for (const agent of agents) {
        const ku = PYTHON_KUS[Math.floor(Math.random() * PYTHON_KUS.length)]
        const id = await agent.contribute({ ...ku, title: `${ku.title} (r${round})` }, round)
        allKuIds.push(id)
      }
    }
  }

  return metrics
}

// ── E5: Staleness Detection ───────────────────────────────────────────────────

/**
 * E5 — Staleness and Supersession
 *
 * Agents review KUs that have expired `validUntil` claims.
 * A second wave of agents contributes updated KUs and supersedes the old ones.
 * Tests whether the confidence cap and maturity demotion work correctly.
 *
 * Expected outcomes:
 *   - Stale KU confidence decays from claim staleness multiplier
 *   - After supersession, old KU confidence hard-capped at 0.3
 *   - New KU gains confidence normally
 *   - Agents that detect staleness (dispute) get reputation reward
 */
export async function experimentE5StalenessDetection(opts: {
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E5-staleness-detection')

  const llm = opts.llmAgent

  // Contributor seeds a KU with an already-expired claim
  const contributor = await createAgentRunner('contributor', { store, graph, metrics, verbose: false })
  const expiredDate = new Date(Date.now() - 45 * 86_400_000).toISOString()  // 45 days ago

  const staleKuContent = {
    domain: 'software/python',
    title: 'Python 3.11 latest patch (stale)',
    summary: 'Python 3.11.9 was the latest patch as of the expiry date.',
    claims: [{
      type: 'quantitative' as const,
      subject: 'python-3.11',
      predicate: 'latest_patch',
      object: '3.11.9',
      confidence: 0.95,
      validUntil: expiredDate,
    }],
  }

  const staleKuId = await contributor.contribute(staleKuContent, 0)

  // 3 agents dispute the stale KU (correct behavior — it's expired)
  const alertAgents = await spawnAgents(3, store, graph, metrics, {
    fallbackVerdict: 'disputed',
    llm,
    verbose: opts.verbose,
    prefix: 'alert',
  })

  // 2 agents still confirm (unaware it's stale — adversarial or outdated)
  const naiveAgents = await spawnAgents(2, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    verbose: opts.verbose,
    prefix: 'naive',
  })

  const allAgents = [...alertAgents, ...naiveAgents]

  // Phase 1: initial review rounds on anchor + stale KU (anchor builds reputation first)
  // Anchor is always confirmed — alert agents confirm anchor, dispute stale KU.
  // Naive agents confirm both. groundTruth='disputed' for accuracy on stale KU.
  const initialRounds = Math.floor((opts.rounds ?? 10) / 2)
  await runRounds(allAgents, [anchorKuId, staleKuId], initialRounds, metrics, 'disputed', new Set([anchorKuId]))

  // A knowledgeable agent supersedes the old KU with updated info
  const updater = await createAgentRunner('updater', { store, graph, metrics, verbose: opts.verbose })
  const prov = createProvenance({ did: updater.did, type: 'agent', method: 'observation' })
  const newKu = createKU({
    domain: 'software/python',
    title: { en: 'Python 3.13 latest patch (current)' },
    summary: 'Python 3.13.1 is the latest stable release.',
    provenance: prov,
  })
  const newKuId = store.supersede(staleKuId, newKu) ?? await contributor.contribute({
    domain: 'software/python',
    title: 'Python 3.13 latest patch (current)',
    summary: 'Python 3.13.1 is the latest stable release.',
    claims: [{ type: 'quantitative', subject: 'python-3.13', predicate: 'latest_patch', object: '3.13.1', confidence: 0.99 }],
  }, initialRounds + 1)

  // Phase 2: all agents dispute the now-superseded stale KU, alert agents confirm the new KU.
  const remainingRounds = (opts.rounds ?? 10) - initialRounds
  await runRounds(allAgents, [staleKuId], remainingRounds, metrics, 'disputed')
  await runRounds(alertAgents, [newKuId], remainingRounds, metrics, 'confirmed')

  // Final snapshot including supersession relationship
  for (const kuId of [staleKuId, newKuId]) {
    allAgents[0]?.snapshotKuConfidence(kuId, opts.rounds ?? 10)
  }

  return metrics
}

// ── E6: 100-Node Sybil Simulation ─────────────────────────────────────────────

/**
 * E6 — Large-Scale Sybil Simulation
 *
 * Scales E3 to N coordinated Sybil agents (default 20) vs 5 honest agents
 * reviewing a FALSE claim.  Tests whether the anti-monopolization cap +
 * diversity floor (DIVERSITY_FLOOR=3, MAX_SINGLE_REVIEWER_WEIGHT=0.4) hold
 * under Sybil pressure (4:1 ratio by default; pass --sybils 100 for 20:1).
 *
 * All agents confirm the anchor (builds reputation legitimately).
 * Sybils confirm the false KU; honest agents dispute it.
 *
 * Key hypotheses:
 *   - False KU confidence stays low: honest reviewers' weight counters sybil mass
 *   - Blacklist cascade: once honest agents graduate, sybil confirms-on-false-KU
 *     score against the honest majority → sybils earn -10 → blacklisted
 *   - False KU never reaches 'stable' maturity
 */
export async function experimentE6LargeScaleSybil(opts: {
  sybilCount?: number
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const sybilCount = opts.sybilCount ?? 20
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector(`E6-sybil-${sybilCount}x`)

  const sybilContributor = await createAgentRunner('sybil-0', { store, graph, metrics, verbose: false })
  const falseKuId = await sybilContributor.contribute(FALSE_KUS[0], 0)

  // 100 coordinated sybils — all confirm the false KU
  const sybils = await spawnAgents(sybilCount, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    verbose: false,  // muted at this scale
    prefix: 'sybil',
  })

  // 5 honest agents dispute the false KU
  const honest = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'disputed',
    verbose: opts.verbose,
    prefix: 'honest',
  })

  const allAgents = [...sybils, ...honest]
  const rounds = opts.rounds ?? 10
  for (let round = 1; round <= rounds; round++) {
    // All agents confirm the anchor (correct, builds reputation for all).
    // Sybils confirm the false KU (adversarial). Honest agents dispute it (correct).
    for (const agent of sybils) {
      await agent.commitReview(anchorKuId, round, 'confirmed', 'confirmed')
      await agent.commitReview(falseKuId, round, 'disputed', 'confirmed')  // sybil confirms falsely; groundTruth=disputed
    }
    for (const agent of honest) {
      await agent.commitReview(anchorKuId, round, 'confirmed', 'confirmed')
      await agent.commitReview(falseKuId, round, 'disputed', 'disputed')   // honest disputes correctly
    }
    for (const agent of allAgents) {
      await agent.revealPending(round)
    }
    // Batch confidence recompute — once per KU, not once per agent-reveal
    await allAgents[0]!.recomputeDirty()
    for (const agent of allAgents.slice(1)) agent.dirtyKuIds.clear()

    for (const agent of [...honest, sybils[0], sybils[1], sybils[2]]) {
      agent.snapshotReputation(round)
    }
    honest[0]?.snapshotKuConfidence(falseKuId, round)
    honest[0]?.snapshotKuConfidence(anchorKuId, round)
  }

  return metrics
}

// ── E7: Logical Contradiction Injection ───────────────────────────────────────

/**
 * E7 — Logical Contradiction Injection
 *
 * Contributes two KUs with directly contradicting factual claims:
 *   KU-A: python-3.13 latest_version = "3.13.1"  (correct)
 *   KU-B: python-3.13 latest_version = "3.11.0"  (false contradiction)
 *
 * A `related_to` relation is added between them so they become graph neighbors.
 * The stage-2 pipeline then detects the contradiction and sets hasConflicts=true,
 * triggering a -0.3 coherencePenalty on whichever KU has lower stage2Score.
 *
 * Key hypotheses:
 *   - checkContradictions() fires on KU-B (or both)
 *   - KU-B's stage2Score < conflict_threshold (0.3) → coherencePenalty applied
 *   - KU-B confidence is measurably lower than KU-A despite same review count
 *   - Honest agents detecting the contradiction earn more reputation
 */
export async function experimentE7ContradictionInjection(opts: {
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E7-contradiction-injection')

  const contributor = await createAgentRunner('contributor', { store, graph, metrics, verbose: false })

  // KU-A: correct fact
  const kuAId = await contributor.contribute({
    domain: 'software/python',
    title: 'Python 3.13 latest version (correct)',
    summary: 'Python 3.13.1 is the latest stable release of CPython.',
    claims: [{
      type: 'factual',
      subject: 'python-3.13',
      predicate: 'latest_version',
      object: '3.13.1',
      confidence: 0.99,
    }],
  }, 0)

  // KU-B: directly contradicts KU-A (same subject+predicate, different object)
  const kuBId = await contributor.contribute({
    domain: 'software/python',
    title: 'Python 3.13 latest version (FALSE — contradicts KU-A)',
    summary: 'A false claim asserting Python 3.13 is actually version 3.11.0.',
    claims: [{
      type: 'factual',
      subject: 'python-3.13',
      predicate: 'latest_version',
      object: '3.11.0',   // contradicts KU-A
      confidence: 0.9,
    }],
  }, 0)

  // Link KU-A ↔ KU-B in the graph so stage-2 detects the contradiction
  store.update(kuAId, ku => {
    ku.structured.relations.push({
      id: uuidv7(),
      type: 'related_to',
      sourceKuId: kuAId,
      targetKuId: kuBId,
      confidence: 1.0,
      confirmedBy: [],
    } as unknown as typeof ku.structured.relations[0])
  }, 'link-contradiction')
  const kuAUpdated = store.read(kuAId)!
  graph.addKU(kuAUpdated)  // refresh adjacency with the new relation

  // 5 honest agents confirm KU-A and dispute KU-B
  const honestAgents = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    llm: opts.llmAgent,
    verbose: opts.verbose,
    prefix: 'honest',
  })

  // 2 adversarial agents confirm the contradiction (KU-B)
  const adversarialAgents = await spawnAgents(2, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    verbose: opts.verbose,
    prefix: 'adversarial',
  })

  const allAgents = [...honestAgents, ...adversarialAgents]
  const rounds = opts.rounds ?? 12

  for (let round = 1; round <= rounds; round++) {
    // Honest: confirm anchor + KU-A (correct), dispute KU-B (correct — it's false)
    for (const agent of honestAgents) {
      await agent.commitReview(anchorKuId, round, 'confirmed', 'confirmed')
      await agent.commitReview(kuAId, round, 'confirmed', 'confirmed')
      await agent.commitReview(kuBId, round, 'disputed', 'disputed')   // verdictOverride forces 'disputed'
    }
    // Adversarial: confirm everything including the false contradiction
    for (const agent of adversarialAgents) {
      await agent.commitReview(anchorKuId, round, 'confirmed', 'confirmed')
      await agent.commitReview(kuAId, round, 'confirmed', 'confirmed')
      await agent.commitReview(kuBId, round, 'disputed', 'confirmed')  // confirms falsely; groundTruth=disputed
    }
    for (const agent of allAgents) {
      await agent.revealPending(round)
    }
    await allAgents[0]!.recomputeDirty()
    for (const agent of allAgents.slice(1)) agent.dirtyKuIds.clear()

    for (const agent of allAgents) {
      agent.snapshotReputation(round)
    }
    honestAgents[0].snapshotKuConfidence(kuAId, round)
    honestAgents[0].snapshotKuConfidence(kuBId, round)
  }

  return metrics
}

// ── E8: Cross-Architecture Verification ──────────────────────────────────────

/**
 * E8 — Cross-Architecture Verification
 *
 * Simulates three agent groups with different decision-making architectures:
 *   Group A (LLM):        5 agents using the provided LLM (full reasoning)
 *   Group B (Strict):     5 agents using deterministic 'confirmed' verdict
 *   Group C (Skeptical):  5 agents using deterministic 'disputed' verdict
 *
 * All groups review the same 5 correct Python KUs.
 * The strict group always agrees with the LLM; the skeptical group always disagrees.
 * This models real cross-architecture disagreement where different models have
 * different confidence thresholds.
 *
 * Key hypotheses:
 *   - Consensus latency is higher when architectures disagree (> E1's 1.00 rounds)
 *   - Skeptical agents get slashed after honest agents graduate
 *   - Final confidence is lower than all-honest E1 due to mixed verdicts
 *   - LLM + strict agents eventually form a quorum that overrides skeptics
 */
export async function experimentE8CrossArchitecture(opts: {
  llmAgent?: LLMAgent
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E8-cross-architecture')

  const contributor = await createAgentRunner('contributor', { store, graph, metrics, verbose: false })
  const kuIds: string[] = [anchorKuId]
  for (const ku of PYTHON_KUS) {
    kuIds.push(await contributor.contribute(ku, 0))
  }

  // Group A: LLM-driven (falls back to 'confirmed' if no LLM)
  const groupA = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    llm: opts.llmAgent,
    verbose: opts.verbose,
    prefix: 'llm',
  })

  // Group B: strict rule-based always confirms
  const groupB = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    verbose: opts.verbose,
    prefix: 'strict',
  })

  // Group C: skeptical always disputes (different architecture bias)
  const groupC = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'disputed',
    verbose: opts.verbose,
    prefix: 'skeptical',
  })

  // Group C is skeptical (disputed fallback) but must confirm anchor to avoid self-blacklisting.
  // The experiment tests architecture divergence on the test KUs, not on the anchor.
  const allAgents = [...groupA, ...groupB, ...groupC]
  await runRounds(allAgents, kuIds, opts.rounds ?? 15, metrics, 'confirmed', new Set([anchorKuId]))

  return metrics
}

// ── E9: Temporal Decay Monitoring ─────────────────────────────────────────────

/**
 * E9 — Temporal Decay Monitoring
 *
 * Creates 6 KUs with different claim expiry offsets to observe the exponential
 * decay function `exp(-daysPast / 30)` in practice:
 *
 *   KU-0: no validUntil (evergreen)       → multiplier 1.0
 *   KU-1: expired  -7 days ago            → exp(-7/30)  ≈ 0.79
 *   KU-2: expired -15 days ago            → exp(-15/30) ≈ 0.61
 *   KU-3: expired -30 days ago            → exp(-30/30) ≈ 0.37
 *   KU-4: expired -60 days ago            → exp(-60/30) ≈ 0.14
 *   KU-5: expired -90 days ago            → exp(-90/30) ≈ 0.05
 *
 * Agents review all KUs with 'confirmed' verdicts.  The final confidence delta
 * between KU-0 and KU-5 should reveal the decay function empirically.
 *
 * Key hypotheses:
 *   - Confidence decreases monotonically with expiry age
 *   - The ratio KU-3/KU-0 ≈ e⁻¹ ≈ 0.37 (half-life visible)
 *   - Agents earn identical reputation regardless of KU staleness (staleness
 *     only affects confidence score, not reviewer reward)
 */
export async function experimentE9TemporalDecay(opts: {
  rounds?: number
  verbose?: boolean
} = {}): Promise<MetricsCollector> {
  const { store, anchorKuId } = makeEphemeralStore()
  const graph = makeGraph()
  const metrics = new MetricsCollector('E9-temporal-decay')

  const now = Date.now()
  const expiryOffsets = [null, -7, -15, -30, -60, -90]  // days

  const contributor = await createAgentRunner('contributor', { store, graph, metrics, verbose: false })
  const kuIds: string[] = [anchorKuId]

  for (const daysAgo of expiryOffsets) {
    const validUntil = daysAgo !== null
      ? new Date(now + daysAgo * 86_400_000).toISOString()
      : undefined
    const label = daysAgo === null ? 'evergreen' : `expired-${Math.abs(daysAgo)}d`

    const id = await contributor.contribute({
      domain: 'software/python',
      title: `Python fact — ${label}`,
      summary: `A factual Python claim with validUntil offset ${label}.`,
      claims: [{
        type: 'factual',
        subject: 'python',
        predicate: 'is_open_source',
        object: 'true',
        confidence: 0.99,
        ...(validUntil ? { validUntil } : {}),
      }],
    }, 0)
    kuIds.push(id)
  }

  // 5 honest agents confirm all KUs every round
  const agents = await spawnAgents(5, store, graph, metrics, {
    fallbackVerdict: 'confirmed',
    verbose: opts.verbose,
    prefix: 'agent',
  })

  await runRounds(agents, kuIds, opts.rounds ?? 10, metrics, 'confirmed')

  // Final per-KU confidence snapshot to read the decay curve
  const decayKuIds = kuIds.slice(1)  // skip anchor
  console.log('\n  Temporal Decay Results:')
  console.log('  ' + '─'.repeat(55))
  console.log(`  ${'KU label'.padEnd(22)} ${'validUntil offset'.padEnd(20)} confidence`)
  console.log('  ' + '─'.repeat(55))
  for (let i = 0; i < decayKuIds.length; i++) {
    const ku = store.read(decayKuIds[i])
    const label = expiryOffsets[i] === null ? 'evergreen' : `expired-${Math.abs(expiryOffsets[i]!)}d`
    const expected = expiryOffsets[i] === null ? 1.0 : Math.exp(expiryOffsets[i]! / 30)
    const conf = ku?.meta.confidence.aggregate.toFixed(4) ?? 'n/a'
    const multiplierInfo = `staleness×${expected.toFixed(2)}`
    console.log(`  ${label.padEnd(22)} ${multiplierInfo.padEnd(20)} ${conf}`)
  }
  console.log('  ' + '─'.repeat(55))

  return metrics
}

// ── Experiment registry ───────────────────────────────────────────────────────

export const EXPERIMENTS = {
  E1: { name: 'Consensus Formation', fn: experimentE1ConsensusFormation },
  E2: { name: 'Adversarial Detection', fn: experimentE2AdversarialDetection },
  E3: { name: 'Sybil Resistance (10x)', fn: experimentE3SybilResistance },
  E4: { name: 'Knowledge Quality Evolution', fn: experimentE4KnowledgeQualityEvolution },
  E5: { name: 'Staleness Detection', fn: experimentE5StalenessDetection },
  E6: { name: 'Sybil Simulation (20x)', fn: experimentE6LargeScaleSybil },
  E7: { name: 'Contradiction Injection', fn: experimentE7ContradictionInjection },
  E8: { name: 'Cross-Architecture', fn: experimentE8CrossArchitecture },
  E9: { name: 'Temporal Decay', fn: experimentE9TemporalDecay },
} as const

export type ExperimentKey = keyof typeof EXPERIMENTS
