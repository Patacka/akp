import React, { useEffect, useState } from 'react'
import { rpc } from '../rpc'
import type { Proposal } from '../types'

interface GovernanceState {
  parameters?: Record<string, unknown>
  [key: string]: unknown
}

interface VoteFormState {
  proposalId: string
  choice: 'accept' | 'reject'
  voterDid: string
  loading: boolean
  error: string | null
  success: string | null
}

function truncateDid(did: string): string {
  if (did.length <= 20) return did
  return did.slice(0, 20) + '...'
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

export default function Governance() {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [govState, setGovState] = useState<GovernanceState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [expandedVote, setExpandedVote] = useState<string | null>(null)
  const [voteForms, setVoteForms] = useState<Record<string, VoteFormState>>({})

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true)
      setError(null)
      try {
        const [propsResult, stateResult] = await Promise.allSettled([
          rpc<Proposal[]>('akp.governance.proposals', {}),
          rpc<GovernanceState>('akp.governance.state'),
        ])

        if (propsResult.status === 'fulfilled') {
          setProposals(propsResult.value)
        } else {
          setError((propsResult.reason as Error).message)
        }

        if (stateResult.status === 'fulfilled') {
          setGovState(stateResult.value)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchAll()
  }, [])

  function toggleVotePanel(proposalId: string) {
    if (expandedVote === proposalId) {
      setExpandedVote(null)
    } else {
      setExpandedVote(proposalId)
      if (!voteForms[proposalId]) {
        setVoteForms((prev) => ({
          ...prev,
          [proposalId]: {
            proposalId,
            choice: 'accept',
            voterDid: localStorage.getItem('akp_reviewer_did') ?? '',
            loading: false,
            error: null,
            success: null,
          },
        }))
      }
    }
  }

  function updateVoteForm(proposalId: string, field: keyof VoteFormState, value: unknown) {
    setVoteForms((prev) => ({
      ...prev,
      [proposalId]: { ...prev[proposalId], [field]: value },
    }))
  }

  async function handleCastVote(e: React.FormEvent, proposalId: string) {
    e.preventDefault()
    const form = voteForms[proposalId]
    if (!form) return

    if (!form.voterDid.trim()) {
      updateVoteForm(proposalId, 'error', 'Voter DID is required.')
      return
    }

    updateVoteForm(proposalId, 'loading', true)
    updateVoteForm(proposalId, 'error', null)
    updateVoteForm(proposalId, 'success', null)

    // Save DID
    localStorage.setItem('akp_reviewer_did', form.voterDid.trim())

    // Generate a vote id
    const voteId = crypto.randomUUID()

    try {
      await rpc('akp.governance.vote', {
        id: voteId,
        proposalId,
        voterDid: form.voterDid.trim(),
        choice: form.choice,
        // signature placeholder — real impl needs Ed25519 signing
        signature: '0'.repeat(128),
      })
      updateVoteForm(proposalId, 'success', `Vote cast: ${form.choice}`)
      updateVoteForm(proposalId, 'loading', false)
    } catch (err) {
      updateVoteForm(proposalId, 'error', (err as Error).message)
      updateVoteForm(proposalId, 'loading', false)
    }
  }

  // Extract governance parameters for display
  const govParams: Record<string, unknown> = govState?.parameters as Record<string, unknown>
    ?? (govState && typeof govState === 'object' ? govState : {})

  const paramEntries = Object.entries(govParams).filter(
    ([k]) => !['proposals', 'votes'].includes(k)
  )

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Governance</h1>
        <p className="page-subtitle">Proposals, voting, and protocol parameters</p>
      </div>

      {/* Governance Parameters */}
      {paramEntries.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <span className="card-title">Current Parameters</span>
          </div>
          <div className="card-body">
            <div className="gov-params-grid">
              {paramEntries.map(([key, value]) => (
                <div className="gov-param-item" key={key}>
                  <div className="gov-param-key">{key.replace(/_/g, ' ')}</div>
                  <div className="gov-param-value">
                    {typeof value === 'number'
                      ? value < 1 ? `${(value * 100).toFixed(0)}%` : value
                      : typeof value === 'boolean'
                        ? value ? 'Yes' : 'No'
                        : String(value)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Proposals */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Proposals</span>
          <span className="badge badge-proposed">{proposals.length}</span>
        </div>

        {loading ? (
          <div className="loading-state">
            <span className="spinner" />
            <span>Loading proposals...</span>
          </div>
        ) : error ? (
          <div style={{ padding: 16 }}>
            <div className="error-banner">
              <span className="error-banner-icon">!</span>
              <span>{error}</span>
            </div>
          </div>
        ) : proposals.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚖</div>
            <div className="empty-state-title">No proposals yet</div>
            <div className="empty-state-desc">
              Governance proposals will appear here once submitted.
            </div>
          </div>
        ) : (
          <div>
            {proposals.map((proposal) => {
              const isOpen = proposal.status === 'open'
              const voteForm = voteForms[proposal.id]
              const isExpanded = expandedVote === proposal.id

              return (
                <div
                  key={proposal.id}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    padding: '16px 20px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>
                          {proposal.title}
                        </span>
                        <StatusBadge status={proposal.status} />
                        <span className="badge badge-draft" style={{ textTransform: 'none' }}>
                          {proposal.type}
                        </span>
                      </div>

                      {proposal.description && (
                        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.6 }}>
                          {proposal.description}
                        </p>
                      )}

                      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
                        <span>
                          Proposer:{' '}
                          <span className="did-truncated" title={proposal.proposerDid}>
                            {truncateDid(proposal.proposerDid)}
                          </span>
                        </span>
                        <span>
                          Expires: {new Date(proposal.expiresAt).toLocaleDateString()}
                        </span>
                        <span>
                          Created: {new Date(proposal.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    {isOpen && (
                      <button
                        className={`btn btn-sm${isExpanded ? '' : ' btn-primary'}`}
                        onClick={() => toggleVotePanel(proposal.id)}
                        style={{ flexShrink: 0 }}
                      >
                        {isExpanded ? 'Cancel' : 'Vote'}
                      </button>
                    )}
                  </div>

                  {/* Inline vote form */}
                  {isExpanded && voteForm && (
                    <div className="vote-panel">
                      <form onSubmit={(e) => handleCastVote(e, proposal.id)}>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text)' }}>
                          Cast Your Vote
                        </div>

                        <div className="form-row">
                          <div className="form-group">
                            <label className="form-label">Choice</label>
                            <select
                              className="form-select"
                              value={voteForm.choice}
                              onChange={(e) => updateVoteForm(proposal.id, 'choice', e.target.value)}
                            >
                              <option value="accept">Accept</option>
                              <option value="reject">Reject</option>
                            </select>
                          </div>

                          <div className="form-group" style={{ gridColumn: 'span 2' }}>
                            <label className="form-label">
                              Voter DID <span className="required">*</span>
                            </label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="did:key:..."
                              value={voteForm.voterDid}
                              onChange={(e) => updateVoteForm(proposal.id, 'voterDid', e.target.value)}
                            />
                          </div>
                        </div>

                        {voteForm.error && (
                          <div className="error-banner" style={{ marginBottom: 10 }}>
                            <span className="error-banner-icon">!</span>
                            <span>{voteForm.error}</span>
                          </div>
                        )}
                        {voteForm.success && (
                          <div className="success-banner" style={{ marginBottom: 10 }}>
                            <span>✓</span>
                            <span>{voteForm.success}</span>
                          </div>
                        )}

                        <button
                          type="submit"
                          className="btn btn-primary btn-sm"
                          disabled={voteForm.loading}
                        >
                          {voteForm.loading ? (
                            <>
                              <span className="spinner spinner-sm" />
                              Casting...
                            </>
                          ) : 'Cast Vote'}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
