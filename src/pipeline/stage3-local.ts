/**
 * stage3-local.ts — Local LLM agents via Jan (or any OpenAI-compatible local server).
 *
 * Jan exposes an OpenAI-compatible API at http://localhost:1337/v1
 * Models are specified by their Jan model ID (visible in Jan's model catalog).
 *
 * Recommended models for 16GB VRAM (5070 Ti), download in Jan:
 *   - llama3.1-8b-instruct        (Meta Llama 3.1 8B Instruct, Q5_K_M ~5.4GB)
 *   - mistral-7b-instruct         (Mistral 7B Instruct v0.3, Q5_K_M ~5.0GB)
 *   - gemma2-9b-instruct          (Gemma 2 9B Instruct, Q4_K_M ~5.5GB)
 *
 * Jan auto-swaps models when a different model is requested via API.
 * Sequential calls (our default) mean only one model is hot at a time.
 */

import type { LLMAgent } from './stage3.js'

export interface LocalAgentOptions {
  baseUrl?: string      // default: http://localhost:1337/v1
  timeoutMs?: number    // per-call timeout, default: 120s (model swap can take ~10-30s)
  maxTokens?: number
}

/** Jan model IDs — match exactly what appears in Jan's model list */
export const JAN_MODELS = {
  // Currently loaded
  gemma9bAbliterated: 'gemma-2-9b-it-abliterated-IQ4_XS',
  // Download these for full 3-agent independence pool:
  llama8b: 'llama3.1-8b-instruct',
  mistral7b: 'mistral-7b-instruct',
  gemma9b: 'gemma2-9b-instruct',
  // Smaller alternatives
  phi35mini: 'phi-3.5-mini-instruct',
  qwen7b: 'qwen2.5-7b-instruct',
  llama3b: 'llama3.2-3b-instruct',
} as const

/**
 * Auto-detect which models are actually loaded in Jan right now.
 */
export async function detectLoadedModels(
  baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'
): Promise<string[]> {
  return listJanModels(baseUrl)
}

/**
 * Start (load) a model in Jan. Jan must have the model downloaded.
 * Jan can only run one model at a time — starting a new one unloads the previous.
 */
export async function startJanModel(
  modelId: string,
  baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1',
  { pollIntervalMs = 2000, pollTimeoutMs = 60_000 } = {}
): Promise<void> {
  const apiKey = process.env.JAN_API_KEY ?? 'local'
  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}/start`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 409 = model already running, 404 = already active / Jan quirk — not errors for our purposes
    if (res.status !== 409 && res.status !== 404) {
      throw new Error(`Failed to start model ${modelId}: ${res.status} ${body.slice(0, 100)}`)
    }
  }

  // Poll listJanModels until the target model appears as hot
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    try {
      const hot = await listJanModels(baseUrl)
      if (hot.includes(modelId)) return  // model is ready
    } catch {
      // Jan temporarily unreachable during model swap — keep polling
    }
    await sleep(pollIntervalMs)
  }
  throw new Error(`Model ${modelId} did not become ready within ${pollTimeoutMs}ms`)
}

/**
 * Stop (unload) a model in Jan.
 */
export async function stopJanModel(
  modelId: string,
  baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'
): Promise<void> {
  const apiKey = process.env.JAN_API_KEY ?? 'local'
  await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}/stop`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  })
}

const SCHEMA_INSTRUCTION = `Respond ONLY with valid JSON, no markdown fences:
{"verdict":"confirmed"|"disputed"|"uncertain","confidence":<float 0.0-1.0>,"reasoning":"<brief explanation>","sources":[],"counterexamples":[]}`

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found in response')
  return stripped.slice(start, end + 1)
}

export function createLocalAgent(
  id: string,
  model: string,
  options: LocalAgentOptions = {}
): LLMAgent {
  const {
    baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1',
    timeoutMs = 120_000,  // generous — model swap adds 10-30s cold start
    maxTokens = 512,
  } = options

  const apiKey = process.env.JAN_API_KEY ?? 'local'

  return {
    id,
    model,
    async call(systemPrompt: string, userPrompt: string): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0.1,   // low temp for factual consistency
            messages: [
              { role: 'system', content: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}` },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`Local API ${res.status}: ${body.slice(0, 200)}`)
        }

        const data = await res.json() as {
          choices: Array<{ message: { content: string }; finish_reason: string }>
          error?: { message: string }
        }

        if (data.error) throw new Error(data.error.message)

        const content = data.choices[0]?.message?.content
        if (!content) throw new Error(`Empty response (finish_reason=${data.choices[0]?.finish_reason})`)

        const jsonStr = extractJson(content)
        JSON.parse(jsonStr) // validate
        return jsonStr
      } catch (err) {
        clearTimeout(timer)
        if ((err as Error).name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms — model may be loading`)
        throw err
      }
    },
  }
}

/**
 * Check if the local Jan server is running and a model is available.
 */
export async function isJanRunning(baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'): Promise<boolean> {
  try {
    const apiKey = process.env.JAN_API_KEY ?? 'local'
    const res = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * List models currently available in Jan.
 */
export async function listJanModels(baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'): Promise<string[]> {
  const apiKey = process.env.JAN_API_KEY ?? 'local'
  const res = await fetch(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`Jan API error: ${res.status}`)
  const data = await res.json() as { data: Array<{ id: string }> }
  return data.data.map(m => m.id)
}

/**
 * Create the recommended 3-agent pool for independence analysis.
 * Models are called sequentially — Jan auto-swaps between them.
 *
 * Requires all three models to be downloaded in Jan.
 * Call order: Llama → Mistral → Gemma (each ~10-30s cold start if not hot)
 */
export function createLocalAgentPool(options: LocalAgentOptions = {}): LLMAgent[] {
  return [
    createLocalAgent('llama-8b', JAN_MODELS.llama8b, options),
    createLocalAgent('mistral-7b', JAN_MODELS.mistral7b, options),
    createLocalAgent('gemma-9b', JAN_MODELS.gemma9b, options),
  ]
}

/**
 * Create a fast single-agent using whichever Jan model is currently loaded.
 * Pass the model ID explicitly, or it defaults to Llama 3.1 8B.
 */
export function createLocalFastAgent(
  model = JAN_MODELS.llama8b,
  options: LocalAgentOptions = {}
): LLMAgent {
  return createLocalAgent('local-fast', model, options)
}
