import React, { useEffect, useState, useCallback } from 'react'
import { rpc } from '../rpc'
import type { KU } from '../types'
import { MaturityBadge, ConfidenceBar, Tag } from '../components/Badges'

type MaturityFilter = '' | 'draft' | 'proposed' | 'validated' | 'stable'
type ConfidenceFilter = '' | '0.3' | '0.5' | '0.7' | '0.9'

export default function KUList() {
  const [kus, setKus] = useState<KU[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [domain, setDomain] = useState('')
  const [maturity, setMaturity] = useState<MaturityFilter>('')
  const [minConfidence, setMinConfidence] = useState<ConfidenceFilter>('')

  const fetchKUs = useCallback(() => {
    setLoading(true)
    setError(null)

    const params: Record<string, unknown> = { limit: 50 }
    if (searchQuery.trim()) params.query = searchQuery.trim()
    if (domain.trim()) params.domain = domain.trim()
    if (maturity) params.minMaturity = maturity
    if (minConfidence) params.minConfidence = parseFloat(minConfidence)

    rpc<KU[]>('akp.ku.query', params)
      .then((result) => {
        setKus(result)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [searchQuery, domain, maturity, minConfidence])

  useEffect(() => {
    fetchKUs()
  }, [fetchKUs])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(fetchKUs, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, fetchKUs])

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSearchQuery(e.target.value)
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Knowledge Base</h1>
        <p className="page-subtitle">Browse and search all knowledge units</p>
      </div>

      {/* Filters */}
      <div className="filter-row">
        <div className="form-group search-wrap">
          <label className="form-label">Search</label>
          <div className="search-bar">
            <span className="search-bar-icon">⌕</span>
            <input
              type="text"
              className="form-input"
              placeholder="Search by title, summary, domain..."
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Domain</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g. science"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Maturity</label>
          <select
            className="form-select"
            value={maturity}
            onChange={(e) => setMaturity(e.target.value as MaturityFilter)}
          >
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="proposed">Proposed</option>
            <option value="validated">Validated</option>
            <option value="stable">Stable</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Min Confidence</label>
          <select
            className="form-select"
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value as ConfidenceFilter)}
          >
            <option value="">Any</option>
            <option value="0.3">30%+</option>
            <option value="0.5">50%+</option>
            <option value="0.7">70%+</option>
            <option value="0.9">90%+</option>
          </select>
        </div>
      </div>

      {/* Results */}
      {error && (
        <div className="error-banner">
          <span className="error-banner-icon">!</span>
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && (
        <div className="results-count">
          Showing <strong>{kus.length}</strong> knowledge unit{kus.length !== 1 ? 's' : ''}
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="loading-state">
            <span className="spinner" />
            <span>Loading knowledge units...</span>
          </div>
        ) : kus.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <div className="empty-state-title">No knowledge units found</div>
            <div className="empty-state-desc">
              {searchQuery || domain || maturity || minConfidence
                ? 'Try adjusting your filters.'
                : 'No knowledge units have been created yet.'}
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
                {kus.map((ku) => {
                  const title = ku.meta.title['en'] ?? Object.values(ku.meta.title)[0] ?? ku.id
                  return (
                    <tr
                      key={ku.id}
                      className="clickable"
                      onClick={() => { window.location.hash = `#/knowledge/${ku.id}` }}
                    >
                      <td style={{ maxWidth: 280 }}>
                        <span style={{ fontWeight: 500 }}>{title}</span>
                        {(ku.meta.summary ?? ku.narrative?.summary) && (
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                            {ku.meta.summary ?? ku.narrative?.summary}
                          </div>
                        )}
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
                          {(ku.meta.tags ?? []).length > 3 && (
                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                              +{(ku.meta.tags ?? []).length - 3}
                            </span>
                          )}
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
