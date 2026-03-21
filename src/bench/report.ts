import { benchmarkDeltaSizes } from './delta-sizes.js'
import { simulateSybilAttack } from './sybil-sim.js'
import { benchmarkGraphScale } from './graph-scale.js'
import { benchmarkMergeCost } from './merge-cost.js'
import { benchmarkConfidenceSweep } from './confidence-sweep.js'

export default async function runBenchmarks() {
  console.log('=== AKP Benchmark Suite ===\n')

  // 1. Delta sizes
  console.log('## 1. Automerge Delta Sizes (1,000 samples each)\n')
  const runId = Date.now().toString()
  const deltaResults = await benchmarkDeltaSizes(1000, `C:/Temp/akp-bench-${runId}`)
  console.log('Operation              | Samples | Median | P95  | P99')
  console.log('-----------------------|---------|--------|------|----')
  for (const r of deltaResults) {
    console.log(
      `${r.op.padEnd(23)}| ${r.samples.toString().padStart(7)} | ${r.median.toString().padStart(6)} | ${r.p95.toString().padStart(4)} | ${r.p99}`
    )
  }
  console.log('\nTarget: Median < 100 bytes for simple ops\n')

  // 2. Graph scale
  console.log('## 2. Stage 2 Graph Scale\n')
  const graphResults = await benchmarkGraphScale([100, 1000, 10000])
  console.log('Graph Size | Stage2 Median (ms) | Stage2 P95 (ms) | Contradictions')
  console.log('-----------|-------------------|-----------------|---------------')
  for (const r of graphResults) {
    console.log(
      `${r.graphSize.toString().padStart(10)} | ${r.stage2MedianMs.toString().padStart(17)} | ${r.stage2P95Ms.toString().padStart(15)} | ${r.contradictionsFound}`
    )
  }
  console.log('\nTarget: P95 < 50ms at 10k KUs\n')

  // 3. CRDT merge cost
  console.log('## 3. CRDT Merge Cost\n')
  const mergeResults = await benchmarkMergeCost([1, 2, 5, 10, 50])
  console.log('Writers | Changes/Writer | Total (ms) | Per-op (ms) | Doc (bytes)')
  console.log('--------|----------------|------------|-------------|------------')
  for (const r of mergeResults) {
    console.log(
      `${r.concurrentWriters.toString().padStart(7)} | ${r.changesPerWriter.toString().padStart(14)} | ${r.totalMergeMs.toString().padStart(10)} | ${r.perOpMedianMs.toString().padStart(11)} | ${r.finalDocBytes}`
    )
  }
  console.log('\nTarget: P95 < 100ms per op with 10 writers\n')

  // 4. Confidence sweep
  console.log('## 4. Confidence Threshold Sensitivity\n')
  const sweepResults = await benchmarkConfidenceSweep(100)
  const maxAcc = Math.max(...sweepResults.map(r => r.accuracy))
  const minAcc = Math.min(...sweepResults.map(r => r.accuracy))
  const avgAcc = sweepResults.reduce((s, r) => s + r.accuracy, 0) / sweepResults.length
  const best = sweepResults.sort((a, b) => b.accuracy - a.accuracy)[0]
  console.log(`Parameter combinations tested: ${sweepResults.length}`)
  console.log(`Accuracy range: ${(minAcc * 100).toFixed(1)}% – ${(maxAcc * 100).toFixed(1)}%`)
  console.log(`Average accuracy: ${(avgAcc * 100).toFixed(1)}%`)
  console.log(`Best weights: w_claims=${best.weights.w_claims.toFixed(2)}, w_reviews=${best.weights.w_reviews.toFixed(2)}, w_sources=${best.weights.w_sources.toFixed(2)}, conflict_threshold=${best.weights.conflict_threshold}`)
  console.log(`Best accuracy: ${(best.accuracy * 100).toFixed(1)}%`)
  console.log('\nTarget: Maturity accuracy > 80% across reasonable parameter ranges\n')

  // 5. Sybil resistance
  console.log('## 5. Sybil Resistance Simulation\n')
  console.log('Sybil Count | Honest Wins? | Score (w/ cap) | Score (no cap)')
  console.log('------------|--------------|----------------|---------------')
  for (const sybilCount of [10, 20, 50, 100]) {
    const trials = Array.from({ length: 10 }, () => simulateSybilAttack(5, sybilCount))
    const avgScore = trials.reduce((s, t) => s + t.finalScore, 0) / trials.length
    const avgNoCapScore = trials.reduce((s, t) => s + t.withoutCap, 0) / trials.length
    const honestWins = trials.filter(t => t.honestWins).length
    console.log(
      `${sybilCount.toString().padStart(11)} | ${(honestWins >= 7 ? 'YES' : 'NO ').padEnd(12)} | ${avgScore.toFixed(3).padStart(14)} | ${avgNoCapScore.toFixed(3)}`
    )
  }
  console.log('\nTarget: Honest side wins at 50 Sybil agents\n')

  console.log('=== Benchmark Complete ===')
}

// Run if called directly
runBenchmarks().catch(console.error)
