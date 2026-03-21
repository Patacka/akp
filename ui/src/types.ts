export interface KU {
  id: string
  version: number
  meta: {
    domain: string
    title: Record<string, string>
    summary?: string
    maturity: 'draft' | 'proposed' | 'validated' | 'stable'
    confidence: { aggregate: number }
    tags: string[]
    created: string
    modified: string
  }
  narrative: { summary: string; body?: string }
  structured: { claims: Claim[] }
  provenance: ProvenanceRecord[]
  reviews: Review[]
}

export interface Claim {
  id: string
  type: 'factual' | 'quantitative' | 'temporal'
  subject: string
  predicate: string
  object: unknown
  confidence: number
}

export interface Review {
  id: string
  reviewerDid: string
  reviewerType: 'agent' | 'human'
  timestamp: string
  verdict: 'confirmed' | 'amended' | 'disputed' | 'rejected'
  weight: number
  comment?: string
}

export interface ProvenanceRecord {
  id: string
  did: string
  type: 'agent' | 'human'
  method: string
  timestamp: string
  sources: Array<{ id: string; type: string; value: string }>
}

export interface Proposal {
  id: string
  type: string
  proposerDid: string
  title: string
  description: string
  status: 'open' | 'accepted' | 'rejected' | 'expired'
  createdAt: string
  expiresAt: string
}

export interface AgentRep {
  did: string
  reputation: number
  effectiveWeight: number
  reviewCount: number
  blacklisted: boolean
  graduated: boolean
  graduatedAt: string | null
  firstSeenAt: string
  lastActivity: string
}

export interface Stats {
  totalKUs: number
  totalAgents: number
  maturityDistribution: Record<string, number>
  domainDistribution: Record<string, number>
}
