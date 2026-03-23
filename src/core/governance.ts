/**
 * governance.ts — Decentralized parameter governance for AKP.
 *
 * Agents submit signed proposals to change protocol parameters, rules, or
 * KU maturity overrides. Each eligible DID casts one signed vote. The engine
 * tallies votes when quorum + threshold are both met, then emits an outcome.
 *
 * Proposal types
 * ─────────────
 *  parameter_change  — update a numeric/boolean field in GovernanceParameters
 *  rule_change       — add / remove / replace a ConsilienceRule
 *  maturity_override — promote or demote a KU's maturity
 *  agent_flag        — flag an agent DID as malicious (suspended + blacklisted)
 *
 * Thresholds (configurable via governance itself)
 * ─────────────────────────────────────────────
 *  parameter_change  : quorum 5,  >50%,  TTL 7 d
 *  rule_change       : quorum 7,  >67%,  TTL 14 d
 *  maturity_override/promote: quorum 3, >50%, TTL 3 d
 *  maturity_override/demote : quorum 5, >67%, TTL 7 d
 *  agent_flag        : quorum 5,  >67%,  TTL 7 d
 */

import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { signBytes, verifyBytes } from './identity.js'

// ── Payload schemas ───────────────────────────────────────────────────────────

export const ParameterChangePayloadSchema = z.object({
  paramPath: z.string().min(1),   // dot-path: "weights.w_claims"
  oldValue: z.unknown(),
  newValue: z.unknown(),
})

export const RuleChangePayloadSchema = z.object({
  action: z.enum(['add', 'remove', 'replace']),
  ruleId: z.string().min(1),
  /** Serialised ConsilienceRule (code + metadata). Required for add / replace. */
  ruleDefinition: z.string().optional(),
})

export const MaturityOverridePayloadSchema = z.object({
  kuId: z.string().uuid(),
  direction: z.enum(['promote', 'demote']),
  targetMaturity: z.enum(['draft', 'proposed', 'validated', 'stable']),
  reason: z.string().min(1),
})

export const AgentFlagPayloadSchema = z.object({
  targetDid: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(z.string()).default([]),  // claim IDs, KU IDs, etc.
})

// ── Proposal schema ───────────────────────────────────────────────────────────

export const ProposalSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['parameter_change', 'rule_change', 'maturity_override', 'agent_flag']),
  proposerDid: z.string().min(1),
  payload: z.union([
    ParameterChangePayloadSchema,
    RuleChangePayloadSchema,
    MaturityOverridePayloadSchema,
    AgentFlagPayloadSchema,
  ]),
  /** ISO-8601 UTC creation timestamp */
  createdAt: z.string().datetime(),
  /** ISO-8601 UTC expiry (createdAt + TTL) */
  expiresAt: z.string().datetime(),
  /** Ed25519 signature over canonicalProposalPayload() */
  signature: z.string().min(1),
  status: z.enum(['open', 'accepted', 'rejected', 'expired']).default('open'),
})

// ── Vote schema ───────────────────────────────────────────────────────────────

export const VoteSchema = z.object({
  id: z.string().uuid(),
  proposalId: z.string().uuid(),
  voterDid: z.string().min(1),
  choice: z.enum(['yes', 'no', 'abstain']),
  /** ISO-8601 UTC */
  castAt: z.string().datetime(),
  /** Voter's declared trust weight (0–1). Validated externally. */
  weight: z.number().min(0).max(1).default(1),
  /** Ed25519 signature over canonicalVotePayload() */
  signature: z.string().min(1),
})

// ── Outcome schema ────────────────────────────────────────────────────────────

export const GovernanceOutcomeSchema = z.object({
  proposalId: z.string().uuid(),
  verdict: z.enum(['accepted', 'rejected', 'expired']),
  finalizedAt: z.string().datetime(),
  yesCount: z.number().int(),
  noCount: z.number().int(),
  abstainCount: z.number().int(),
  totalWeight: z.number(),
  /** Effective threshold that was required (0–1) */
  threshold: z.number(),
  achievedRatio: z.number(),  // yes / (yes + no)  — abstains don't count
})

// ── Governance parameters ─────────────────────────────────────────────────────

export interface VotingThreshold {
  quorum: number       // minimum unique yes+no voters
  threshold: number    // yes / (yes+no) fraction required, e.g. 0.5 = >50%
  ttlDays: number
}

export const DEFAULT_THRESHOLDS: Record<string, VotingThreshold> = {
  parameter_change:        { quorum: 5, threshold: 0.5,  ttlDays: 7  },
  rule_change:             { quorum: 7, threshold: 0.67, ttlDays: 14 },
  'maturity_override/promote': { quorum: 3, threshold: 0.5,  ttlDays: 3  },
  'maturity_override/demote':  { quorum: 5, threshold: 0.67, ttlDays: 7  },
  agent_flag:              { quorum: 5, threshold: 0.67, ttlDays: 7  },
}

export const GovernanceParametersSchema = z.object({
  /** Minimum quorum for each proposal type (can diverge from defaults via governance) */
  quorums: z.record(z.number().int().min(1)).default({
    parameter_change: 5,
    rule_change: 7,
    'maturity_override/promote': 3,
    'maturity_override/demote': 5,
    agent_flag: 5,
  }),
  thresholds: z.record(z.number().min(0).max(1)).default({
    parameter_change: 0.5,
    rule_change: 0.67,
    'maturity_override/promote': 0.5,
    'maturity_override/demote': 0.67,
    agent_flag: 0.67,
  }),
  ttlDays: z.record(z.number().int().min(1)).default({
    parameter_change: 7,
    rule_change: 14,
    'maturity_override/promote': 3,
    'maturity_override/demote': 7,
    agent_flag: 7,
  }),
  /** DIDs that are suspended from voting / proposing */
  suspendedAgents: z.array(z.string()).default([]),
  /** DIDs permanently blacklisted (no recovery without supermajority vote) */
  blacklistedAgents: z.array(z.string()).default([]),
  /**
   * Minimum reputation score a DID must reach to gain governance/review weight.
   * 0 = disabled (all DIDs have full weight — dev/test only).
   */
  graduationThreshold: z.number().int().min(0).default(10),
  /**
   * Minimum reputation a proposer must hold to submit a governance proposal.
   * Checked against did_reputation.reputation. 0 = no bond required.
   */
  proposalReputationBond: z.number().int().min(0).default(10),
  /**
   * Commit-reveal: minimum minutes since first commit before the reveal window opens.
   * Both commitWindowMinutes AND commitWindowMinCount must be satisfied.
   */
  commitWindowMinutes: z.number().min(0).default(30),
  /**
   * Commit-reveal: minimum number of commits for a KU before reveals are accepted.
   */
  commitWindowMinCount: z.number().int().min(1).default(3),
  /**
   * Minimum days since first_seen_at before a DID's weight becomes nonzero.
   * 0 = disabled (dev mode). Recommended production value: 1.
   */
  minAgeDays: z.number().int().min(0).default(0),
  /**
   * Minimum number of successful reveals before a DID's weight becomes nonzero.
   * Stacks with minAgeDays — both must be satisfied.
   * 0 = disabled (dev mode). Recommended production value: 3.
   */
  minReviewCount: z.number().int().min(0).default(0),
  /**
   * Minimum fraction of calibration battery claims an LLM agent must answer correctly
   * before its Stage 3 verdicts are counted. 0.0 = disabled (any LLM participates).
   * Recommended production value: 0.80.
   */
  minCalibrationAccuracy: z.number().min(0).max(1).default(0),
})

export const GovernanceStateSchema = z.object({
  parameters: GovernanceParametersSchema,
  openProposals: z.array(ProposalSchema).default([]),
  outcomes: z.array(GovernanceOutcomeSchema).default([]),
  /** Maturity overrides indexed by KU id */
  maturityOverrides: z.record(z.enum(['draft', 'proposed', 'validated', 'stable'])).default({}),
  /** KU id → proposal id that produced the override, for audit trail */
  maturityOverrideSource: z.record(z.string()).default({}),
})

// ── TypeScript types ──────────────────────────────────────────────────────────

export type ParameterChangePayload = z.infer<typeof ParameterChangePayloadSchema>
export type RuleChangePayload = z.infer<typeof RuleChangePayloadSchema>
export type MaturityOverridePayload = z.infer<typeof MaturityOverridePayloadSchema>
export type AgentFlagPayload = z.infer<typeof AgentFlagPayloadSchema>
export type Proposal = z.infer<typeof ProposalSchema>
export type Vote = z.infer<typeof VoteSchema>
export type GovernanceOutcome = z.infer<typeof GovernanceOutcomeSchema>
export type GovernanceParameters = z.infer<typeof GovernanceParametersSchema>
export type GovernanceState = z.infer<typeof GovernanceStateSchema>

// ── Canonical serializers (deterministic JSON for signing) ────────────────────

/**
 * Returns a deterministic UTF-8 string of the proposal fields that are
 * covered by the proposer's signature. The `status` field is excluded because
 * it mutates after creation.
 */
export function canonicalProposalPayload(p: {
  id: string
  type: string
  proposerDid: string
  payload: unknown
  createdAt: string
  expiresAt: string
}): Uint8Array {
  const obj = {
    id: p.id,
    type: p.type,
    proposerDid: p.proposerDid,
    payload: p.payload,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  }
  return new TextEncoder().encode(JSON.stringify(obj, Object.keys(obj).sort()))
}

/**
 * Returns a deterministic UTF-8 string of the vote fields covered by the
 * voter's signature.
 */
export function canonicalVotePayload(v: {
  id: string
  proposalId: string
  voterDid: string
  choice: string
  castAt: string
  weight: number
}): Uint8Array {
  const obj = {
    id: v.id,
    proposalId: v.proposalId,
    voterDid: v.voterDid,
    choice: v.choice,
    castAt: v.castAt,
    weight: v.weight,
  }
  return new TextEncoder().encode(JSON.stringify(obj, Object.keys(obj).sort()))
}

// ── Signature helpers ─────────────────────────────────────────────────────────

/**
 * Sign a canonical governance payload with an Ed25519 private key (hex).
 * Returns hex-encoded signature.
 */
export const signGovernancePayload = signBytes

/**
 * Verify an Ed25519 signature over a canonical governance payload.
 * publicKeyHex: 32-byte Ed25519 public key in hex (extracted from did:key).
 */
export const verifyGovernanceSignature = verifyBytes

// ── Eligibility checks ────────────────────────────────────────────────────────

export interface EligibilityResult {
  eligible: boolean
  reason?: string
}

export function checkProposerEligibility(
  did: string,
  params: GovernanceParameters
): EligibilityResult {
  if (params.blacklistedAgents.includes(did)) {
    return { eligible: false, reason: 'DID is blacklisted' }
  }
  if (params.suspendedAgents.includes(did)) {
    return { eligible: false, reason: 'DID is suspended' }
  }
  return { eligible: true }
}

export function checkVoterEligibility(
  voterDid: string,
  proposal: Proposal,
  existingVotes: Vote[],
  params: GovernanceParameters
): EligibilityResult {
  if (params.blacklistedAgents.includes(voterDid)) {
    return { eligible: false, reason: 'DID is blacklisted' }
  }
  if (params.suspendedAgents.includes(voterDid)) {
    return { eligible: false, reason: 'DID is suspended' }
  }
  if (proposal.status !== 'open') {
    return { eligible: false, reason: `Proposal is ${proposal.status}` }
  }
  if (new Date(proposal.expiresAt) < new Date()) {
    return { eligible: false, reason: 'Proposal has expired' }
  }
  const alreadyVoted = existingVotes.some(v => v.voterDid === voterDid)
  if (alreadyVoted) {
    return { eligible: false, reason: 'Already voted on this proposal' }
  }
  return { eligible: true }
}

// ── Tally engine ──────────────────────────────────────────────────────────────

export interface TallyResult {
  verdict: 'accepted' | 'rejected' | 'pending' | 'expired'
  yesCount: number
  noCount: number
  abstainCount: number
  totalWeight: number
  achievedRatio: number
  threshold: number
  quorumMet: boolean
  thresholdMet: boolean
}

function getThresholdKey(proposal: Proposal): string {
  if (proposal.type === 'maturity_override') {
    const p = proposal.payload as MaturityOverridePayload
    return `maturity_override/${p.direction}`
  }
  return proposal.type
}

export function tallyVotes(
  proposal: Proposal,
  votes: Vote[],
  params: GovernanceParameters
): TallyResult {
  const now = new Date()
  const expired = new Date(proposal.expiresAt) < now

  const key = getThresholdKey(proposal)
  const quorum = params.quorums[key] ?? DEFAULT_THRESHOLDS[key]?.quorum ?? 5
  const threshold = params.thresholds[key] ?? DEFAULT_THRESHOLDS[key]?.threshold ?? 0.5

  let yesCount = 0
  let noCount = 0
  let abstainCount = 0
  let yesWeight = 0
  let noWeight = 0
  let totalWeight = 0

  for (const vote of votes) {
    totalWeight += vote.weight
    if (vote.choice === 'yes') {
      yesCount++
      yesWeight += vote.weight
    } else if (vote.choice === 'no') {
      noCount++
      noWeight += vote.weight
    } else {
      abstainCount++
    }
  }

  const decisiveWeight = yesWeight + noWeight
  const achievedRatio = decisiveWeight === 0 ? 0 : yesWeight / decisiveWeight
  const quorumMet = (yesCount + noCount) >= quorum
  const thresholdMet = achievedRatio > threshold

  if (expired && !quorumMet) {
    return { verdict: 'expired', yesCount, noCount, abstainCount, totalWeight, achievedRatio, threshold, quorumMet, thresholdMet }
  }

  if (quorumMet && thresholdMet) {
    return { verdict: 'accepted', yesCount, noCount, abstainCount, totalWeight, achievedRatio, threshold, quorumMet, thresholdMet }
  }

  // Defeated: quorum met but threshold not achievable (more no than needed)
  if (quorumMet && !thresholdMet) {
    const remaining = quorum - (yesCount + noCount)
    if (remaining <= 0) {
      return { verdict: 'rejected', yesCount, noCount, abstainCount, totalWeight, achievedRatio, threshold, quorumMet, thresholdMet }
    }
  }

  if (expired) {
    return { verdict: 'expired', yesCount, noCount, abstainCount, totalWeight, achievedRatio, threshold, quorumMet, thresholdMet }
  }

  return { verdict: 'pending', yesCount, noCount, abstainCount, totalWeight, achievedRatio, threshold, quorumMet, thresholdMet }
}

// ── GovernanceEngine ──────────────────────────────────────────────────────────

export class GovernanceEngine {
  constructor(private params: GovernanceParameters) {}

  tally(proposal: Proposal, votes: Vote[]): TallyResult {
    return tallyVotes(proposal, votes, this.params)
  }

  checkProposer(did: string): EligibilityResult {
    return checkProposerEligibility(did, this.params)
  }

  checkVoter(voterDid: string, proposal: Proposal, existingVotes: Vote[]): EligibilityResult {
    return checkVoterEligibility(voterDid, proposal, existingVotes, this.params)
  }

  /**
   * Apply an accepted parameter_change payload to a GovernanceParameters
   * object, returning the updated copy. Uses dot-path notation for paramPath.
   *
   * Security: prototype-pollution is blocked by rejecting dangerous segment names.
   * Critical Sybil-resistance params are immutable via parameter_change — they
   * require a rule_change proposal (higher quorum, longer TTL).
   */
  static applyParameterChange(params: GovernanceParameters, payload: ParameterChangePayload): GovernanceParameters {
    // Block prototype pollution: deny dangerous property names at any path depth
    const POISONED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
    const parts = payload.paramPath.split('.')
    for (const part of parts) {
      if (POISONED_KEYS.has(part)) {
        throw new Error(`Forbidden paramPath segment: "${part}"`)
      }
    }

    // These params underpin Sybil resistance and protocol liveness.
    // Changing them via a simple parameter_change (quorum=5, 7-day TTL) is too
    // low a bar — gate them behind rule_change (quorum=7, 67%, 14-day TTL).
    //
    // graduationThreshold / proposalReputationBond — Sybil cost floor
    // Scalar Sybil-resistance gates are locked via parameter_change; all other
    // parameters (including quorums.* and thresholds.*) can be tuned by governance.
    const IMMUTABLE_VIA_PARAMETER_CHANGE = new Set([
      'graduationThreshold',
      'proposalReputationBond',
      'commitWindowMinutes',
      'commitWindowMinCount',
      'minAgeDays',
      'minReviewCount',
      'minCalibrationAccuracy',
    ])
    if (IMMUTABLE_VIA_PARAMETER_CHANGE.has(parts[0])) {
      throw new Error(
        `"${parts[0]}" is a protected parameter — submit a rule_change proposal to modify it`
      )
    }

    const copy = JSON.parse(JSON.stringify(params)) as GovernanceParameters
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any = copy
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor[parts[i]]
      if (cursor == null || typeof cursor !== 'object') {
        throw new Error(`Invalid paramPath: ${payload.paramPath}`)
      }
    }
    cursor[parts[parts.length - 1]] = payload.newValue
    return GovernanceParametersSchema.parse(copy)
  }
}

// ── Factory functions ─────────────────────────────────────────────────────────

export function createProposal(params: {
  type: Proposal['type']
  proposerDid: string
  payload: Proposal['payload']
  signature: string
  ttlDays?: number
}): Proposal {
  const now = new Date()
  const ttlDays = params.ttlDays ?? DEFAULT_THRESHOLDS[params.type]?.ttlDays ?? 7
  const expires = new Date(now.getTime() + ttlDays * 86_400_000)
  return ProposalSchema.parse({
    id: uuidv7(),
    type: params.type,
    proposerDid: params.proposerDid,
    payload: params.payload,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    signature: params.signature,
    status: 'open',
  })
}

export function createVote(params: {
  proposalId: string
  voterDid: string
  choice: Vote['choice']
  weight?: number
  signature: string
}): Vote {
  return VoteSchema.parse({
    id: uuidv7(),
    proposalId: params.proposalId,
    voterDid: params.voterDid,
    choice: params.choice,
    castAt: new Date().toISOString(),
    weight: params.weight ?? 1,
    signature: params.signature,
  })
}

/** Build a GovernanceState with default parameters and no open proposals. */
export function createDefaultGovernanceState(): GovernanceState {
  return GovernanceStateSchema.parse({
    parameters: GovernanceParametersSchema.parse({}),
    openProposals: [],
    outcomes: [],
    maturityOverrides: {},
    maturityOverrideSource: {},
  })
}
