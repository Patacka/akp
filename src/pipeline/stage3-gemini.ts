/**
 * stage3-gemini.ts — Google Gemini API backend for Stage 3 corroboration.
 *
 * Uses the Gemini generateContent REST API directly via native fetch (Node 18+).
 * No npm dependencies required.
 */

import type { LLMAgent } from './stage3.js'
import type { LLMEntailmentClient } from './stage3-rav.js'

export const GEMINI_MODELS = {
  flash:   'gemini-2.0-flash',
  flash15: 'gemini-1.5-flash',
  pro15:   'gemini-1.5-pro',
} as const

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

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

export interface GeminiOptions {
  apiKey?: string
  timeoutMs?: number
  maxTokens?: number
  retries?: number
}

export function createGeminiAgent(
  id: string,
  model?: string,
  options: GeminiOptions = {}
): LLMAgent {
  const {
    apiKey    = process.env.GEMINI_API_KEY,
    timeoutMs = 60_000,
    maxTokens = 512,
    retries   = 2,
  } = options

  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const resolvedModel = model ?? GEMINI_MODELS.flash

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
          const res = await fetch(
            `${GEMINI_API_BASE}/${resolvedModel}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: {
                  parts: [{ text: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}` }],
                },
                contents: [
                  { role: 'user', parts: [{ text: userPrompt }] },
                ],
                generationConfig: {
                  maxOutputTokens: maxTokens,
                  temperature:     0.1,
                },
              }),
              signal: controller.signal,
            }
          )
          clearTimeout(timer)

          if (res.status === 429 || res.status === 503) {
            lastError = new Error(`${res.status} rate limited`)
            continue
          }

          if (!res.ok) {
            const body = await res.text().catch(() => '')
            const errData = JSON.parse(body || '{}') as { error?: { message: string } }
            throw new Error(`Gemini ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
          }

          const data = await res.json() as {
            candidates: Array<{ content: { parts: Array<{ text: string }> } }>
            error?: { message: string }
          }

          if (data.error) throw new Error(data.error.message)

          const text = data.candidates[0]?.content?.parts[0]?.text ?? ''
          if (!text) throw new Error('Empty content from Gemini API')

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
 * Create an LLMEntailmentClient backed by Gemini.
 * Sends prompts WITHOUT SCHEMA_INSTRUCTION and returns raw extracted JSON
 * for stage3-rav to parse.
 */
export async function createGeminiEntailmentClient(
  model?: string,
  options: { apiKey?: string } = {}
): Promise<LLMEntailmentClient> {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const resolvedModel = model ?? GEMINI_MODELS.flash

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const res = await fetch(
        `${GEMINI_API_BASE}/${resolvedModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: [
              { role: 'user', parts: [{ text: userPrompt }] },
            ],
            generationConfig: {
              maxOutputTokens: 512,
              temperature:     0.1,
            },
          }),
          signal: AbortSignal.timeout(60_000),
        }
      )

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const errData = JSON.parse(body || '{}') as { error?: { message: string } }
        throw new Error(`Gemini entailment ${res.status}: ${errData.error?.message ?? body.slice(0, 100)}`)
      }

      const data = await res.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>
        error?: { message: string }
      }
      if (data.error) throw new Error(data.error.message)

      const text = data.candidates[0]?.content?.parts[0]?.text ?? ''
      return extractJson(text)
    },
  }
}
