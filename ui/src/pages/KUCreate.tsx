import React, { useState } from 'react'
import { rpc } from '../rpc'

interface ClaimFormEntry {
  key: number
  type: 'factual' | 'quantitative' | 'temporal'
  subject: string
  predicate: string
  object: string
  confidence: string
}

let claimKeyCounter = 0

function makeClaim(): ClaimFormEntry {
  return {
    key: claimKeyCounter++,
    type: 'factual',
    subject: '',
    predicate: '',
    object: '',
    confidence: '0.7',
  }
}

export default function KUCreate() {
  const [domain, setDomain] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [narrativeBody, setNarrativeBody] = useState('')

  const [claims, setClaims] = useState<ClaimFormEntry[]>([])

  const [provDid, setProvDid] = useState(() => localStorage.getItem('akp_reviewer_did') ?? '')
  const [provType, setProvType] = useState<'agent' | 'human'>('human')
  const [provMethod, setProvMethod] = useState<'observation' | 'inference' | 'synthesis' | 'retrieval' | 'human_input'>('human_input')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  function addClaim() {
    setClaims((prev) => [...prev, makeClaim()])
  }

  function removeClaim(key: number) {
    setClaims((prev) => prev.filter((c) => c.key !== key))
  }

  function updateClaim(key: number, field: keyof Omit<ClaimFormEntry, 'key'>, value: string) {
    setClaims((prev) =>
      prev.map((c) =>
        c.key === key ? { ...c, [field]: value } : c
      )
    )
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!domain.trim() || !title.trim()) {
      setError('Domain and Title are required.')
      return
    }

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    const builtClaims = claims
      .filter((c) => c.subject.trim() && c.predicate.trim() && c.object.trim())
      .map((c) => ({
        type: c.type,
        subject: c.subject.trim(),
        predicate: c.predicate.trim(),
        object: c.object.trim(),
        confidence: parseFloat(c.confidence) || 0.7,
      }))

    const params: Record<string, unknown> = {
      domain: domain.trim(),
      title: { en: title.trim() },
      tags,
    }

    if (summary.trim()) params.summary = summary.trim()
    if (builtClaims.length > 0) params.claims = builtClaims
    if (narrativeBody.trim()) params.narrative = { body: narrativeBody.trim() }

    if (provDid.trim()) {
      params.provenance = {
        did: provDid.trim(),
        type: provType,
        method: provMethod,
      }
      // Save DID for future use
      localStorage.setItem('akp_reviewer_did', provDid.trim())
    }

    setLoading(true)
    setError(null)
    setSuccess(null)

    rpc<{ kuId: string; version: number; maturity: string; confidence: number }>(
      'akp.ku.create',
      params
    )
      .then((result) => {
        setSuccess(`Knowledge unit created! ID: ${result.kuId}`)
        // Navigate to the new KU
        setTimeout(() => {
          window.location.hash = `#/knowledge/${result.kuId}`
        }, 800)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Create Knowledge Unit</h1>
        <p className="page-subtitle">
          Submit a new piece of knowledge with structured claims and provenance
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Core metadata */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <span className="card-title">Core Metadata</span>
          </div>
          <div className="card-body">
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="ku-domain">
                  Domain <span className="required">*</span>
                </label>
                <input
                  id="ku-domain"
                  type="text"
                  className="form-input"
                  placeholder="e.g. science, technology, history"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  required
                />
              </div>

              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label" htmlFor="ku-title">
                  Title <span className="required">*</span>
                </label>
                <input
                  id="ku-title"
                  type="text"
                  className="form-input"
                  placeholder="Concise, descriptive title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="ku-summary">
                Summary
              </label>
              <textarea
                id="ku-summary"
                className="form-textarea"
                placeholder="Brief summary of the knowledge unit..."
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="ku-tags">
                Tags
              </label>
              <input
                id="ku-tags"
                type="text"
                className="form-input"
                placeholder="Comma-separated: ai, machine-learning, neural-networks"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
              <span className="form-hint">Separate tags with commas</span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="ku-narrative">
                Narrative Body
              </label>
              <textarea
                id="ku-narrative"
                className="form-textarea"
                placeholder="Optional: extended narrative, methodology, context..."
                value={narrativeBody}
                onChange={(e) => setNarrativeBody(e.target.value)}
                rows={4}
              />
            </div>
          </div>
        </div>

        {/* Claims */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <span className="card-title">Claims ({claims.length})</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={addClaim}>
              + Add Claim
            </button>
          </div>
          <div className="card-body">
            {claims.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 0' }}>
                <div className="empty-state-icon">◈</div>
                <div className="empty-state-title">No claims yet</div>
                <div className="empty-state-desc">
                  Add structured claims to make this knowledge unit more precise and verifiable.
                </div>
                <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={addClaim}>
                  Add First Claim
                </button>
              </div>
            ) : (
              claims.map((claim, i) => (
                <div className="claim-card" key={claim.key}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
                      CLAIM {i + 1}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => removeClaim(claim.key)}
                    >
                      Remove
                    </button>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Type</label>
                      <select
                        className="form-select"
                        value={claim.type}
                        onChange={(e) => updateClaim(claim.key, 'type', e.target.value)}
                      >
                        <option value="factual">Factual</option>
                        <option value="quantitative">Quantitative</option>
                        <option value="temporal">Temporal</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Subject</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. Python"
                        value={claim.subject}
                        onChange={(e) => updateClaim(claim.key, 'subject', e.target.value)}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Predicate</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. is_a"
                        value={claim.predicate}
                        onChange={(e) => updateClaim(claim.key, 'predicate', e.target.value)}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Object</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. programming language"
                        value={claim.object}
                        onChange={(e) => updateClaim(claim.key, 'object', e.target.value)}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Confidence (0–1)</label>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        max="1"
                        step="0.05"
                        value={claim.confidence}
                        onChange={(e) => updateClaim(claim.key, 'confidence', e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Provenance */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <span className="card-title">Provenance</span>
          </div>
          <div className="card-body">
            <div className="form-row">
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label" htmlFor="prov-did">
                  Your DID
                </label>
                <input
                  id="prov-did"
                  type="text"
                  className="form-input"
                  placeholder="did:key:..."
                  value={provDid}
                  onChange={(e) => setProvDid(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="prov-type">
                  Type
                </label>
                <select
                  id="prov-type"
                  className="form-select"
                  value={provType}
                  onChange={(e) => setProvType(e.target.value as 'agent' | 'human')}
                >
                  <option value="human">Human</option>
                  <option value="agent">Agent</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="prov-method">
                  Method
                </label>
                <select
                  id="prov-method"
                  className="form-select"
                  value={provMethod}
                  onChange={(e) => setProvMethod(e.target.value as typeof provMethod)}
                >
                  <option value="human_input">Human Input</option>
                  <option value="observation">Observation</option>
                  <option value="inference">Inference</option>
                  <option value="synthesis">Synthesis</option>
                  <option value="retrieval">Retrieval</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Submit */}
        {error && (
          <div className="error-banner">
            <span className="error-banner-icon">!</span>
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="success-banner">
            <span>✓</span>
            <span>{success}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner spinner-sm" />
                Creating...
              </>
            ) : 'Create Knowledge Unit'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => { window.location.hash = '#/knowledge' }}
            disabled={loading}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
