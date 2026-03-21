/**
 * stage3-live.ts — Real Anthropic API integration for Stage 3 corroboration.
 *
 * Use createAnthropicLiveAgent() to build an LLMAgent backed by the Claude API.
 * The agent returns structured JSON matching the Stage3 AgentResult schema.
 *
 * CI safety: tests guarded by `skipIf(!process.env.ANTHROPIC_API_KEY)`.
 */

import type { LLMAgent } from './stage3.js'

export interface AnthropicLiveOptions {
  model?: string
  maxTokens?: number
  timeoutMs?: number
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const SCHEMA_INSTRUCTION = `
Respond ONLY with valid JSON (no markdown fences) matching this schema:
{
  "verdict": "confirmed" | "disputed" | "uncertain",
  "confidence": <float 0.0–1.0>,
  "reasoning": "<brief explanation>",
  "sources": ["<source url or description>", ...],
  "counterexamples": ["<counterexample>", ...]
}
`.trim()

/**
 * Creates a real Anthropic API-backed LLMAgent.
 *
 * Requires ANTHROPIC_API_KEY environment variable or explicit apiKey parameter.
 */
export function createAnthropicLiveAgent(
  id: string,
  options: AnthropicLiveOptions & { apiKey?: string } = {}
): LLMAgent {
  const {
    model = DEFAULT_MODEL,
    maxTokens = 512,
    timeoutMs = 30_000,
    apiKey = process.env.ANTHROPIC_API_KEY,
  } = options

  if (!apiKey) {
    throw new Error('createAnthropicLiveAgent: ANTHROPIC_API_KEY not set')
  }

  return {
    id,
    model,
    async call(systemPrompt: string, userPrompt: string): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}`,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(`Anthropic API ${response.status}: ${body}`)
        }

        const data = await response.json() as {
          content: Array<{ type: string; text: string }>
          usage?: { input_tokens: number; output_tokens: number }
        }

        const text = data.content.find(b => b.type === 'text')?.text ?? '{}'

        // Strip markdown fences if model adds them despite instructions
        const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()

        // Validate it's parseable JSON
        JSON.parse(cleaned)
        return cleaned
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new Error(`Anthropic API timeout after ${timeoutMs}ms`)
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Create a pool of N independent live agents using different Claude model variants.
 * Diversity in model size helps reduce correlated errors (independence analysis).
 */
export function createLiveAgentPool(
  count: number,
  options: AnthropicLiveOptions & { apiKey?: string } = {}
): LLMAgent[] {
  // Rotate models for independence; all available Haiku/Sonnet family
  const models = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]
  return Array.from({ length: count }, (_, i) =>
    createAnthropicLiveAgent(`live-agent-${i}`, {
      ...options,
      model: models[i % models.length],
    })
  )
}
