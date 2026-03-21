/**
 * stage3-claude.ts — Anthropic Claude API backend for Stage 3 corroboration.
 *
 * Uses the Anthropic Messages API directly via native fetch (Node 18+).
 * No npm dependencies required.
 */

import type { LLMAgent } from './stage3.js'
import type { LLMEntailmentClient } from './stage3-rav.js'

export const CLAUDE_MODELS = {
  opus:   'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
} as const

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION  = '2023-06-01'

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

export interface ClaudeOptions {
  apiKey?: string
  timeoutMs?: number
  maxTokens?: number
  retries?: number
}

export function createClaudeAgent(
  id: string,
  model?: string,
  options: ClaudeOptions = {}
): LLMAgent {
  const {
    apiKey    = process.env.ANTHROPIC_API_KEY,
    timeoutMs = 60_000,
    maxTokens = 512,
    retries   = 2,
  } = options

  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const resolvedModel = model ?? CLAUDE_MODELS.sonnet

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
          const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
            method: 'POST',
            headers: {
              'Content-Type':    'application/json',
              'x-api-key':       apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model:      resolvedModel,
              max_tokens: maxTokens,
              system:     `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}`,
              messages:   [{ role: 'user', content: userPrompt }],
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
            throw new Error(`Anthropic ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
          }

          const data = await res.json() as {
            content: Array<{ type: string; text: string }>
            error?: { message: string }
          }

          if (data.error) throw new Error(data.error.message)

          const text = data.content[0]?.text ?? ''
          if (!text) throw new Error('Empty content from Anthropic API')

          const jsonStr = extractJson(text)
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
 * Create an LLMEntailmentClient backed by Claude.
 * The entailment checker sends prompts WITHOUT SCHEMA_INSTRUCTION and returns
 * raw extracted JSON for stage3-rav to parse.
 */
export async function createClaudeEntailmentClient(
  model?: string,
  options: { apiKey?: string } = {}
): Promise<LLMEntailmentClient> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const resolvedModel = model ?? CLAUDE_MODELS.sonnet

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model:      resolvedModel,
          max_tokens: 512,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userPrompt }],
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const errData = JSON.parse(body || '{}') as { error?: { message: string } }
        throw new Error(`Anthropic entailment ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
      }

      const data = await res.json() as {
        content: Array<{ type: string; text: string }>
        error?: { message: string }
      }
      if (data.error) throw new Error(data.error.message)

      const text = data.content[0]?.text ?? ''
      return extractJson(text)
    },
  }
}
