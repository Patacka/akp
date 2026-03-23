import type { KnowledgeUnit, Claim } from '../core/ku.js'

export interface AgentResult {
  agentId: string
  model: string
  verdict: 'confirmed' | 'disputed' | 'uncertain'
  confidence: number
  reasoning: string
  sources?: string[]
  counterexamples?: string[]
}

export interface Stage3Result {
  variant: 'reproduction' | 'triangulation' | 'falsification'
  agentResults: AgentResult[]
  consensusReached: boolean
  stage3Score: number
  checkedAt: string
}

export interface LLMAgent {
  id: string
  model: string
  call(systemPrompt: string, userPrompt: string): Promise<string>
}

// Mock agent for testing
export function createMockAgent(id: string, model: string, behavior: 'confirm' | 'dispute' | 'random' = 'confirm'): LLMAgent {
  return {
    id,
    model,
    async call(_system: string, _user: string): Promise<string> {
      const verdict = behavior === 'random'
        ? (Math.random() > 0.5 ? 'confirmed' : 'uncertain')
        : behavior === 'confirm' ? 'confirmed' : 'disputed'

      return JSON.stringify({
        verdict,
        confidence: behavior === 'confirm' ? 0.8 + Math.random() * 0.15 : 0.2 + Math.random() * 0.3,
        reasoning: `Mock agent ${id} analysis: claim appears ${verdict}.`,
        sources: behavior === 'confirm' ? ['mock-source-1', 'mock-source-2'] : [],
      })
    }
  }
}

// Anthropic API agent
export function createAnthropicAgent(id: string, model: string, apiKey: string): LLMAgent {
  return {
    id,
    model,
    async call(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      })

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.statusText}`)
      }

      const data = await response.json() as { content: Array<{type: string; text: string}> }
      return data.content[0]?.text ?? '{}'
    }
  }
}

function parseAgentResponse(raw: string, agentId: string, model: string): AgentResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      agentId,
      model,
      verdict: (parsed.verdict as AgentResult['verdict']) ?? 'uncertain',
      confidence: (parsed.confidence as number) ?? 0.5,
      reasoning: (parsed.reasoning as string) ?? '',
      sources: parsed.sources as string[] | undefined,
      counterexamples: parsed.counterexamples as string[] | undefined,
    }
  } catch {
    return {
      agentId,
      model,
      verdict: 'uncertain',
      confidence: 0.5,
      reasoning: raw,
    }
  }
}

function determineVariant(claim: Claim): Stage3Result['variant'] {
  if (claim.type === 'quantitative') return 'reproduction'
  if (claim.type === 'temporal') return 'triangulation'
  return 'triangulation'
}

export async function runStage3(
  ku: KnowledgeUnit,
  agents: LLMAgent[],
  options?: { variant?: Stage3Result['variant'] }
): Promise<Stage3Result> {
  if (agents.length === 0) {
    return {
      variant: 'triangulation',
      agentResults: [],
      consensusReached: false,
      stage3Score: 0,
      checkedAt: new Date().toISOString(),
    }
  }

  const primaryClaim = ku.structured.claims[0]
  const variant = options?.variant ?? (primaryClaim ? determineVariant(primaryClaim) : 'triangulation')

  const today = new Date().toISOString().slice(0, 10)
  const kuCreated = ku.meta.created.slice(0, 10)

  const claimsText = ku.structured.claims
    .map(c => {
      let line = `- [${c.type}] ${c.subject} ${c.predicate} ${JSON.stringify(c.object)} (confidence: ${c.confidence})`
      if (c.validUntil) line += ` [valid until: ${c.validUntil.slice(0, 10)}]`
      return line
    })
    .join('\n')

  const hasTemporalClaims = ku.structured.claims.some(
    c => c.type === 'temporal' || c.type === 'quantitative' || c.validUntil
  )

  const temporalContext = hasTemporalClaims
    ? `\n\nTemporal context: this KU was created on ${kuCreated}. Today's date is ${today}. If any claim has a "valid until" date that is in the past, the claim is stale and should be disputed.`
    : ''

  let systemPrompt: string
  let userPrompt: string

  if (variant === 'reproduction') {
    systemPrompt = `You are an independent scientific verifier. Your task is to verify quantitative claims by independently computing or researching the answer. Respond with JSON: { "verdict": "confirmed"|"disputed"|"uncertain", "confidence": 0-1, "reasoning": "...", "sources": ["..."] }`
    userPrompt = `Please independently verify these claims:\n${claimsText}${temporalContext}\n\nDo not use the original sources. Find your own evidence.`
  } else if (variant === 'falsification') {
    systemPrompt = `You are a critical analyst tasked with finding flaws in claims. Look for counterexamples, logical errors, and alternative explanations. Respond with JSON: { "verdict": "confirmed"|"disputed"|"uncertain", "confidence": 0-1, "reasoning": "...", "counterexamples": ["..."] }`
    userPrompt = `Try to falsify these claims. Find counterexamples or flaws:\n${claimsText}${temporalContext}`
  } else {
    systemPrompt = `You are an independent fact-checker. Your task is to find corroborating evidence for claims WITHOUT using the originally cited sources. Respond with JSON: { "verdict": "confirmed"|"disputed"|"uncertain", "confidence": 0-1, "reasoning": "...", "sources": ["..."] }`
    userPrompt = `Find independent evidence for or against these claims:\n${claimsText}${temporalContext}\n\nContext: ${ku.narrative.summary}`
  }

  // Run agents in parallel (simulated commit-reveal)
  const rawResults = await Promise.allSettled(
    agents.map(agent => agent.call(systemPrompt, userPrompt))
  )

  const agentResults: AgentResult[] = rawResults.map((result, i) => {
    const agent = agents[i]
    if (result.status === 'fulfilled') {
      return parseAgentResponse(result.value, agent.id, agent.model)
    } else {
      return {
        agentId: agent.id,
        model: agent.model,
        verdict: 'uncertain' as const,
        confidence: 0,
        reasoning: `Agent error: ${result.reason}`,
      }
    }
  })

  // Determine consensus
  const confirmed = agentResults.filter(r => r.verdict === 'confirmed').length
  const disputed = agentResults.filter(r => r.verdict === 'disputed').length
  const total = agentResults.length
  const consensusThreshold = 0.6

  const consensusReached = confirmed / total >= consensusThreshold || disputed / total >= consensusThreshold

  // Score: weighted average of confirmations
  const weightedScore = agentResults.reduce((sum, r) => {
    const weight = r.confidence
    const score = r.verdict === 'confirmed' ? 1 : r.verdict === 'uncertain' ? 0.5 : 0
    return sum + weight * score
  }, 0) / Math.max(1, agentResults.reduce((s, r) => s + r.confidence, 0))

  return {
    variant,
    agentResults,
    consensusReached,
    stage3Score: weightedScore,
    checkedAt: new Date().toISOString(),
  }
}
