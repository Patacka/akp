import React, { useEffect, useState } from 'react'
import { rpc } from '../rpc'
import type { Stats, KU } from '../types'
import { MaturityBadge, ConfidenceBar, Tag } from '../components/Badges'

function truncateDid(did: string): string {
  if (did.length <= 20) return did
  return did.slice(0, 20) + '...'
}

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [recentKUs, setRecentKUs] = useState<KU[]>([])
  const [loadingStats, setLoadingStats] = useState(true)
  const [loadingKUs, setLoadingKUs] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [kusError, setKusError] = useState<string | null>(null)

  useEffect(() => {
    setLoadingStats(true)
    rpc<Stats>('akp.stats')
      .then((s) => {
        setStats(s)
        setStatsError(null)
      })
      .catch((err: Error) => {
        // stats endpoint may not exist yet, gracefully handle
        setStatsError(err.message)
      })
      .finally(() => setLoadingStats(false))

    setLoadingKUs(true)
    rpc<KU[]>('akp.ku.query', { limit: 5 })
      .then((kus) => {
        setRecentKUs(kus)
        setKusError(null)
      })
      .catch((err: Error) => setKusError(err.message))
      .finally(() => setLoadingKUs(false))
  }, [])

  const maturityOrder: Array<'draft' | 'proposed' | 'validated' | 'stable'> = [
    'draft', 'proposed', 'validated', 'stable',
  ]

  const maxMaturityCount = stats
    ? Math.max(1, ...Object.values(stats.maturityDistribution))
    : 1

  const topDomains = stats
    ? Object.entries(stats.domainDistribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    : []

  const avgConfidence = recentKUs.length > 0
    ? recentKUs.reduce((acc, ku) => acc + (ku.meta.confidence?.aggregate ?? 0), 0) / recentKUs.length
    : null

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Overview of the Agent Knowledge Protocol node</p>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">
            {loadingStats ? <span className="spinner spinner-sm" /> : (stats?.totalKUs ?? 'n/a')}
          </div>
          <div className="stat-label">Total Knowledge Units</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {loadingStats ? <span className="spinner spinner-sm" /> : (stats?.totalAgents ?? 'n/a')}
          </div>
          <div className="stat-label">Total Agents</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {loadingKUs
              ? <span className="spinner spinner-sm" />
              : avgConfidence != null
                ? `${Math.round(avgConfidence * 100)}%`
                : 'n/a'
            }
          </div>
          <div className="stat-label">Avg Confidence (recent)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {loadingStats
              ? <span className="spinner spinner-sm" />
              : stats != null
                ? (stats.maturityDistribution?.['stable'] ?? 0) + (stats.maturityDistribution?.['validated'] ?? 0)
                : 'n/a'
            }
          </div>
          <div className="stat-label">Validated + Stable KUs</div>
        </div>
      </div>

      {statsError && (
        <div className="error-banner" style={{ marginBottom: 20 }}>
          <span className="error-banner-icon">!</span>
          <span>Stats unavailable: {statsError}</span>
        </div>
      )}

      {/* Two-column layout for distributions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* Maturity Distribution */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Maturity Distribution</span>
          </div>
          <div className="card-body">
            {loadingStats ? (
              <div className="loading-state">
                <span className="spinner" />
                <span>Loading...</span>
              </div>
            ) : stats ? (
              <div className="dist-chart">
                {maturityOrder.map((m) => {
                  const count = stats.maturityDistribution[m] ?? 0
                  const pct = (count / maxMaturityCount) * 100
                  return (
                    <div className="dist-row" key={m}>
                      <span className="dist-label">{m}</span>
                      <div className="dist-track">
                        <div className={`dist-fill ${m}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="dist-count">{count}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-state-desc">No distribution data</div>
              </div>
            )}
          </div>
        </div>

        {/* Domain Distribution */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Top Domains</span>
          </div>
          <div className="card-body">
            {loadingStats ? (
              <div className="loading-state">
                <span className="spinner" />
                <span>Loading...</span>
              </div>
            ) : topDomains.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {topDomains.map(([domain, count]) => (
                  <div key={domain} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{domain}</span>
                    <span className="badge badge-proposed">{count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-state-desc">No domains yet</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Knowledge Units */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Recent Knowledge Units</span>
          <a href="#/knowledge" className="btn btn-sm">View all</a>
        </div>
        {loadingKUs ? (
          <div className="loading-state">
            <span className="spinner" />
            <span>Loading knowledge units...</span>
          </div>
        ) : kusError ? (
          <div style={{ padding: 16 }}>
            <div className="error-banner">
              <span className="error-banner-icon">!</span>
              <span>{kusError}</span>
            </div>
          </div>
        ) : recentKUs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <div className="empty-state-title">No knowledge units yet</div>
            <div className="empty-state-desc">
              Create your first knowledge unit to get started.
            </div>
            <a href="#/create" className="btn btn-primary btn-sm" style={{ marginTop: 8 }}>
              Create KU
            </a>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Domain</th>
                  <th>Maturity</th>
                  <th>Confidence</th>
                  <th>Tags</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentKUs.map((ku) => {
                  const title = ku.meta.title['en'] ?? Object.values(ku.meta.title)[0] ?? ku.id
                  return (
                    <tr
                      key={ku.id}
                      className="clickable"
                      onClick={() => { window.location.hash = `#/knowledge/${ku.id}` }}
                    >
                      <td style={{ maxWidth: 240 }}>
                        <span style={{ fontWeight: 500 }}>{title}</span>
                      </td>
                      <td>
                        <span className="domain-badge">{ku.meta.domain}</span>
                      </td>
                      <td>
                        <MaturityBadge maturity={ku.meta.maturity} />
                      </td>
                      <td>
                        <ConfidenceBar value={ku.meta.confidence?.aggregate ?? 0} />
                      </td>
                      <td>
                        <div className="tag-list">
                          {(ku.meta.tags ?? []).slice(0, 3).map((t) => (
                            <Tag key={t} text={t} />
                          ))}
                        </div>
                      </td>
                      <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {new Date(ku.meta.created).toLocaleDateString()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
