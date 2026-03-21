/**
 * stage3-llamacpp.ts — LLM agents via llama.cpp llama-server.
 *
 * Starts llama-server.exe as a child process and exposes an OpenAI-compatible
 * HTTP API at http://localhost:<port>/v1.
 *
 * llama-server supports the full /v1/chat/completions endpoint so the same
 * createLocalAgent() call shape works — we just point it at port 8080.
 *
 * Usage:
 *   const server = await startLlamaCppServer({ model: LLAMACPP_MODELS.llama8b })
 *   const agent = server.createAgent('reviewer')
 *   // ... run experiment ...
 *   await server.stop()
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { LLMAgent } from './stage3.js'

// ── Paths ─────────────────────────────────────────────────────────────────────

// LLAMACPP_BASE must be set via environment variable — no default path is provided
// because the location is platform- and installation-specific.
// Example: export LLAMACPP_BASE=/opt/llamacpp
const LLAMACPP_BASE = process.env.LLAMACPP_BASE ?? ''

// SERVER_EXE can also be overridden directly via LLAMACPP_SERVER_EXE
const SERVER_EXE = process.env.LLAMACPP_SERVER_EXE
  ?? (LLAMACPP_BASE ? `${LLAMACPP_BASE}/llama-server` : '')

export const LLAMACPP_MODELS: Record<string, string> = LLAMACPP_BASE
  ? {
      llama8b:   `${LLAMACPP_BASE}/models/Llama-3_1-8B-Instruct-IQ4_XS/model.gguf`,
      mistral7b: `${LLAMACPP_BASE}/models/Mistral-7B-Instruct-v0_3_IQ4_XS/model.gguf`,
      gemma9b:   `${LLAMACPP_BASE}/models/gemma-2-9b-it-abliterated-IQ4_XS/model.gguf`,
      qwen32b:   `${LLAMACPP_BASE}/models/qwen2.5-32b-instruct-q3_k_m-00001-of-00005.gguf`,
    }
  : {}

export type LlamaCppModelKey = keyof typeof LLAMACPP_MODELS

// ── Server manager ────────────────────────────────────────────────────────────

export interface LlamaCppServerOptions {
  /** Model path or key from LLAMACPP_MODELS */
  model: string
  port?: number
  /** GPU layers to offload. Default: 99 (all, assumes CUDA GPU) */
  ngl?: number
  /** Context window size. Default: 4096 */
  ctxSize?: number
  /** Max tokens per response. Default: 512 */
  maxTokens?: number
  /** Print server stdout/stderr to console. Default: false */
  verbose?: boolean
}

export interface LlamaCppServer {
  baseUrl: string
  /** Create an LLMAgent pointed at this server */
  createAgent(id: string, timeoutMs?: number): LLMAgent
  /** Stop the server process */
  stop(): Promise<void>
}

const SCHEMA_INSTRUCTION = `Respond ONLY with valid JSON, no markdown fences, no explanation:
{"verdict":"confirmed"|"disputed"|"amended"|"rejected","confidence":<float 0.0-1.0>,"reasoning":"<one sentence>"}`

function extractJson(text: string): string {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object in LLM response')
  return stripped.slice(start, end + 1)
}

async function waitForServer(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`llama-server did not become ready within ${timeoutMs}ms`)
}

/**
 * Start llama-server with the given model and wait until it's ready.
 * Returns a handle you can use to create agents and stop the server.
 */
export async function startLlamaCppServer(opts: LlamaCppServerOptions): Promise<LlamaCppServer> {
  const modelPath = opts.model in LLAMACPP_MODELS
    ? LLAMACPP_MODELS[opts.model as LlamaCppModelKey]
    : opts.model

  if (!SERVER_EXE) {
    throw new Error('LLAMACPP_BASE or LLAMACPP_SERVER_EXE env var must be set to use llama.cpp backend.')
  }
  if (!existsSync(SERVER_EXE)) {
    throw new Error(`llama-server not found at ${SERVER_EXE}. Check LLAMACPP_BASE / LLAMACPP_SERVER_EXE.`)
  }
  if (!existsSync(modelPath)) {
    throw new Error(`Model not found: ${modelPath}`)
  }

  const port = opts.port ?? 8080
  const baseUrl = `http://localhost:${port}/v1`

  // Check if a server is already up at this port
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
    if (res.ok) {
      console.log(`  llama-server already running at ${baseUrl}`)
      return makeServerHandle(null, baseUrl, opts.maxTokens ?? 512)
    }
  } catch {
    // not running — start it
  }

  const args = [
    '-m', modelPath,
    '--port', String(port),
    '--ctx-size', String(opts.ctxSize ?? 4096),
    '-ngl', String(opts.ngl ?? 99),
    '--no-mmap',        // safer on Windows
    '--parallel', '1',  // one request at a time — experiments are sequential
  ]

  console.log(`  Starting llama-server: ${modelPath.split('/').pop()}`)

  const proc = spawn(SERVER_EXE, args, {
    stdio: opts.verbose ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  proc.on('error', err => {
    throw new Error(`Failed to start llama-server: ${err.message}`)
  })

  await waitForServer(`http://localhost:${port}`)
  console.log(`  llama-server ready at ${baseUrl}`)

  return makeServerHandle(proc, baseUrl, opts.maxTokens ?? 512)
}

function makeServerHandle(
  proc: ChildProcess | null,
  baseUrl: string,
  maxTokens: number
): LlamaCppServer {
  return {
    baseUrl,

    createAgent(id: string, timeoutMs = 120_000): LLMAgent {
      return {
        id,
        model: 'llamacpp',
        async call(systemPrompt: string, userPrompt: string): Promise<string> {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const res = await fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'local',
                max_tokens: maxTokens,
                temperature: 0.1,
                messages: [
                  { role: 'system', content: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}` },
                  { role: 'user',   content: userPrompt },
                ],
              }),
              signal: controller.signal,
            })
            clearTimeout(timer)
            if (!res.ok) {
              const body = await res.text().catch(() => '')
              throw new Error(`llama-server ${res.status}: ${body.slice(0, 200)}`)
            }
            const data = await res.json() as {
              choices: Array<{ message: { content: string } }>
              error?: { message: string }
            }
            if (data.error) throw new Error(data.error.message)
            const content = data.choices[0]?.message?.content ?? ''
            const jsonStr = extractJson(content)
            JSON.parse(jsonStr)  // validate
            return jsonStr
          } catch (err) {
            clearTimeout(timer)
            if ((err as Error).name === 'AbortError') {
              throw new Error(`llama-server timeout after ${timeoutMs}ms`)
            }
            throw err
          }
        },
      }
    },

    async stop(): Promise<void> {
      if (!proc) return
      proc.kill('SIGTERM')
      await new Promise<void>(resolve => {
        proc.once('exit', () => resolve())
        setTimeout(resolve, 3000)  // force-resolve after 3s if process hangs
      })
    },
  }
}

/**
 * Check if a llama-server is already running at the given port.
 */
export async function isLlamaCppRunning(port = 8080): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

// ── Jan integration ───────────────────────────────────────────────────────────

const JAN_BASE_URL = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'
const JAN_API_KEY  = process.env.JAN_API_KEY  ?? '12345'

/**
 * Connect to an already-running Jan instance (OpenAI-compatible API).
 * Jan must be open with a model loaded. No process is spawned.
 *
 * @param modelId  Jan model identifier, e.g. "llama3.1-8b-instruct" —
 *                 must match what Jan has loaded. Pass undefined to use
 *                 the Jan default (first loaded model).
 */
export async function connectToJan(modelId?: string, maxTokens = 512): Promise<LlamaCppServer> {
  // Verify Jan is reachable
  try {
    await fetch(`${JAN_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${JAN_API_KEY}` },
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    throw new Error(`Jan is not reachable at ${JAN_BASE_URL}. Make sure Jan is open with a model loaded.`)
  }

  // Resolve model: use provided id or query Jan for the first available model
  let resolvedModel = modelId
  if (!resolvedModel) {
    const res = await fetch(`${JAN_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${JAN_API_KEY}` },
    })
    const data = await res.json() as { data?: Array<{ id: string }> }
    resolvedModel = data.data?.[0]?.id
    if (!resolvedModel) throw new Error('Jan has no models loaded')
    console.log(`  Jan: using model "${resolvedModel}"`)
  }

  const model = resolvedModel

  return {
    baseUrl: JAN_BASE_URL,

    createAgent(id: string, timeoutMs = 120_000): LLMAgent {
      return {
        id,
        model,
        async call(systemPrompt: string, userPrompt: string): Promise<string> {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const res = await fetch(`${JAN_BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${JAN_API_KEY}`,
              },
              body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                temperature: 0.1,
                messages: [
                  { role: 'system', content: `${systemPrompt}\n\n${SCHEMA_INSTRUCTION}` },
                  { role: 'user',   content: userPrompt },
                ],
              }),
              signal: controller.signal,
            })
            clearTimeout(timer)
            if (!res.ok) {
              const body = await res.text().catch(() => '')
              throw new Error(`Jan API ${res.status}: ${body.slice(0, 200)}`)
            }
            const data = await res.json() as {
              choices: Array<{ message: { content: string } }>
              error?: { message: string }
            }
            if (data.error) throw new Error(data.error.message)
            const content = data.choices[0]?.message?.content ?? ''
            const jsonStr = extractJson(content)
            JSON.parse(jsonStr)  // validate
            return jsonStr
          } catch (err) {
            clearTimeout(timer)
            if ((err as Error).name === 'AbortError') throw new Error(`Jan timeout after ${timeoutMs}ms`)
            throw err
          }
        },
      }
    },

    async stop(): Promise<void> {
      // Jan is a standalone app — we don't stop it
    },
  }
}

// ── Jan RAV entailment client ─────────────────────────────────────────────────

import type { LLMEntailmentClient } from './stage3-rav.js'

/**
 * Create an LLMEntailmentClient backed by Jan.
 * The entailment checker in stage3-rav uses free-form JSON responses, NOT the
 * AKP verdict schema, so we send the prompt directly without SCHEMA_INSTRUCTION
 * and return the raw text for stage3-rav to parse.
 *
 * @param modelId  Jan model ID, or undefined for auto-detect
 */
export async function createJanEntailmentClient(modelId?: string, maxTokens = 512): Promise<LLMEntailmentClient> {
  const janBaseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'
  const janApiKey  = process.env.JAN_API_KEY  ?? '12345'

  // Resolve model
  let resolvedModel = modelId
  if (!resolvedModel) {
    const res = await fetch(`${janBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${janApiKey}` },
      signal: AbortSignal.timeout(3000),
    })
    const data = await res.json() as { data?: Array<{ id: string }> }
    resolvedModel = data.data?.[0]?.id
    if (!resolvedModel) throw new Error('Jan has no models loaded')
  }
  const model = resolvedModel

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const res = await fetch(`${janBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${janApiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
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
        throw new Error(`Jan entailment API ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }>; error?: { message: string } }
      if (data.error) throw new Error(data.error.message)
      const content = data.choices[0]?.message?.content ?? ''
      return extractJson(content)
    },
  }
}
