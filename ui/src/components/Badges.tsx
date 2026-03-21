import React from 'react'

interface MaturityBadgeProps {
  maturity: 'draft' | 'proposed' | 'validated' | 'stable'
}

export function MaturityBadge({ maturity }: MaturityBadgeProps) {
  return (
    <span className={`badge badge-${maturity}`}>
      {maturity}
    </span>
  )
}

interface VerdictBadgeProps {
  verdict: 'confirmed' | 'amended' | 'disputed' | 'rejected'
}

export function VerdictBadge({ verdict }: VerdictBadgeProps) {
  return (
    <span className={`badge badge-${verdict}`}>
      {verdict}
    </span>
  )
}

interface ConfidenceBarProps {
  value: number
  large?: boolean
}

export function ConfidenceBar({ value, large }: ConfidenceBarProps) {
  const pct = Math.round(value * 100)
  const level = value < 0.4 ? 'low' : value < 0.7 ? 'medium' : 'high'

  return (
    <div className={`confidence-bar${large ? ' large' : ''}`}>
      <div className="confidence-track">
        <div
          className={`confidence-fill ${level}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="confidence-value">{pct}%</span>
    </div>
  )
}

interface TagProps {
  text: string
}

export function Tag({ text }: TagProps) {
  return <span className="tag">{text}</span>
}
