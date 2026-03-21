import type { ConfidenceWeights } from './confidence.js'
import { computeConfidence, computeMaturity } from './confidence.js'
import type { KnowledgeUnit } from './ku.js'
import type { PipelineScores } from './confidence.js'

export interface CalibrationSample {
  ku: KnowledgeUnit
  pipeline: PipelineScores
  /** Ground-truth maturity label */
  trueMaturity: KnowledgeUnit['meta']['maturity']
}

export interface CalibrationResult {
  weights: ConfidenceWeights
  accuracy: number
  iterations: number
  converged: boolean
}

/**
 * Convert weights array [w_claims, w_reviews, w_sources, w_coherence, conflict_threshold]
 * to ConfidenceWeights. Normalizes the four main weights to sum to 1.
 */
function arrayToWeights(v: number[]): ConfidenceWeights {
  const [wc, wr, ws, wh, ct] = v
  const total = wc + wr + ws + wh
  const norm = total > 0 ? total : 1
  return {
    w_claims: wc / norm,
    w_reviews: wr / norm,
    w_sources: ws / norm,
    w_coherence: wh / norm,
    conflict_threshold: Math.max(0.05, Math.min(0.6, ct)),
  }
}

function weightsToArray(w: ConfidenceWeights): number[] {
  return [w.w_claims, w.w_reviews, w.w_sources, w.w_coherence, w.conflict_threshold]
}

function evaluateAccuracy(samples: CalibrationSample[], weights: ConfidenceWeights): number {
  let correct = 0
  for (const { ku, pipeline, trueMaturity } of samples) {
    const { aggregate } = computeConfidence(ku, pipeline, weights)
    const predicted = computeMaturity(aggregate, ku.reviews.length)
    if (predicted === trueMaturity) correct++
  }
  return correct / samples.length
}

/** Loss = 1 - accuracy */
function loss(samples: CalibrationSample[], v: number[]): number {
  return 1 - evaluateAccuracy(samples, arrayToWeights(v))
}

/**
 * Nelder-Mead simplex optimizer.
 * Minimizes `loss(v)` over the 5-dimensional weight space.
 */
export function nelderMead(
  fn: (v: number[]) => number,
  initial: number[],
  options: { maxIter?: number; tol?: number; alpha?: number; gamma?: number; rho?: number; sigma?: number } = {}
): { solution: number[]; value: number; iterations: number; converged: boolean } {
  const n = initial.length
  const { maxIter = 1000, tol = 1e-6, alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5 } = options

  // Build initial simplex: one vertex at initial, n more perturbed by 5%
  const simplex: number[][] = [initial.slice()]
  for (let i = 0; i < n; i++) {
    const v = initial.slice()
    v[i] = v[i] !== 0 ? v[i] * 1.05 : 0.00025
    simplex.push(v)
  }

  let values = simplex.map(v => fn(v))
  let iter = 0
  let converged = false

  while (iter < maxIter) {
    // Sort ascending by value
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
    const sorted = order.map(i => ({ v: simplex[i], f: values[i] }))

    const best = sorted[0]
    const worst = sorted[n]
    const secondWorst = sorted[n - 1]

    // Convergence check: spread of function values
    const spread = Math.abs(worst.f - best.f)
    if (spread < tol) {
      converged = true
      break
    }

    // Centroid of all but worst
    const centroid = new Array(n).fill(0) as number[]
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += sorted[i].v[j] / n
    }

    // Reflection
    const reflected = centroid.map((c, j) => c + alpha * (c - worst.v[j]))
    const fr = fn(reflected)

    if (fr < best.f) {
      // Expansion
      const expanded = centroid.map((c, j) => c + gamma * (reflected[j] - c))
      const fe = fn(expanded)
      if (fe < fr) {
        simplex[order[n]] = expanded
        values[order[n]] = fe
      } else {
        simplex[order[n]] = reflected
        values[order[n]] = fr
      }
    } else if (fr < secondWorst.f) {
      simplex[order[n]] = reflected
      values[order[n]] = fr
    } else {
      // Contraction
      const contracted = centroid.map((c, j) => c + rho * (worst.v[j] - c))
      const fc = fn(contracted)
      if (fc < worst.f) {
        simplex[order[n]] = contracted
        values[order[n]] = fc
      } else {
        // Shrink
        for (let i = 1; i <= n; i++) {
          simplex[order[i]] = best.v.map((b, j) => b + sigma * (simplex[order[i]][j] - b))
          values[order[i]] = fn(simplex[order[i]])
        }
      }
    }

    iter++
  }

  // Return best
  const bestIdx = values.indexOf(Math.min(...values))
  return { solution: simplex[bestIdx], value: values[bestIdx], iterations: iter, converged }
}

/**
 * Calibrate confidence weights to maximize maturity-label accuracy on a labeled sample set.
 */
export function calibrateWeights(
  samples: CalibrationSample[],
  initial: ConfidenceWeights,
  options: { maxIter?: number; tol?: number } = {}
): CalibrationResult {
  if (samples.length === 0) throw new Error('calibrateWeights: samples array is empty')

  const fn = (v: number[]) => loss(samples, v)
  const { solution, iterations, converged } = nelderMead(fn, weightsToArray(initial), options)

  const weights = arrayToWeights(solution)
  const accuracy = evaluateAccuracy(samples, weights)

  return { weights, accuracy, iterations, converged }
}
