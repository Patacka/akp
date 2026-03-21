import React, { useEffect, useState } from 'react'
import { rpc } from '../rpc'
import type { KU } from '../types'
import { MaturityBadge, VerdictBadge, ConfidenceBar, Tag } from '../components/Badges'

interface KUDetailProps {
  kuId: string
}

function truncateDid(did: string): string {
  if (did.length <= 20) return did
  return did.slice(0, 20) + '...'
}

function objectToString(obj: unknown): string {
  if (obj === null || obj === undefined) return '—'
  if (typeof obj === 'string') return obj
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)
  return JSON.stringify(obj)
}

export default function KUDetail({ kuId }: KUDetailProps) {
  const [ku, setKu] = useState<KU | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Review form
  const [reviewVerdict, setReviewVerdict] = useState<'confirmed' | 'amended' | 'disputed' | 'rejected'>('confirmed')
  const [reviewComment, setReviewComment] = useState('')
  const [reviewerDid, setReviewerDid] = useState<string>(() => localStorage.getItem('akp_reviewer_did') ?? '')
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null)
  const [showDidPrompt, setShowDidPrompt] = useState(false)
  const [didInput, setDidInput] = useState('')

  useEffect(() => {
    setLoading(true)
    setError(null)
    rpc<KU>('akp.ku.read', { kuId })
      .then((result) => {
        setKu(result)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [kuId])

  function handleReviewSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!reviewerDid.trim()) {
      setShowDidPrompt(true)
      return
    }

    if (!ku) return

    const claimIds = ku.structured.claims.map((c) => c.id)

    setReviewLoading(true)
    setReviewError(null)
    setReviewSuccess(null)

    rpc<{ newConfidence: number; maturityChange: string }>('akp.review.submit', {
      kuId,
      claimIds,
      verdict: reviewVerdict,
      reviewerDid: reviewerDid.trim(),
      reviewerType: 'human',
      comment: reviewComment.trim() || undefined,
    })
      .then((result) => {
        setReviewSuccess(
          `Review submitted. New confidence: ${Math.round(result.newConfidence * 100)}%, maturity: ${result.maturityChange}`
        )
        setReviewComment('')
        // Reload KU to show updated reviews
        rpc<KU>('akp.ku.read', { kuId }).then(setKu).catch(() => null)
      })
      .catch((err: Error) => setReviewError(err.message))
      .finally(() => setReviewLoading(false))
  }

  function handleSaveDid() {
    const did = didInput.trim()
    if (!did) return
    setReviewerDid(did)
    localStorage.setItem('akp_reviewer_did', did)
    setShowDidPrompt(false)
    setDidInput('')
  }

  if (loading) {
    return (
      <div className="loading-state" style={{ padding: 80 }}>
        <span className="spinner" />
        <span>Loading knowledge unit...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <a className="back-link" onClick={() => { window.location.hash = '#/knowledge' }}>
          ← Back to Knowledge Base
        </a>
        <div className="error-banner">
          <span className="error-banner-icon">!</span>
          <span>Failed to load KU: {error}</span>
        </div>
      </div>
    )
  }

  if (!ku) return (
    <div>
      <a className="back-link" onClick={() => { window.location.hash = '#/knowledge' }}>← Back to Knowledge Base</a>
      <div className="error-banner"><span className="error-banner-icon">!</span><span>Knowledge unit not found.</span></div>
    </div>
  )

  const title = ku.meta.title['en'] ?? Object.values(ku.meta.title)[0] ?? ku.id
  const summary = ku.meta.summary ?? ku.narrative?.summary

  return (
    <div>
      <a className="back-link" onClick={() => { window.location.hash = '#/knowledge' }}>
        ← Back to Knowledge Base
      </a>

      {/* Detail Header */}
      <div className="detail-header">
        <h1 className="detail-title">{title}</h1>
        <div className="detail-meta">
          <span className="domain-badge">{ku.meta.domain}</span>
          <MaturityBadge maturity={ku.meta.maturity} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>v{ku.version}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Created {new Date(ku.meta.created).toLocaleDateString()}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Modified {new Date(ku.meta.modified).toLocaleDateString()}
          </span>
        </div>

        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <ConfidenceBar value={ku.meta.confidence?.aggregate ?? 0} large />
        </div>

        {summary && (
          <p className="detail-summary">{summary}</p>
        )}

        {(ku.meta.tags ?? []).length > 0 && (
          <div className="tag-list" style={{ marginTop: 10 }}>
            {ku.meta.tags.map((t) => <Tag key={t} text={t} />)}
          </div>
        )}
      </div>

      {/* Claims */}
      <div className="section">
        <div className="section-title">Claims ({ku.structured.claims.length})</div>
        {ku.structured.claims.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 0' }}>
            <div className="empty-state-desc">No claims in this knowledge unit.</div>
          </div>
        ) : (
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Subject</th>
                  <th>Predicate</th>
                  <th>Object</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {ku.structured.claims.map((claim) => (
                  <tr key={claim.id}>
                    <td>
                      <span className="badge badge-proposed" style={{ textTransform: 'none' }}>
                        {claim.type}
                      </span>
                    </td>
                    <td style={{ fontWeight: 500 }}>{claim.subject}</td>
                    <td style={{ color: 'var(--muted)' }}>{claim.predicate}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {objectToString(claim.object)}
                    </td>
                    <td>
                      <ConfidenceBar value={claim.confidence ?? 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Provenance */}
      <div className="section">
        <div className="section-title">Provenance ({ku.provenance.length})</div>
        {ku.provenance.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 0' }}>
            <div className="empty-state-desc">No provenance records.</div>
          </div>
        ) : (
          ku.provenance.map((prov) => (
            <div className="provenance-item" key={prov.id}>
              <div className="provenance-meta">
                <span
                  className="did-truncated"
                  title={prov.did}
                >
                  {truncateDid(prov.did)}
                </span>
                <span className="badge badge-proposed" style={{ textTransform: 'none' }}>
                  {prov.type}
                </span>
                <span className="method-badge">{prov.method}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {new Date(prov.timestamp).toLocaleDateString()}
                </span>
              </div>
              {prov.sources && prov.sources.length > 0 && (
                <div className="source-list">
                  {prov.sources.map((src, i) => (
                    <div className="source-item" key={i}>
                      <span className="source-type">{src.type}:</span>
                      <span>{src.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Reviews */}
      <div className="section">
        <div className="section-title">Reviews ({ku.reviews.length})</div>
        {ku.reviews.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 0' }}>
            <div className="empty-state-desc">No reviews submitted yet. Be the first to review this KU.</div>
          </div>
        ) : (
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th>Type</th>
                  <th>Verdict</th>
                  <th>Weight</th>
                  <th>Timestamp</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {ku.reviews.map((rev) => (
                  <tr key={rev.id}>
                    <td>
                      <span className="did-truncated" title={rev.reviewerDid}>
                        {truncateDid(rev.reviewerDid)}
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-draft" style={{ textTransform: 'none' }}>
                        {rev.reviewerType}
                      </span>
                    </td>
                    <td>
                      <VerdictBadge verdict={rev.verdict} />
                    </td>
                    <td style={{ color: 'var(--muted)' }}>
                      {(rev.weight * 100).toFixed(1)}%
                    </td>
                    <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {new Date(rev.timestamp).toLocaleDateString()}
                    </td>
                    <td style={{ color: 'var(--muted)', maxWidth: 200 }}>
                      {rev.comment ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Submit Review */}
      <div className="section">
        <div className="section-title">Submit Review</div>
        <div className="card">
          <div className="card-body">
            {showDidPrompt ? (
              <div>
                <div className="form-group">
                  <label className="form-label">
                    Your Reviewer DID <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="did:key:..."
                    value={didInput}
                    onChange={(e) => setDidInput(e.target.value)}
                    autoFocus
                  />
                  <span className="form-hint">
                    Your DID will be saved in your browser for future reviews.
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={() => setShowDidPrompt(false)}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" onClick={handleSaveDid} disabled={!didInput.trim()}>
                    Save DID
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleReviewSubmit}>
                {reviewerDid && (
                  <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--muted)' }}>
                    Reviewing as:{' '}
                    <span className="did-truncated" title={reviewerDid} style={{ color: 'var(--text)' }}>
                      {truncateDid(reviewerDid)}
                    </span>
                    {' '}
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginLeft: 6 }}
                      onClick={() => { setShowDidPrompt(true); setDidInput(reviewerDid) }}
                    >
                      Change
                    </button>
                  </div>
                )}

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="review-verdict">
                      Verdict <span className="required">*</span>
                    </label>
                    <select
                      id="review-verdict"
                      className="form-select"
                      value={reviewVerdict}
                      onChange={(e) => setReviewVerdict(e.target.value as typeof reviewVerdict)}
                    >
                      <option value="confirmed">Confirmed</option>
                      <option value="amended">Amended</option>
                      <option value="disputed">Disputed</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="review-comment">
                    Comment
                  </label>
                  <textarea
                    id="review-comment"
                    className="form-textarea"
                    placeholder="Optional: explain your verdict..."
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    rows={3}
                  />
                </div>

                {reviewError && (
                  <div className="error-banner">
                    <span className="error-banner-icon">!</span>
                    <span>{reviewError}</span>
                  </div>
                )}
                {reviewSuccess && (
                  <div className="success-banner">
                    <span>✓</span>
                    <span>{reviewSuccess}</span>
                  </div>
                )}

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={reviewLoading}
                >
                  {reviewLoading ? (
                    <>
                      <span className="spinner spinner-sm" />
                      Submitting...
                    </>
                  ) : 'Submit Review'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Narrative body if present */}
      {ku.narrative?.body && (
        <div className="section">
          <div className="section-title">Full Narrative</div>
          <div className="card">
            <div className="card-body">
              <p style={{ color: 'var(--text)', lineHeight: 1.8, whiteSpace: 'pre-wrap', fontSize: 14 }}>
                {ku.narrative.body}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
