/**
 * stage3-openai.ts — OpenAI API backend for Stage 3 corroboration.
 *
 * Supports OpenAI directly as well as Azure OpenAI and compatible proxies
 * via the OPENAI_BASE_URL environment variable.
 * Uses native fetch (Node 18+) — no npm dependencies required.
 */

import type { LLMAgent } from './stage3.js'
import type { LLMEntailmentClient } from './stage3-rav.js'

export const OPENAI_MODELS = {
  gpt4o:     'gpt-4o',
  gpt4oMini: 'gpt-4o-mini',
  gpt41:     'gpt-4.1',
  gpt41mini: 'gpt-4.1-mini',
} as const

const SCHEMA_INSTRUCTION = `Respond ONLY with valid JSON, no markdown fences, no explanation:
{"verdict":"confirmed"|"disputed"|"uncertain","confidence":<float 0.0-1.0>,"reasoning":"<one sentence>","sources":[],"counterexamples":[]}`

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object in response')
  return stripped.slice(start, end + 1)
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

export interface OpenAIOptions {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  maxTokens?: number
  retries?: number
}

export function createOpenAIAgent(
  id: string,
  model?: string,
  options: OpenAIOptions = {}
): LLMAgent {
  const {
    apiKey    = process.env.OPENAI_API_KEY,
    baseUrl   = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    timeoutMs = 60_000,
    maxTokens = 512,
    retries   = 2,
  } = options

  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const resolvedModel = model ?? OPENAI_MODELS.gpt4oMini

  return {
    id,
    model: resolvedModel,
    async call(systemPrompt: string, userPrompt: string): Promise<string> {
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          await sleep(Math.min(2 ** attempt * 1500, 12_000) + Math.random() * 500)
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model:       resolvedModel,
              max_tokens:  maxTokens,
              temperature: 0.1,
              messages: [
                { role: 'system', content: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}` },
                { role: 'user',   content: userPrompt },
              ],
            }),
            signal: controller.signal,
          })
          clearTimeout(timer)

          if (res.status === 429) {
            lastError = new Error('429 rate limited')
            continue
          }

          if (!res.ok) {
            const body = await res.text().catch(() => '')
            const errData = JSON.parse(body || '{}') as { error?: { message: string } }
            throw new Error(`OpenAI ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
          }

          const data = await res.json() as {
            choices: Array<{ message: { content: string }; finish_reason: string }>
            error?: { message: string }
          }

          if (data.error) throw new Error(data.error.message)

          const content = data.choices[0]?.message?.content ?? ''
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
 * Create an LLMEntailmentClient backed by OpenAI.
 * Sends prompts WITHOUT SCHEMA_INSTRUCTION and returns raw extracted JSON
 * for stage3-rav to parse.
 */
export async function createOpenAIEntailmentClient(
  model?: string,
  options: { apiKey?: string; baseUrl?: string } = {}
): Promise<LLMEntailmentClient> {
  const apiKey  = options.apiKey  ?? process.env.OPENAI_API_KEY
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'

  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const resolvedModel = model ?? OPENAI_MODELS.gpt4oMini

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model:       resolvedModel,
          max_tokens:  512,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const errData = JSON.parse(body || '{}') as { error?: { message: string } }
        throw new Error(`OpenAI entailment ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string }; finish_reason: string }>
        error?: { message: string }
      }
      if (data.error) throw new Error(data.error.message)

      const content = data.choices[0]?.message?.content ?? ''
      return extractJson(content)
    },
  }
}
