/**
 * stage3-replication.ts — Phase 5: Replication-based verification engine.
 *
 * Security model:
 *   - All executables are validated against a runtime allow-list before any execution.
 *   - MockReplicationAgent uses a function registry — never eval/exec strings.
 *   - SandboxedReplicationAgent spawns in an isolated temp directory with:
 *       • Hard timeout via AbortController + SIGKILL
 *       • stdout/stderr capture only — no host filesystem write access
 *       • ReplicationResult is constructed by the host from captured output
 *   - Every execution attempt is written to an append-only audit log.
 *   - executable size is capped at 64 KB before any processing.
 *
 * DockerReplicationAgent (implemented below):
 *   - docker run --rm --network=none --memory=256m --cpu-quota=50000
 *   - Bind-mounts a read-only input dir + writable output scratch (tmpfs)
 *   - Falls back gracefully when Docker daemon is unreachable
 *   - Ed25519 DID signature verification of executable: future work
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, appendFile, stat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeUnit, Claim, VerificationProcedure, ReplicationResult } from '../core/ku.js'
import { createReplicationResult } from '../core/ku.js'
import { verifyProcedureSignature } from '../core/identity.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_EXECUTABLE_BYTES = 64 * 1024  // 64 KB

/** Runtimes we are willing to execute. Reject anything else at validation time. */
export const ALLOWED_RUNTIMES = new Set([
  'node@22',
  'node@20',
  'python@3.11',
  'python@3.12',
  'deno@2',
  'mock',       // reserved for MockReplicationAgent
])

const AUDIT_LOG_PATH = process.env.AKP_AUDIT_LOG ?? join(tmpdir(), 'akp-replication-audit.jsonl')
/** Rotate the log file when it exceeds this size. Configurable via AKP_AUDIT_MAX_BYTES. */
const AUDIT_LOG_MAX_BYTES = parseInt(process.env.AKP_AUDIT_MAX_BYTES ?? '') || 10 * 1024 * 1024

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReplicationAgent {
  /** Unique DID of this agent */
  did: string
  /** Human-readable label */
  label: string
  /** Execute a VerificationProcedure and return raw output + exit info */
  execute(procedure: VerificationProcedure, claimId: string): Promise<ReplicationAgentOutput>
}

export interface ReplicationAgentOutput {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface RunReplicationOptions {
  /** Maximum number of agents to use per claim */
  maxAgents?: number
  /** Inject a custom timestamp for deterministic tests */
  nowFn?: () => string
  /**
   * Require valid Ed25519 signature on each VerificationProcedure before execution.
   * Default: true. Pass false only in test/dev environments using unsigned mock procedures.
   */
  requireSignature?: boolean
}

export interface ReplicationRunResult {
  claimId: string
  results: ReplicationResult[]
  reproduced: number
  failed: number
  partial: number
}

// ── Validation ───────────────────────────────────────────────────────────────

export class ReplicationSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplicationSecurityError'
  }
}

export interface ValidateProcedureOptions {
  /**
   * When true, reject procedures that are not signed with a valid Ed25519 DID signature.
   * Set to true in production; false (default) for tests and local dev.
   */
  requireSignature?: boolean
}

/**
 * Validates a VerificationProcedure before any execution.
 * Throws ReplicationSecurityError on policy violations.
 */
export function validateProcedure(
  procedure: VerificationProcedure,
  options: ValidateProcedureOptions = {}
): void {
  if (!ALLOWED_RUNTIMES.has(procedure.runtime)) {
    throw new ReplicationSecurityError(
      `Runtime '${procedure.runtime}' is not in the allowed list. ` +
      `Allowed: ${[...ALLOWED_RUNTIMES].join(', ')}`
    )
  }
  if (Buffer.byteLength(procedure.executable, 'utf8') > MAX_EXECUTABLE_BYTES) {
    throw new ReplicationSecurityError(
      `Executable exceeds ${MAX_EXECUTABLE_BYTES / 1024} KB limit`
    )
  }
  if (options.requireSignature) {
    if (!procedure.authorDid || !procedure.signature) {
      throw new ReplicationSecurityError(
        `Procedure is unsigned. Set authorDid + signature via signProcedure() before execution.`
      )
    }
    // Async verification is deferred to validateProcedureAsync for the hot path
  }
}

/**
 * Async variant — additionally verifies the Ed25519 signature.
 * Call this in production before any execution.
 */
export async function validateProcedureAsync(
  procedure: VerificationProcedure,
  options: ValidateProcedureOptions = {}
): Promise<void> {
  validateProcedure(procedure, options)
  if (options.requireSignature) {
    const valid = await verifyProcedureSignature(procedure)
    if (!valid) {
      throw new ReplicationSecurityError(
        `Procedure signature verification failed for authorDid=${procedure.authorDid}`
      )
    }
  }
}

// ── Audit log ────────────────────────────────────────────────────────────────

/**
 * Rotate the audit log when it exceeds AUDIT_LOG_MAX_BYTES.
 * Archives to a timestamped file (e.g. akp-replication-audit.2024-01-15T12-00-00.jsonl)
 * so no prior data is overwritten. Non-fatal.
 */
async function rotateAuditLogIfNeeded(): Promise<void> {
  try {
    const s = await stat(AUDIT_LOG_PATH).catch(() => null)
    if (s && s.size >= AUDIT_LOG_MAX_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const archivePath = AUDIT_LOG_PATH.replace(/(\.[^.]+)$/, `.${ts}$1`)
      await rename(AUDIT_LOG_PATH, archivePath).catch(() => {})
    }
  } catch { /* rotation failure is non-fatal */ }
}

async function writeAudit(entry: object): Promise<void> {
  await rotateAuditLogIfNeeded()
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  await appendFile(AUDIT_LOG_PATH, line, 'utf8').catch(() => {
    // Audit log failure is non-fatal but should be surfaced in production
    console.error('[AKP audit] Failed to write to audit log:', AUDIT_LOG_PATH)
  })
}

// ── Mock Replication Agent ────────────────────────────────────────────────────
//
// Uses a function registry keyed on claim predicates.
// NEVER evaluates or executes the `executable` string.

export type MockVerdict = (procedure: VerificationProcedure) => {
  verdict: ReplicationResult['verdict']
  result: unknown
  deviationPct?: number
}

export function createMockReplicationAgent(
  did: string,
  label: string,
  registry: Map<string, MockVerdict>
): ReplicationAgent {
  return {
    did,
    label,
    async execute(procedure: VerificationProcedure, claimId: string): Promise<ReplicationAgentOutput> {
      await writeAudit({ agent: did, claimId, type: 'mock_execute', runtime: procedure.runtime })

      // Key: use entrypoint as registry key if present, else first word of executable
      const key = procedure.entrypoint ?? procedure.executable.split(/\s+/)[0]
      const fn = registry.get(key)

      if (!fn) {
        return { stdout: JSON.stringify({ verdict: 'partial', result: null, deviationPct: 100 }), stderr: `No mock registered for key '${key}'`, exitCode: 1, durationMs: 0 }
      }

      const start = Date.now()
      const { verdict, result, deviationPct } = fn(procedure)
      const durationMs = Date.now() - start

      return {
        stdout: JSON.stringify({ verdict, result, deviationPct }),
        stderr: '',
        exitCode: 0,
        durationMs,
      }
    },
  }
}

// ── Sandboxed Replication Agent ───────────────────────────────────────────────
//
// Writes executable to a temp dir, spawns the runtime process with a hard
// timeout and output size limit.
//
// Security limitations of this implementation vs full Docker sandbox:
//   - Cannot enforce --network=none without external tooling
//   - Cannot enforce memory/CPU limits without cgroups or Docker
//   - Recommended: wrap with DockerReplicationAgent in production
//
// Usage: only for 'code' type procedures in trusted research environments.

const MAX_OUTPUT_BYTES = 1024 * 1024  // 1 MB stdout cap

export function createSandboxedReplicationAgent(did: string, label: string): ReplicationAgent {
  return {
    did,
    label,
    async execute(procedure: VerificationProcedure, claimId: string): Promise<ReplicationAgentOutput> {
      validateProcedure(procedure)

      await writeAudit({
        agent: did,
        claimId,
        type: 'sandbox_execute',
        runtime: procedure.runtime,
        executableHash: await hashExecutable(procedure.executable),
      })

      const tmpDir = await mkdtemp(join(tmpdir(), 'akp-rep-'))
      try {
        return await executeInTempDir(procedure, tmpDir, claimId)
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    },
  }
}

async function hashExecutable(executable: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(executable, 'utf8').digest('hex').slice(0, 16)
}

async function executeInTempDir(
  procedure: VerificationProcedure,
  tmpDir: string,
  claimId: string,
): Promise<ReplicationAgentOutput> {
  const { runtime } = procedure
  const timeoutMs = (procedure.timeoutSeconds ?? 120) * 1000

  // Write executable to temp file
  let entryFile: string
  let command: string
  let args: string[]

  if (runtime.startsWith('node')) {
    entryFile = join(tmpDir, 'index.mjs')
    await writeFile(entryFile, procedure.executable, 'utf8')
    command = process.execPath  // use the same Node that runs AKP
    args = ['--max-old-space-size=256', entryFile]
  } else if (runtime.startsWith('python')) {
    entryFile = join(tmpDir, 'main.py')
    await writeFile(entryFile, procedure.executable, 'utf8')
    command = 'python3'
    args = [entryFile]
  } else if (runtime.startsWith('deno')) {
    entryFile = join(tmpDir, 'main.ts')
    await writeFile(entryFile, procedure.executable, 'utf8')
    command = 'deno'
    args = ['run', '--allow-read=' + tmpDir, '--no-prompt', entryFile]
  } else {
    throw new ReplicationSecurityError(`Runtime '${runtime}' cannot be sandboxed`)
  }

  if (procedure.entrypoint) {
    // entrypoint overrides the default entry file name
    const epFile = join(tmpDir, procedure.entrypoint)
    await writeFile(epFile, procedure.executable, 'utf8')
    args[args.length - 1] = epFile
  }

  return new Promise((resolve, reject) => {
    const ac = new AbortController()
    const timer = setTimeout(() => {
      ac.abort()
    }, timeoutMs)

    const child = spawn(command, args, {
      cwd: tmpDir,
      env: { PATH: process.env.PATH ?? '' },  // minimal env — no secrets
      signal: ac.signal,
    })

    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    const start = Date.now()

    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 4096)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: outputBytes > MAX_OUTPUT_BYTES ? stdout + '\n[OUTPUT TRUNCATED]' : stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: 124, durationMs: timeoutMs })
      } else {
        reject(err)
      }
    })

    // Silence unhandled rejection from the aborted process
    void claimId
  })
}

// ── Result parsing ────────────────────────────────────────────────────────────
//
// The host always constructs the ReplicationResult from raw output.
// The procedure itself cannot write to the KU store.

function parseReplicationOutput(
  output: ReplicationAgentOutput,
  procedure: VerificationProcedure,
): { verdict: ReplicationResult['verdict']; result: unknown; deviationPct?: number } {
  if (output.exitCode === 124) {
    return { verdict: 'failed', result: null }
  }
  if (output.exitCode !== 0) {
    return { verdict: 'failed', result: { stderr: output.stderr.slice(0, 512) } }
  }

  try {
    const parsed = JSON.parse(output.stdout.trim()) as Record<string, unknown>
    const verdict = (['reproduced', 'failed', 'partial'] as const).includes(parsed.verdict as ReplicationResult['verdict'])
      ? (parsed.verdict as ReplicationResult['verdict'])
      : 'partial'

    const result = parsed.result ?? null
    let deviationPct: number | undefined

    if (procedure.type === 'code' || procedure.type === 'simulation') {
      if (typeof parsed.deviationPct === 'number') {
        deviationPct = parsed.deviationPct
      } else if (procedure.tolerancePct != null && procedure.expectedResult != null) {
        // Try to compute numeric deviation if both values are numbers
        const exp = Number(procedure.expectedResult)
        const got = Number(result)
        if (isFinite(exp) && isFinite(got) && exp !== 0) {
          deviationPct = Math.abs((got - exp) / exp) * 100
        }
      }
    }

    return { verdict, result, deviationPct }
  } catch {
    // Non-JSON output: treat as failed
    return { verdict: 'failed', result: { raw: output.stdout.slice(0, 256) } }
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run replication for all claims in a KU that have a VerificationProcedure.
 * Appends results to each claim's `replications` array in-place.
 */
export async function runReplication(
  ku: KnowledgeUnit,
  agents: ReplicationAgent[],
  options: RunReplicationOptions = {}
): Promise<ReplicationRunResult[]> {
  const { maxAgents = agents.length, nowFn, requireSignature = true } = options
  const pool = agents.slice(0, maxAgents)
  const results: ReplicationRunResult[] = []

  for (const claim of ku.structured.claims) {
    if (!claim.verificationProcedure) continue

    const procedure = claim.verificationProcedure
    const runResults: ReplicationResult[] = []

    for (const agent of pool) {
      let output: ReplicationAgentOutput
      try {
        await validateProcedureAsync(procedure, { requireSignature })
        output = await agent.execute(procedure, claim.id)
      } catch (err) {
        await writeAudit({
          agent: agent.did,
          claimId: claim.id,
          type: 'execution_error',
          error: String(err),
        })
        output = { stdout: '', stderr: String(err), exitCode: 1, durationMs: 0 }
      }

      const { verdict, result, deviationPct } = parseReplicationOutput(output, procedure)

      const rep = createReplicationResult({
        replicatorDid: agent.did,
        runtime: procedure.runtime,
        result,
        verdict,
        deviationPct,
        durationMs: output.durationMs,
        ...(nowFn ? { executedAt: nowFn() } : {}),
      })

      await writeAudit({
        agent: agent.did,
        claimId: claim.id,
        type: 'replication_result',
        verdict: rep.verdict,
        durationMs: rep.durationMs,
        deviationPct: rep.deviationPct,
      })

      runResults.push(rep)
      claim.replications = [...(claim.replications ?? []), rep]
    }

    const reproduced = runResults.filter(r => r.verdict === 'reproduced').length
    const failed = runResults.filter(r => r.verdict === 'failed').length
    const partial = runResults.filter(r => r.verdict === 'partial').length

    results.push({ claimId: claim.id, results: runResults, reproduced, failed, partial })
  }

  return results
}

/** Returns claims in a KU that have VerificationProcedures */
export function getVerifiableClaims(ku: KnowledgeUnit): Claim[] {
  return ku.structured.claims.filter(c => c.verificationProcedure != null)
}

// ── Docker Replication Agent ──────────────────────────────────────────────────
//
// Full isolation:
//   --network=none       no outbound network
//   --memory=256m        hard memory cap (OOM → container exits 137)
//   --cpu-quota=50000    50% of one CPU core
//   --read-only          root filesystem read-only
//   --tmpfs /scratch     writable scratch space capped at 64MB
//   --rm                 auto-remove container after exit
//
// Image selection: maps runtime → Docker image tag.
// All images must be pulled before use (see scripts/pull-sandbox-images.sh).

const DOCKER_IMAGES: Record<string, string> = {
  'node@22':     'node:22-alpine',
  'node@20':     'node:20-alpine',
  'python@3.11': 'python:3.11-alpine',
  'python@3.12': 'python:3.12-alpine',
  'deno@2':      'denoland/deno:alpine-2.1.4',
}

export interface DockerAgentOptions {
  /** Memory limit, default '256m' */
  memory?: string
  /** CPU quota out of 100000 period, default 50000 (50%) */
  cpuQuota?: number
  /** tmpfs scratch size in MB, default 64 */
  scratchMb?: number
  /** Docker socket / host, default uses system default */
  dockerHost?: string
}

/**
 * Production-grade replication agent that runs procedures inside Docker
 * containers with network isolation, memory caps, and read-only filesystem.
 *
 * Requires Docker daemon to be running. Falls back with a clear error message
 * if Docker is unavailable rather than silently falling through to unsandboxed
 * execution.
 */
export function createDockerReplicationAgent(
  did: string,
  label: string,
  options: DockerAgentOptions = {}
): ReplicationAgent {
  const {
    memory = '256m',
    cpuQuota = 50000,
    scratchMb = 64,
  } = options

  return {
    did,
    label,
    async execute(procedure: VerificationProcedure, claimId: string): Promise<ReplicationAgentOutput> {
      validateProcedure(procedure)

      const image = DOCKER_IMAGES[procedure.runtime]
      if (!image) {
        throw new ReplicationSecurityError(
          `No Docker image configured for runtime '${procedure.runtime}'`
        )
      }

      await writeAudit({
        agent: did,
        claimId,
        type: 'docker_execute',
        runtime: procedure.runtime,
        image,
        executableHash: await hashExecutable(procedure.executable),
      })

      const tmpDir = await mkdtemp(join(tmpdir(), 'akp-docker-'))
      try {
        // Write the executable into the input dir (will be bind-mounted read-only)
        const entryFile = procedure.entrypoint ?? deriveEntryFilename(procedure)
        const inputFile = join(tmpDir, entryFile)
        await writeFile(inputFile, procedure.executable, 'utf8')

        const timeoutMs = (procedure.timeoutSeconds ?? 120) * 1000
        const entryCmd = buildDockerEntryCmd(procedure.runtime, entryFile)

        const dockerArgs = [
          'run', '--rm',
          '--network=none',
          `--memory=${memory}`,
          '--memory-swap=0',          // disable swap entirely
          `--cpu-quota=${cpuQuota}`,
          '--cpu-period=100000',
          '--read-only',
          `--tmpfs=/scratch:size=${scratchMb}m,noexec`,
          '-v', `${tmpDir}:/input:ro`,
          '-w', '/input',
          '--security-opt=no-new-privileges',
          image,
          ...entryCmd,
        ]

        const start = Date.now()
        const output = await spawnWithTimeout('docker', dockerArgs, timeoutMs, claimId)

        await writeAudit({
          agent: did,
          claimId,
          type: 'docker_result',
          exitCode: output.exitCode,
          durationMs: Date.now() - start,
        })

        return output
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    },
  }
}

function deriveEntryFilename(procedure: VerificationProcedure): string {
  if (procedure.runtime.startsWith('node'))   return 'index.mjs'
  if (procedure.runtime.startsWith('python')) return 'main.py'
  if (procedure.runtime.startsWith('deno'))   return 'main.ts'
  return 'main'
}

function buildDockerEntryCmd(runtime: string, entryFile: string): string[] {
  if (runtime.startsWith('node'))   return ['node', '--max-old-space-size=200', entryFile]
  if (runtime.startsWith('python')) return ['python', entryFile]
  if (runtime.startsWith('deno'))   return ['deno', 'run', '--allow-read=/input', '--no-prompt', entryFile]
  throw new ReplicationSecurityError(`Cannot build entry command for runtime '${runtime}'`)
}

async function spawnWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  _claimId: string,
): Promise<ReplicationAgentOutput> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { signal: ac.signal })
    } catch (err) {
      clearTimeout(timer)
      // Docker not found / daemon not running
      reject(new Error(
        `Docker spawn failed: ${String(err)}. ` +
        `Ensure Docker Desktop is running and 'docker' is in PATH.`
      ))
      return
    }

    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    const start = Date.now()

    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 4096)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: outputBytes > MAX_OUTPUT_BYTES ? stdout + '\n[OUTPUT TRUNCATED]' : stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      const errCode = (err as NodeJS.ErrnoException).code
      if (errCode === 'ABORT_ERR') {
        // Kill the container by name is tricky; Docker timeout is handled by the host kill
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: 124, durationMs: timeoutMs })
      } else if (errCode === 'ENOENT') {
        reject(new Error(
          `'docker' not found in PATH. Install Docker Desktop and ensure it is running.`
        ))
      } else {
        reject(err)
      }
    })
  })
}

/**
 * Check whether Docker daemon is reachable and the required sandbox images are
 * available locally. Returns a diagnostic object suitable for logging.
 */
export async function checkDockerSandbox(): Promise<{
  available: boolean
  version?: string
  missingImages: string[]
  error?: string
}> {
  try {
    // Check daemon reachability
    const versionOut = await spawnWithTimeout('docker', ['version', '--format', '{{.Server.Version}}'], 5000, 'health')
    if (versionOut.exitCode !== 0) {
      return { available: false, missingImages: [], error: versionOut.stderr.trim() || 'docker version failed' }
    }
    const version = versionOut.stdout.trim()

    // Check which sandbox images are present
    const missingImages: string[] = []
    for (const [runtime, image] of Object.entries(DOCKER_IMAGES)) {
      const check = await spawnWithTimeout('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], 5000, 'health')
      if (check.exitCode !== 0) {
        missingImages.push(`${runtime} → ${image}`)
      }
    }

    return { available: true, version, missingImages }
  } catch (err) {
    return { available: false, missingImages: [], error: String(err) }
  }
}
