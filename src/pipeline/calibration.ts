/**
 * calibration.ts — Run a fixed calibration battery against an LLM agent and
 * return the fraction of claims answered correctly.
 *
 * Used to gate LLM participation in Stage 3 corroboration: if accuracy is below
 * minCalibrationAccuracy governance parameter, the LLM's verdicts are not counted.
 *
 * The battery contains 20 unambiguous factual claims split evenly between
 * confirmed and disputed ground truth. Claims are chosen to be:
 *   - Unambiguous (no edge cases)
 *   - Stable (not version-dependent)
 *   - Diverse (science, history, math, common misconceptions)
 */

import type { LLMAgent } from './stage3.js'

export interface CalibrationClaim {
  id: string
  statement: string
  expectedVerdict: 'confirmed' | 'disputed'
  reasoning: string   // why this is the correct verdict
}

export const CALIBRATION_BATTERY: CalibrationClaim[] = [
  // --- True claims ---
  { id: 'c01', statement: 'The speed of light in a vacuum is approximately 299,792,458 metres per second.', expectedVerdict: 'confirmed', reasoning: 'Exact SI definition' },
  { id: 'c02', statement: 'Water freezes at 0 degrees Celsius at standard atmospheric pressure.', expectedVerdict: 'confirmed', reasoning: 'Standard thermodynamic fact' },
  { id: 'c03', statement: 'The double helix structure of DNA was described by Watson and Crick in 1953.', expectedVerdict: 'confirmed', reasoning: 'Historical fact, Nobel Prize 1962' },
  { id: 'c04', statement: 'World War II ended in 1945.', expectedVerdict: 'confirmed', reasoning: 'VE Day May 1945, VJ Day Sept 1945' },
  { id: 'c05', statement: 'The Pythagorean theorem states that in a right triangle, a² + b² = c² where c is the hypotenuse.', expectedVerdict: 'confirmed', reasoning: 'Fundamental geometry theorem' },
  { id: 'c06', statement: 'The first Apollo moon landing occurred in July 1969.', expectedVerdict: 'confirmed', reasoning: 'Apollo 11, July 20 1969' },
  { id: 'c07', statement: 'Linux was created by Linus Torvalds in 1991.', expectedVerdict: 'confirmed', reasoning: 'First announcement August 1991' },
  { id: 'c08', statement: 'The Earth orbits the Sun, not the other way around.', expectedVerdict: 'confirmed', reasoning: 'Heliocentric model' },
  { id: 'c09', statement: 'Antibiotics are ineffective against viral infections such as the common cold.', expectedVerdict: 'confirmed', reasoning: 'Antibiotics target bacteria, not viruses' },
  { id: 'c10', statement: 'The Great Fire of London occurred in 1666.', expectedVerdict: 'confirmed', reasoning: 'September 2–6, 1666' },
  // --- False claims / common misconceptions ---
  { id: 'c11', statement: 'The Great Wall of China is clearly visible from space with the naked eye.', expectedVerdict: 'disputed', reasoning: 'Too narrow (~9m wide) to be seen unaided from orbit; myth debunked' },
  { id: 'c12', statement: 'Diamonds are formed from compressed coal.', expectedVerdict: 'disputed', reasoning: 'Diamonds form from pure carbon deep in the mantle; coal is surface material' },
  { id: 'c13', statement: 'Humans use only about 10 percent of their brains.', expectedVerdict: 'disputed', reasoning: 'Neuroscience consistently shows the entire brain is active across tasks' },
  { id: 'c14', statement: 'Glass is a slow-flowing liquid that thickens over centuries.', expectedVerdict: 'disputed', reasoning: 'Glass is an amorphous solid; old-glass thickness variation is from manufacturing' },
  { id: 'c15', statement: 'Lightning never strikes the same place twice.', expectedVerdict: 'disputed', reasoning: 'Tall structures like the Empire State Building are struck many times per year' },
  { id: 'c16', statement: 'Napoleon Bonaparte was unusually short for his era, standing around 5 feet 2 inches.', expectedVerdict: 'disputed', reasoning: 'He was 5\'7" (170 cm), average for a Frenchman; confusion from French/English inch sizes' },
  { id: 'c17', statement: 'Humans evolved directly from chimpanzees.', expectedVerdict: 'disputed', reasoning: 'Humans and chimpanzees share a common ancestor; neither descended from the other' },
  { id: 'c18', statement: 'Goldfish have a memory span of only three seconds.', expectedVerdict: 'disputed', reasoning: 'Studies show goldfish can remember things for months' },
  { id: 'c19', statement: 'The tongue has distinct regions dedicated exclusively to each taste (sweet, sour, salty, bitter).', expectedVerdict: 'disputed', reasoning: 'Taste map myth; all taste receptors appear across the tongue' },
  { id: 'c20', statement: 'Blood in human veins is blue and turns red only when exposed to oxygen.', expectedVerdict: 'disputed', reasoning: 'Deoxygenated blood is dark red, not blue; veins appear blue due to light absorption through skin' },
]

export interface CalibrationResult {
  modelId: string
  totalClaims: number
  correctCount: number
  accuracy: number
  passesThreshold: boolean
  threshold: number
  perClaim: Array<{
    id: string
    expected: string
    got: string
    correct: boolean
    latencyMs: number
  }>
}

const SYSTEM_PROMPT = `You are a fact-checking assistant. Evaluate whether the given claim is factually correct.
Respond ONLY with valid JSON: {"verdict":"confirmed"|"disputed","confidence":<float 0-1>,"reasoning":"<one sentence>"}`

export async function runCalibration(
  agent: LLMAgent,
  threshold = 0.80,
): Promise<CalibrationResult> {
  const perClaim: CalibrationResult['perClaim'] = []
  let correct = 0

  for (const claim of CALIBRATION_BATTERY) {
    const start = Date.now()
    let verdict = 'unknown'
    try {
      const raw = await agent.call(
        SYSTEM_PROMPT,
        `Claim: "${claim.statement}"\n\nIs this claim factually correct?`
      )
      const parsed = JSON.parse(raw) as { verdict?: string }
      verdict = parsed.verdict ?? 'unknown'
    } catch {
      verdict = 'error'
    }
    const latencyMs = Date.now() - start
    const isCorrect = verdict === claim.expectedVerdict
    if (isCorrect) correct++
    perClaim.push({ id: claim.id, expected: claim.expectedVerdict, got: verdict, correct: isCorrect, latencyMs })
  }

  const accuracy = correct / CALIBRATION_BATTERY.length
  return {
    modelId: agent.model,
    totalClaims: CALIBRATION_BATTERY.length,
    correctCount: correct,
    accuracy,
    passesThreshold: accuracy >= threshold,
    threshold,
    perClaim,
  }
}
