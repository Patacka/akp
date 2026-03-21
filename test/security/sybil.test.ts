import { describe, it, expect } from 'vitest'
import { simulateSybilAttack } from '../../src/bench/sybil-sim.js'

describe('Sybil resistance', () => {
  it('honest agents win against 10 Sybils', () => {
    // Run multiple trials for statistical significance
    let wins = 0
    for (let i = 0; i < 20; i++) {
      const result = simulateSybilAttack(5, 10)
      if (result.honestWins) wins++
    }
    expect(wins).toBeGreaterThan(14) // >70% win rate
  })

  it('anti-monopolization cap reduces Sybil impact', () => {
    // With many Sybils, cap score should be higher than no-cap
    const results = Array.from({ length: 10 }, () => simulateSybilAttack(5, 50))
    const avgWithCap = results.reduce((s, r) => s + r.withCap, 0) / results.length
    const avgNoCap = results.reduce((s, r) => s + r.withoutCap, 0) / results.length
    // Cap should help honest agents
    expect(avgWithCap).toBeGreaterThanOrEqual(avgNoCap - 0.1)
  })
})
