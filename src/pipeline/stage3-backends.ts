/**
 * stage3-backends.ts — Unified LLM backend selector.
 *
 * Resolves a provider name + optional model ID to a ready LLMAgent.
 * Reads credentials from environment variables automatically.
 *
 * Supported providers:
 *   jan        Local Jan app (localhost:1337, OpenAI-compatible)
 *   llamacpp   Local llama.cpp server
 *   claude     Anthropic Claude API  (ANTHROPIC_API_KEY)
 *   openai     OpenAI API            (OPENAI_API_KEY)
 *   gemini     Google Gemini API     (GEMINI_API_KEY)
 *   openrouter OpenRouter API        (OPENROUTER_API_KEY)
 *
 * Usage:
 *   const { agent, stop } = await resolveBackend({ provider: 'claude', model: 'claude-haiku-4-5-20251001' })
 *   // ... run experiments ...
 *   await stop()
 */

import { connectToJan, type LlamaCppServer } from './stage3-llamacpp.js'
import { createClaudeAgent } from './stage3-claude.js'
import { createOpenAIAgent } from './stage3-openai.js'
import { createGeminiAgent } from './stage3-gemini.js'
import { createOpenRouterAgent, discoverAvailableModels, FREE_MODEL_CANDIDATES } from './stage3-openrouter.js'
import type { LLMAgent } from './stage3.js'

export type Provider = 'jan' | 'llamacpp' | 'claude' | 'openai' | 'gemini' | 'openrouter'

export interface BackendOptions {
  provider: Provider
  /** Model ID. Pass undefined / 'auto' to use provider default. */
  model?: string
}

export interface ResolvedBackend {
  agent: LLMAgent
  /** Call after experiments finish to clean up any spawned processes. */
  stop: () => Promise<void>
  /** Human-readable label for logging. */
  label: string
}

/**
 * Detect which provider is available based on environment variables.
 * Returns the first provider whose API key is set, or 'jan' as default.
 */
export function detectProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'claude'
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.GEMINI_API_KEY) return 'gemini'
  if (process.env.OPENROUTER_API_KEY) return 'openrouter'
  return 'jan'
}

export async function resolveBackend(opts: BackendOptions): Promise<ResolvedBackend> {
  const modelId = opts.model === 'auto' ? undefined : opts.model

  switch (opts.provider) {
    case 'jan': {
      console.log(`  Connecting to Jan at localhost:1337 (model: ${modelId ?? 'auto-detect'})`)
      const server = await connectToJan(modelId) as LlamaCppServer
      const agent = server.createAgent('jan-reviewer')
      return {
        agent,
        stop: () => server.stop(),
        label: `jan/${agent.model}`,
      }
    }

    case 'claude': {
      const model = modelId ?? 'claude-sonnet-4-6'
      console.log(`  Using Claude (model: ${model})`)
      const agent = createClaudeAgent('claude-reviewer', model)
      return { agent, stop: async () => {}, label: `claude/${model}` }
    }

    case 'openai': {
      const model = modelId ?? 'gpt-4o-mini'
      console.log(`  Using OpenAI (model: ${model})`)
      const agent = createOpenAIAgent('openai-reviewer', model)
      return { agent, stop: async () => {}, label: `openai/${model}` }
    }

    case 'gemini': {
      const model = modelId ?? 'gemini-2.0-flash'
      console.log(`  Using Gemini (model: ${model})`)
      const agent = createGeminiAgent('gemini-reviewer', model)
      return { agent, stop: async () => {}, label: `gemini/${model}` }
    }

    case 'openrouter': {
      const model = modelId ?? (await discoverAvailableModels(FREE_MODEL_CANDIDATES, {}, 1))[0]
      if (!model) throw new Error('No models available on OpenRouter')
      console.log(`  Using OpenRouter (model: ${model})`)
      const agent = createOpenRouterAgent('openrouter-reviewer', model)
      return { agent, stop: async () => {}, label: `openrouter/${model}` }
    }

    case 'llamacpp':
      throw new Error('llamacpp backend requires startLlamaCppServer() — use directly from stage3-llamacpp.ts')

    default:
      throw new Error(`Unknown provider: ${opts.provider as string}`)
  }
}
