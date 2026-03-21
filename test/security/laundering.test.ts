import { describe, it, expect } from 'vitest'
import { detectConfidenceLaundering } from '../../src/core/confidence.js'

describe('Confidence laundering prevention', () => {
  it('detects circular citation chains', () => {
    const kuA = 'ku-a'
    const kuB = 'ku-b'

    // B is a descendant of A
    const lineage = new Map([
      [kuB, [kuA]]  // B's ancestors include A
    ])

    // A tries to cite B (its own descendant)
    const { isLaundering, suspiciousRefs } = detectConfidenceLaundering(kuA, [kuB], lineage)
    expect(isLaundering).toBe(true)
    expect(suspiciousRefs).toContain(kuB)
  })

  it('allows legitimate cross-domain citations', () => {
    const lineage = new Map<string, string[]>()
    const { isLaundering } = detectConfidenceLaundering('ku-x', ['ku-y', 'ku-z'], lineage)
    expect(isLaundering).toBe(false)
  })
})
