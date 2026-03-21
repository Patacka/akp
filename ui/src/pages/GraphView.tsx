import React, { useEffect, useRef, useState, useCallback } from 'react'
import { rpc } from '../rpc'
import type { KU } from '../types'
import { MaturityBadge, ConfidenceBar, Tag } from '../components/Badges'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GNode {
  id: string
  ku: KU
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

interface GEdge {
  a: string
  b: string
  strength: number  // 0–1, affects spring stiffness
}

// ── Colors ────────────────────────────────────────────────────────────────────

const MATURITY_COLOR: Record<string, string> = {
  draft:     '#94a3b8',
  proposed:  '#facc15',
  validated: '#4ade80',
  stable:    '#6c63ff',
}

// ── Force simulation (one tick) ───────────────────────────────────────────────

function tick(nodes: GNode[], edges: GEdge[], w: number, h: number) {
  const cx = w / 2
  const cy = h / 2
  const REPULSE  = 4000
  const SPRING   = 0.04
  const GRAVITY  = 0.012
  const DAMPING  = 0.85

  // Repulsion between all pairs
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      const dx = b.x - a.x || 0.01
      const dy = b.y - a.y || 0.01
      const dist2 = dx * dx + dy * dy
      const force = REPULSE / dist2
      const fx = (dx / Math.sqrt(dist2)) * force
      const fy = (dy / Math.sqrt(dist2)) * force
      a.vx -= fx; a.vy -= fy
      b.vx += fx; b.vy += fy
    }
  }

  // Spring attraction along edges
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  for (const e of edges) {
    const a = nodeMap.get(e.a), b = nodeMap.get(e.b)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const target = 120 + (1 - e.strength) * 80
    const f = (dist - target) * SPRING * e.strength
    a.vx += (dx / dist) * f; a.vy += (dy / dist) * f
    b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f
  }

  // Center gravity
  for (const n of nodes) {
    n.vx += (cx - n.x) * GRAVITY
    n.vy += (cy - n.y) * GRAVITY
    n.vx *= DAMPING
    n.vy *= DAMPING
    n.x += n.vx
    n.y += n.vy
  }
}

// ── Build graph from KUs ──────────────────────────────────────────────────────

function buildGraph(kus: KU[], w: number, h: number): { nodes: GNode[]; edges: GEdge[] } {
  const cx = w / 2, cy = h / 2, spread = Math.min(w, h) * 0.35
  const angle = (2 * Math.PI) / Math.max(kus.length, 1)

  const nodes: GNode[] = kus.map((ku, i) => ({
    id: ku.id,
    ku,
    x: cx + Math.cos(i * angle) * spread * (0.6 + Math.random() * 0.4),
    y: cy + Math.sin(i * angle) * spread * (0.6 + Math.random() * 0.4),
    vx: 0, vy: 0,
    r: 10 + ku.meta.confidence.aggregate * 8,
  }))

  // Build edges: shared claim subjects → strong edge; same domain → weak edge
  const edges: GEdge[] = []
  const edgeSet = new Set<string>()

  const addEdge = (a: string, b: string, strength: number) => {
    const key = [a, b].sort().join('|')
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push({ a, b, strength })
  }

  // Shared subjects
  const subjectMap = new Map<string, string[]>()
  for (const ku of kus) {
    for (const claim of ku.structured.claims) {
      const s = claim.subject.toLowerCase().trim()
      if (!subjectMap.has(s)) subjectMap.set(s, [])
      subjectMap.get(s)!.push(ku.id)
    }
  }
  for (const ids of subjectMap.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        addEdge(ids[i], ids[j], 0.9)
  }

  // Same domain
  const domainMap = new Map<string, string[]>()
  for (const ku of kus) {
    if (!domainMap.has(ku.meta.domain)) domainMap.set(ku.meta.domain, [])
    domainMap.get(ku.meta.domain)!.push(ku.id)
  }
  for (const ids of domainMap.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        addEdge(ids[i], ids[j], 0.3)
  }

  return { nodes, edges }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GraphView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [kus, setKus] = useState<KU[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<KU | null>(null)

  const stateRef = useRef<{
    nodes: GNode[]
    edges: GEdge[]
    zoom: number
    panX: number
    panY: number
    dragging: boolean
    dragStart: { x: number; y: number; panX: number; panY: number } | null
    raf: number
    settled: boolean
    tick: number
  }>({ nodes: [], edges: [], zoom: 1, panX: 0, panY: 0, dragging: false, dragStart: null, raf: 0, settled: false, tick: 0 })

  // ── Load KUs ───────────────────────────────────────────────────────────────
  useEffect(() => {
    rpc<KU[]>('akp.ku.query', { limit: 100 })
      .then(setKus)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // ── Init graph when KUs arrive ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || kus.length === 0) return
    const s = stateRef.current
    const { nodes, edges } = buildGraph(kus, canvas.width, canvas.height)
    s.nodes = nodes
    s.edges = edges
    s.tick = 0
    s.settled = false
  }, [kus])

  // ── Draw ───────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const s = stateRef.current
    const { nodes, edges, zoom, panX, panY } = s
    const dpr = window.devicePixelRatio || 1
    const W = canvas.width / dpr
    const H = canvas.height / dpr

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.translate(W / 2 + panX, H / 2 + panY)
    ctx.scale(zoom, zoom)
    ctx.translate(-W / 2, -H / 2)

    // Edges
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    for (const e of edges) {
      const a = nodeMap.get(e.a), b = nodeMap.get(e.b)
      if (!a || !b) continue
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = e.strength > 0.5
        ? 'rgba(108,99,255,0.35)'
        : 'rgba(148,163,184,0.12)'
      ctx.lineWidth = e.strength > 0.5 ? 1.5 : 0.8
      ctx.stroke()
    }

    // Nodes
    for (const n of nodes) {
      const color = MATURITY_COLOR[n.ku.meta.maturity] ?? '#6c63ff'
      const isSelected = selected?.id === n.id

      // Glow for selected
      if (isSelected) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2)
        ctx.fillStyle = color + '40'
        ctx.fill()
      }

      // Circle
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      ctx.fillStyle = color + (isSelected ? 'ff' : 'cc')
      ctx.fill()
      ctx.strokeStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.15)'
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.stroke()

      // Label (only when zoom is reasonable)
      if (zoom > 0.5) {
        const title = n.ku.meta.title['en'] ?? n.ku.id
        const maxLen = Math.floor(16 / zoom)
        const label = title.length > maxLen ? title.slice(0, maxLen) + '…' : title
        ctx.fillStyle = 'rgba(226,232,240,0.85)'
        ctx.font = `${Math.min(11, 11 / zoom)}px Inter, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(label, n.x, n.y + n.r + 13)
      }
    }

    ctx.restore()
  }, [selected])

  // ── Animation loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const s = stateRef.current

    const loop = () => {
      if (!s.settled) {
        const dpr = window.devicePixelRatio || 1
        tick(s.nodes, s.edges, canvas.width / dpr, canvas.height / dpr)
        s.tick++
        if (s.tick > 300) s.settled = true
      }
      draw()
      s.raf = requestAnimationFrame(loop)
    }
    s.raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(s.raf)
  }, [draw])

  // ── Resize canvas ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width  = rect.width  * dpr
      canvas.height = rect.height * dpr
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── Hit test ───────────────────────────────────────────────────────────────
  const hitTest = useCallback((clientX: number, clientY: number): GNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const s = stateRef.current
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const W = canvas.width / dpr
    const H = canvas.height / dpr

    // Invert transform: translate center+pan → scale → translate -center
    const cx = (clientX - rect.left - W / 2 - s.panX) / s.zoom + W / 2
    const cy = (clientY - rect.top  - H / 2 - s.panY) / s.zoom + H / 2

    for (const n of s.nodes) {
      const dx = cx - n.x, dy = cy - n.y
      if (dx * dx + dy * dy <= (n.r + 4) ** 2) return n
    }
    return null
  }, [])

  // ── Mouse / wheel events ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const s = stateRef.current

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.1 : 0.91
      s.zoom = Math.max(0.15, Math.min(5, s.zoom * factor))
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      s.dragging = true
      s.dragStart = { x: e.clientX, y: e.clientY, panX: s.panX, panY: s.panY }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!s.dragging || !s.dragStart) return
      s.panX = s.dragStart.panX + (e.clientX - s.dragStart.x)
      s.panY = s.dragStart.panY + (e.clientY - s.dragStart.y)
    }

    const onMouseUp = (e: MouseEvent) => {
      if (!s.dragging) return
      const moved = s.dragStart
        ? Math.abs(e.clientX - s.dragStart.x) + Math.abs(e.clientY - s.dragStart.y)
        : 999
      s.dragging = false
      s.dragStart = null

      if (moved < 5) {
        // click — hit test
        const hit = hitTest(e.clientX, e.clientY)
        if (hit) {
          setSelected(prev => prev?.id === hit.id ? null : hit.ku)
        } else {
          setSelected(null)
        }
      }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [hitTest])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)', position: 'relative' }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1 className="page-title">Knowledge Graph</h1>
        <p className="page-subtitle">
          Nodes by maturity · edges by shared subjects &amp; domain · scroll to zoom · drag to pan · click to inspect
        </p>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexShrink: 0, flexWrap: 'wrap' }}>
        {Object.entries(MATURITY_COLOR).map(([m, c]) => (
          <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: c, display: 'inline-block' }} />
            {m}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>
          <span style={{ width: 24, height: 2, background: 'rgba(108,99,255,0.5)', display: 'inline-block' }} /> shared subject
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
          <span style={{ width: 24, height: 1, background: 'rgba(148,163,184,0.35)', display: 'inline-block' }} /> same domain
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg)' }}>
        {loading && (
          <div className="loading-state" style={{ position: 'absolute', inset: 0 }}>
            <span className="spinner" /><span>Loading knowledge units…</span>
          </div>
        )}
        {error && (
          <div className="error-banner" style={{ position: 'absolute', top: 16, left: 16, right: 16 }}>
            <span className="error-banner-icon">!</span><span>{error}</span>
          </div>
        )}
        {!loading && !error && kus.length === 0 && (
          <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
            <div className="empty-state-icon">◈</div>
            <div className="empty-state-title">No knowledge units yet</div>
            <div className="empty-state-desc">Create some KUs to see the graph.</div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab' }}
        />

        {/* Info box */}
        {selected && (
          <div
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 300,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              overflow: 'hidden',
              animation: 'modal-in 0.15s ease',
            }}
          >
            {/* Header */}
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', lineHeight: 1.4, marginBottom: 6 }}>
                  {selected.meta.title['en'] ?? selected.id}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span className="domain-badge">{selected.meta.domain}</span>
                  <MaturityBadge maturity={selected.meta.maturity} />
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
              >×</button>
            </div>

            {/* Confidence */}
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
              <ConfidenceBar value={selected.meta.confidence.aggregate} />
            </div>

            {/* Summary */}
            {selected.narrative.summary && (
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                {selected.narrative.summary.slice(0, 160)}{selected.narrative.summary.length > 160 ? '…' : ''}
              </div>
            )}

            {/* Claims preview */}
            {selected.structured.claims.length > 0 && (
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6 }}>Claims</div>
                {selected.structured.claims.slice(0, 3).map(c => (
                  <div key={c.id} style={{ fontSize: 12, color: 'var(--text)', marginBottom: 4, lineHeight: 1.4 }}>
                    <span style={{ color: 'var(--muted)' }}>{c.subject}</span>
                    {' '}<span style={{ color: 'var(--primary)' }}>{c.predicate}</span>
                    {' '}<span>{String(c.object)}</span>
                  </div>
                ))}
                {selected.structured.claims.length > 3 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>+{selected.structured.claims.length - 3} more</div>
                )}
              </div>
            )}

            {/* Tags */}
            {selected.meta.tags.length > 0 && (
              <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
                <div className="tag-list">
                  {selected.meta.tags.slice(0, 5).map(t => <Tag key={t} text={t} />)}
                </div>
              </div>
            )}

            {/* Open button */}
            <div style={{ padding: '10px 16px' }}>
              <a
                href={`#/knowledge/${selected.id}`}
                className="btn btn-primary btn-sm"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                Open full detail →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
