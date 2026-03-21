/**
 * stage3-openrouter.ts — Free LLM agents via OpenRouter for real Stage 3 corroboration.
 *
 * Free model availability on OpenRouter fluctuates. This module provides:
 *   - createOpenRouterAgent(): wraps any model with retry + rate-limit handling
 *   - discoverAvailableModels(): probes candidate models and returns the ones that respond
 *   - createFreeAgentPool(): auto-discovers N working models from a priority list
 */

import type { LLMAgent } from './stage3.js'

/** Priority-ordered list of free models to try. Update as availability changes. */
export const FREE_MODEL_CANDIDATES = [
  'arcee-ai/trinity-large-preview:free',
  'google/gemma-3-12b-it:free',
  'google/gemma-3-4b-it:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'liquid/lfm-2.5-1.2b-instruct:free',
  'qwen/qwen3-4b:free',
]

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

const SCHEMA_INSTRUCTION = `Respond ONLY with valid JSON, no markdown fences:
{"verdict":"confirmed"|"disputed"|"uncertain","confidence":<float 0.0-1.0>,"reasoning":"<brief>","sources":[],"counterexamples":[]}`

const PROBE_MESSAGE = 'Reply ONLY with this exact JSON, no changes: {"verdict":"confirmed","confidence":0.9,"reasoning":"probe ok","sources":[],"counterexamples":[]}'

export interface OpenRouterOptions {
  apiKey?: string
  timeoutMs?: number
  maxTokens?: number
  retries?: number
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function extractJson(text: string): string {
  // Strip markdown fences
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  // Find JSON object
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON found')
  return stripped.slice(start, end + 1)
}

export function createOpenRouterAgent(
  id: string,
  model: string,
  options: OpenRouterOptions = {}
): LLMAgent {
  const {
    apiKey = process.env.OPENROUTER_API_KEY,
    timeoutMs = 60_000,
    maxTokens = 400,
    retries = 2,
  } = options

  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  return {
    id,
    model,
    async call(systemPrompt: string, userPrompt: string): Promise<string> {
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          await sleep(Math.min(2 ** attempt * 1500, 12_000) + Math.random() * 500)
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        try {
          const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://github.com/akp-prototype',
              'X-Title': 'AKP Stage3',
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              messages: [
                { role: 'system', content: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}` },
                { role: 'user', content: userPrompt },
              ],
            }),
            signal: controller.signal,
          })
          clearTimeout(timer)

          if (res.status === 429) {
            lastError = new Error(`429 rate limited`)
            continue
          }

          if (!res.ok) {
            const body = await res.text().catch(() => '')
            const errData = JSON.parse(body || '{}') as { error?: { message: string } }
            throw new Error(`OpenRouter ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
          }

          const data = await res.json() as {
            choices: Array<{ message: { content: string | null }; finish_reason: string }>
            error?: { message: string }
          }

          if (data.error) throw new Error(data.error.message)

          const content = data.choices[0]?.message?.content
          if (!content) throw new Error(`Empty content (finish_reason=${data.choices[0]?.finish_reason})`)

          const jsonStr = extractJson(content)
          JSON.parse(jsonStr) // validate
          return jsonStr
        } catch (err) {
          clearTimeout(timer)
          if ((err as Error).name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms`)
          if ((err as Error).message?.includes('rate limited')) { lastError = err as Error; continue }
          throw err
        }
      }
      throw lastError ?? new Error('Max retries exceeded')
    },
  }
}

/**
 * Probe a list of models in parallel, return the IDs of those that respond correctly.
 */
export async function discoverAvailableModels(
  candidates: string[] = FREE_MODEL_CANDIDATES,
  options: OpenRouterOptions = {},
  maxModels = 3
): Promise<string[]> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const probe = async (model: string): Promise<string | null> => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 60, messages: [{ role: 'user', content: PROBE_MESSAGE }] }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return null
      const d = await res.json() as { choices?: Array<{ message: { content: string | null } }>; error?: unknown }
      if (d.error) return null
      const content = d.choices?.[0]?.message?.content
      if (!content) return null
      const json = extractJson(content)
      const parsed = JSON.parse(json) as { verdict?: string }
      return parsed.verdict ? model : null
    } catch {
      return null
    }
  }

  const results = await Promise.all(candidates.map(probe))
  return results.filter((m): m is string => m !== null).slice(0, maxModels)
}

/**
 * Create a pool of N working free agents, auto-discovering available models.
 */
export async function createFreeAgentPool(
  size = 2,
  options: OpenRouterOptions = {}
): Promise<LLMAgent[]> {
  const available = await discoverAvailableModels(FREE_MODEL_CANDIDATES, options, size)
  if (available.length === 0) throw new Error('No free models available on OpenRouter right now')
  return available.map((model, i) => createOpenRouterAgent(`agent-${i}`, model, options))
}

/**
 * Create a single fast agent using the first available free model.
 */
export async function createFastAgent(options: OpenRouterOptions = {}): Promise<LLMAgent> {
  const pool = await createFreeAgentPool(1, options)
  return pool[0]
}
