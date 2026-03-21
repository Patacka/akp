import React, { useEffect, useState } from 'react'
import { rpc } from '../rpc'
import type { AgentRep } from '../types'

function truncateDid(did: string): string {
  if (did.length <= 20) return did
  return did.slice(0, 20) + '...'
}

function StatusBadge({ agent }: { agent: AgentRep }) {
  if (agent.blacklisted) return <span className="badge badge-blacklisted">Blacklisted</span>
  if (agent.graduated) return <span className="badge badge-graduated">Graduated</span>
  return <span className="badge badge-new">New</span>
}

export default function Reputation() {
  const [agents, setAgents] = useState<AgentRep[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    rpc<AgentRep[]>('akp.reputation.list')
      .then((result) => {
        // Sort by reputation descending
        const sorted = [...result].sort((a, b) => b.reputation - a.reputation)
        setAgents(sorted)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const totalAgents = agents.length
  const graduatedCount = agents.filter((a) => a.graduated).length
  const blacklistedCount = agents.filter((a) => a.blacklisted).length

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Agent Reputation</h1>
        <p className="page-subtitle">Leaderboard of all registered agents ranked by reputation score</p>
      </div>

      {/* Summary stats */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-value">
            {loading ? <span className="spinner spinner-sm" /> : totalAgents}
          </div>
          <div className="stat-label">Total Agents</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--success)' }}>
            {loading ? <span className="spinner spinner-sm" /> : graduatedCount}
          </div>
          <div className="stat-label">Graduated</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--danger)' }}>
            {loading ? <span className="spinner spinner-sm" /> : blacklistedCount}
          </div>
          <div className="stat-label">Blacklisted</div>
        </div>
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <span className="error-banner-icon">!</span>
          <span>
            {error.includes('not found') || error.includes('method')
              ? 'The reputation list endpoint (akp.reputation.list) is not yet available on this server.'
              : error}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Leaderboard</span>
          {!loading && agents.length > 0 && (
            <span className="badge badge-proposed">{agents.length} agents</span>
          )}
        </div>

        {loading ? (
          <div className="loading-state">
            <span className="spinner" />
            <span>Loading reputation data...</span>
          </div>
        ) : agents.length === 0 && !error ? (
          <div className="empty-state">
            <div className="empty-state-icon">★</div>
            <div className="empty-state-title">No agents registered yet</div>
            <div className="empty-state-desc">
              Agents appear here after submitting their first review.
            </div>
          </div>
        ) : agents.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>DID</th>
                  <th>Reputation</th>
                  <th>Weight</th>
                  <th>Reviews</th>
                  <th>Status</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent, i) => {
                  const rank = i + 1
                  return (
                    <tr key={agent.did}>
                      <td>
                        <span className={`rank-number${rank <= 3 ? ` rank-${rank}` : ''}`}>
                          {rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank}
                        </span>
                      </td>
                      <td>
                        <span className="did-truncated" title={agent.did}>
                          {truncateDid(agent.did)}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, color: agent.reputation > 0 ? 'var(--success)' : agent.reputation < 0 ? 'var(--danger)' : 'var(--muted)' }}>
                          {agent.reputation > 0 ? '+' : ''}{agent.reputation}
                        </span>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {(agent.effectiveWeight * 100).toFixed(2)}%
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {agent.reviewCount}
                      </td>
                      <td>
                        <StatusBadge agent={agent} />
                      </td>
                      <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {agent.lastActivity
                          ? new Date(agent.lastActivity).toLocaleDateString()
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* How reputation works */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <span className="card-title">How Reputation Works</span>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
            <div className="gov-param-item">
              <div className="gov-param-key">Zero Trust Entry</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                New DIDs start with reputation 0 and weight 0. Reviews have no effect on confidence until graduation.
              </div>
            </div>
            <div className="gov-param-item">
              <div className="gov-param-key">Graduation</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                Agents graduate once their reputation reaches the threshold (set by governance). Graduated agents receive weight 1.0.
              </div>
            </div>
            <div className="gov-param-item">
              <div className="gov-param-key">Commit-Reveal</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                Static claims use commit-reveal to prevent vote copying. Correct reveals award +1 reputation; incorrect seeds cost -10.
              </div>
            </div>
            <div className="gov-param-item">
              <div className="gov-param-key">Blacklisting</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                Agents can be blacklisted via governance proposals. Blacklisted agents cannot submit new commits.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
