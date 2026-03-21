/**
 * autoresearch-quality.ts — Measure autoresearch procedure generation quality.
 *
 * Runs 20 research questions through the autoresearch agent using a local LLM
 * (Jan), then attempts to execute each generated VerificationProcedure with
 * SandboxedReplicationAgent. Reports:
 *
 *   - % questions that produced ≥1 structured claim
 *   - % questions that produced ≥1 verifiable claim (has procedure)
 *   - % generated procedures that passed validation (runtime + size)
 *   - % generated procedures that ran without error (exit 0)
 *   - % generated procedures that output a valid JSON result
 *   - % generated procedures that returned verdict='reproduced'
 *
 * Run:
 *   JAN_API_KEY=12345 JAN_RUNNING=1 npx tsx src/bench/autoresearch-quality.ts
 *
 * Optional flags:
 *   AUTORESEARCH_MODEL=<jan-model-id>   override the model (default: auto-detect)
 *   AUTORESEARCH_DRY_RUN=1              skip procedure execution, only measure generation
 *   AUTORESEARCH_OUT=results.json       write full results to JSON file
 */

import { autoresearch, type AutoresearchLLMClient } from '../pipeline/autoresearch.js'
import { createSandboxedReplicationAgent, validateProcedure, ReplicationSecurityError } from '../pipeline/stage3-replication.js'
import { listJanModels } from '../pipeline/stage3-local.js'
import { writeFile } from 'node:fs/promises'

// ── 20 research questions ─────────────────────────────────────────────────────
//
// Deliberately varied: quantitative (computable), lookup (SPARQL), qualitative
// (no procedure expected), and misconception-adjacent (where a procedure can
// definitively falsify).

const QUESTIONS = [
  // Quantitative — should generate code procedures
  'What is the boiling point of water at sea level in Celsius?',
  'What is the gravitational acceleration at Earth\'s surface in m/s²?',
  'What is the speed of light in a vacuum in metres per second?',
  'What is the atomic number of carbon?',
  'What is the melting point of ice at standard atmospheric pressure?',
  'How many bits are in a byte?',
  'What is pi to 5 decimal places?',
  'What is the molecular weight of CO2 in g/mol?',
  'What is the half-life of Carbon-14 in years?',
  'How many chromosomes does a human diploid cell contain?',

  // Factual — may generate query or protocol procedures
  'Who discovered penicillin and in what year?',
  'What organism causes malaria?',
  'What is the chemical formula of table salt?',
  'How many planets are in the solar system?',
  'What type of bond holds water molecules together?',

  // Misconception-adjacent — procedure should falsify common myths
  'Do humans use only 10% of their brain?',
  'Is glass a slow-moving liquid at room temperature?',
  'Did Einstein fail mathematics in school?',
  'Does lightning never strike the same place twice?',
  'Is the Great Wall of China visible from space with the naked eye?',
]

// ── Jan LLM client ────────────────────────────────────────────────────────────

function createJanClient(model: string): AutoresearchLLMClient {
  const baseUrl = process.env.JAN_BASE_URL ?? 'http://localhost:1337/v1'
  const apiKey = process.env.JAN_API_KEY ?? '12345'

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Jan API ${res.status}: ${body.slice(0, 200)}`)
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>
        error?: { message: string }
      }
      if (data.error) throw new Error(data.error.message)
      return data.choices[0]?.message?.content ?? '{}'
    },
  }
}

// ── Per-question result ───────────────────────────────────────────────────────

interface QuestionResult {
  question: string
  claims: number
  verifiableClaims: number
  draftOnlyClaims: number
  procedures: ProcedureResult[]
  llmMs: number
  error?: string
}

interface ProcedureResult {
  claimSubject: string
  claimPredicate: string
  runtime: string
  validationPassed: boolean
  validationError?: string
  executed: boolean
  exitCode?: number
  execMs?: number
  outputValid: boolean
  verdict?: string
  deviationPct?: number
  stdout?: string
  stderr?: string
}

// ── Benchmark runner ─────────────────────────────────────────────────────────

async function runBenchmark(): Promise<void> {
  const dryRun = process.env.AUTORESEARCH_DRY_RUN === '1'
  const outFile = process.env.AUTORESEARCH_OUT

  // Auto-detect model
  let model = process.env.AUTORESEARCH_MODEL ?? ''
  if (!model) {
    try {
      const hot = await listJanModels()
      if (hot.length === 0) throw new Error('No model loaded in Jan')
      model = hot[0]
    } catch (err) {
      console.error(`Cannot detect Jan model: ${err}`)
      process.exit(1)
    }
  }

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  AKP Autoresearch Quality Benchmark`)
  console.log(`  Model:    ${model}`)
  console.log(`  Mode:     ${dryRun ? 'DRY RUN (no execution)' : 'FULL (generate + execute)'}`)
  console.log(`  Questions: ${QUESTIONS.length}`)
  console.log(`${'═'.repeat(70)}\n`)

  const client = createJanClient(model)
  const sandboxAgent = dryRun ? null : createSandboxedReplicationAgent(
    'did:key:bench-sandbox',
    'bench-sandbox'
  )

  const results: QuestionResult[] = []
  let qNum = 0

  for (const question of QUESTIONS) {
    qNum++
    const shortQ = question.slice(0, 60) + (question.length > 60 ? '…' : '')
    process.stdout.write(`[${qNum.toString().padStart(2)}/${QUESTIONS.length}] ${shortQ}\n`)

    const t0 = Date.now()
    let qResult: QuestionResult

    try {
      const ar = await autoresearch(question, client, {
        domain: 'benchmark',
        agentDid: 'did:key:bench-autoresearch',
        agentModel: model,
        maxClaims: 5,
      })
      const llmMs = Date.now() - t0

      const procedures: ProcedureResult[] = []

      for (const claim of ar.ku.structured.claims) {
        if (!claim.verificationProcedure) continue

        const proc = claim.verificationProcedure
        const pr: ProcedureResult = {
          claimSubject: claim.subject,
          claimPredicate: claim.predicate,
          runtime: proc.runtime,
          validationPassed: false,
          executed: false,
          outputValid: false,
        }

        // Validation
        try {
          validateProcedure(proc)
          pr.validationPassed = true
        } catch (err) {
          pr.validationError = err instanceof ReplicationSecurityError
            ? err.message
            : String(err)
          procedures.push(pr)
          continue
        }

        // Execution (skip for dry run or non-node runtimes on Windows)
        if (dryRun || !sandboxAgent || !proc.runtime.startsWith('node')) {
          pr.executed = false
          procedures.push(pr)
          continue
        }

        try {
          const execT0 = Date.now()
          const output = await sandboxAgent.execute(proc, claim.id)
          pr.executed = true
          pr.exitCode = output.exitCode
          pr.execMs = Date.now() - execT0
          pr.stdout = output.stdout.slice(0, 300)
          pr.stderr = output.stderr.slice(0, 200)

          // Parse output
          try {
            const parsed = JSON.parse(output.stdout.trim()) as Record<string, unknown>
            if (parsed.verdict) {
              pr.outputValid = true
              pr.verdict = parsed.verdict as string
              if (typeof parsed.deviationPct === 'number') pr.deviationPct = parsed.deviationPct
            }
          } catch {
            pr.outputValid = false
          }
        } catch (err) {
          pr.execMs = Date.now() - t0
          pr.stderr = String(err).slice(0, 200)
        }

        procedures.push(pr)
      }

      qResult = {
        question,
        claims: ar.ku.structured.claims.length,
        verifiableClaims: ar.verifiableClaims,
        draftOnlyClaims: ar.draftOnlyClaims,
        procedures,
        llmMs,
      }

      // Print per-question summary
      const vLabel = ar.verifiableClaims > 0 ? `✓ ${ar.verifiableClaims} verifiable` : `✗ 0 verifiable`
      console.log(`       claims=${ar.ku.structured.claims.length}  ${vLabel}  llm=${llmMs}ms`)
      for (const p of procedures) {
        const status = p.verdict === 'reproduced' ? '✓ REPRODUCED'
          : p.verdict ? `~ ${p.verdict.toUpperCase()}`
          : p.executed ? '✗ bad output'
          : p.validationPassed ? '— not executed'
          : `✗ INVALID: ${p.validationError?.slice(0, 50)}`
        console.log(`       [${p.runtime}] ${p.claimSubject}.${p.claimPredicate} → ${status}`)
      }

    } catch (err) {
      const llmMs = Date.now() - t0
      console.log(`       ERROR: ${String(err).slice(0, 100)}`)
      qResult = { question, claims: 0, verifiableClaims: 0, draftOnlyClaims: 0, procedures: [], llmMs, error: String(err) }
    }

    results.push(qResult)
  }

  // ── Aggregate metrics ────────────────────────────────────────────────────────

  const total = results.length
  const withAnyClaim    = results.filter(r => r.claims > 0).length
  const withVerifiable  = results.filter(r => r.verifiableClaims > 0).length
  const allProcs        = results.flatMap(r => r.procedures)
  const validProcs      = allProcs.filter(p => p.validationPassed)
  const executedProcs   = allProcs.filter(p => p.executed)
  const validOutputProcs = allProcs.filter(p => p.outputValid)
  const reproducedProcs  = allProcs.filter(p => p.verdict === 'reproduced')
  const errors          = results.filter(r => r.error).length
  const avgLlmMs        = Math.round(results.reduce((s, r) => s + r.llmMs, 0) / total)

  const pct = (n: number, d: number) => d === 0 ? 'N/A' : `${((n / d) * 100).toFixed(0)}%`

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  AUTORESEARCH QUALITY RESULTS  (model: ${model})`)
  console.log(`${'═'.repeat(70)}`)
  console.log(`  Questions:                     ${total}`)
  console.log(`  LLM errors:                    ${errors}`)
  console.log(`  Avg LLM latency:               ${avgLlmMs}ms`)
  console.log()
  console.log(`  ── Generation ───────────────────────────────────────────`)
  console.log(`  Produced ≥1 claim:             ${withAnyClaim}/${total}  (${pct(withAnyClaim, total)})`)
  console.log(`  Produced ≥1 verifiable claim:  ${withVerifiable}/${total}  (${pct(withVerifiable, total)})`)
  console.log(`  Total procedures generated:    ${allProcs.length}`)
  console.log(`  Passed validation:             ${validProcs.length}/${allProcs.length}  (${pct(validProcs.length, allProcs.length)})`)
  console.log()

  if (!dryRun && executedProcs.length > 0) {
    console.log(`  ── Execution ────────────────────────────────────────────`)
    console.log(`  Executed (node@22 only):       ${executedProcs.length}/${validProcs.filter(p => p.runtime.startsWith('node')).length}`)
    console.log(`  Valid JSON output:             ${validOutputProcs.length}/${executedProcs.length}  (${pct(validOutputProcs.length, executedProcs.length)})`)
    console.log(`  Verdict=reproduced:            ${reproducedProcs.length}/${executedProcs.length}  (${pct(reproducedProcs.length, executedProcs.length)})`)
  }

  // ── Per-question table ───────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`)
  console.log(`  Per-question breakdown`)
  console.log(`${'─'.repeat(70)}`)
  for (const r of results) {
    const q = r.question.slice(0, 50).padEnd(52)
    const v = r.verifiableClaims > 0 ? `v:${r.verifiableClaims}` : '  -'
    const d = r.draftOnlyClaims > 0 ? `d:${r.draftOnlyClaims}` : '  -'
    const rep = r.procedures.filter(p => p.verdict === 'reproduced').length
    const repLabel = rep > 0 ? `✓${rep}` : '  '
    const errLabel = r.error ? ' ERR' : '    '
    console.log(`  ${q} ${v} ${d} ${repLabel}${errLabel}`)
  }
  console.log(`${'═'.repeat(70)}\n`)

  // ── Write JSON output ────────────────────────────────────────────────────────
  if (outFile) {
    const report = {
      model,
      runAt: new Date().toISOString(),
      summary: {
        total, withAnyClaim, withVerifiable, errors, avgLlmMs,
        totalProcedures: allProcs.length,
        validProcedures: validProcs.length,
        executedProcedures: executedProcs.length,
        validOutputProcedures: validOutputProcs.length,
        reproducedProcedures: reproducedProcs.length,
        pctWithVerifiable: withVerifiable / total,
        pctValidProcedures: allProcs.length > 0 ? validProcs.length / allProcs.length : 0,
        pctReproduced: executedProcs.length > 0 ? reproducedProcs.length / executedProcs.length : 0,
      },
      questions: results,
    }
    await writeFile(outFile, JSON.stringify(report, null, 2), 'utf8')
    console.log(`Results written to ${outFile}`)
  }
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
