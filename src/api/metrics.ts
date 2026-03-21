/**
 * metrics.ts — Minimal hand-rolled Prometheus-compatible metrics.
 *
 * No external dependency. Exposes counters and gauges that the RPC server
 * increments, then serialises them into Prometheus text exposition format
 * at GET /metrics.
 */

export interface Counter {
  inc(labels?: Record<string, string>): void
  get(labels?: Record<string, string>): number
}

export interface Gauge {
  set(value: number, labels?: Record<string, string>): void
  get(labels?: Record<string, string>): number
}

function labelKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return ''
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',')
}

function renderLabels(labels?: Record<string, string>): string {
  const k = labelKey(labels)
  return k ? `{${k}}` : ''
}

class CounterImpl implements Counter {
  private values = new Map<string, number>()
  private readonly _name: string
  private readonly _help: string

  constructor(name: string, help: string) {
    this._name = name
    this._help = help
  }

  inc(labels?: Record<string, string>): void {
    const k = labelKey(labels)
    this.values.set(k, (this.values.get(k) ?? 0) + 1)
  }

  get(labels?: Record<string, string>): number {
    return this.values.get(labelKey(labels)) ?? 0
  }

  render(): string {
    const lines = [
      `# HELP ${this._name} ${this._help}`,
      `# TYPE ${this._name} counter`,
    ]
    for (const [k, v] of this.values) {
      lines.push(`${this._name}${k ? `{${k}}` : ''} ${v}`)
    }
    return lines.join('\n')
  }
}

class GaugeImpl implements Gauge {
  private values = new Map<string, number>()
  private readonly _name: string
  private readonly _help: string

  constructor(name: string, help: string) {
    this._name = name
    this._help = help
  }

  set(value: number, labels?: Record<string, string>): void {
    this.values.set(labelKey(labels), value)
  }

  get(labels?: Record<string, string>): number {
    return this.values.get(labelKey(labels)) ?? 0
  }

  render(): string {
    const lines = [
      `# HELP ${this._name} ${this._help}`,
      `# TYPE ${this._name} gauge`,
    ]
    for (const [k, v] of this.values) {
      lines.push(`${this._name}${k ? `{${k}}` : ''} ${v}`)
    }
    return lines.join('\n')
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

class Registry {
  private items: Array<CounterImpl | GaugeImpl> = []

  counter(name: string, help: string): Counter {
    const c = new CounterImpl(name, help)
    this.items.push(c)
    return c
  }

  gauge(name: string, help: string): Gauge {
    const g = new GaugeImpl(name, help)
    this.items.push(g)
    return g
  }

  render(): string {
    return this.items.map(i => i.render()).join('\n\n') + '\n'
  }
}

export const registry = new Registry()

// ── AKP-specific metrics ───────────────────────────────────────────────────────

export const metricsStore = {
  rpcRequests:     registry.counter('akp_rpc_requests_total',     'Total JSON-RPC requests by method'),
  rpcErrors:       registry.counter('akp_rpc_errors_total',       'Total JSON-RPC errors by method'),
  kuCreated:       registry.counter('akp_ku_created_total',       'Total KUs created'),
  kuReviews:       registry.counter('akp_ku_reviews_total',       'Total review submissions by verdict'),
  commits:         registry.counter('akp_commits_total',          'Total commit-reveal commits'),
  reveals:         registry.counter('akp_reveals_total',          'Total commit-reveal reveals'),
  proposalsTotal:  registry.counter('akp_governance_proposals_total', 'Total governance proposals submitted'),
  votesTotal:      registry.counter('akp_governance_votes_total',     'Total governance votes cast'),
  kuCount:         registry.gauge('akp_ku_count',                 'Current total number of KUs in the store'),
  blacklistCount:  registry.gauge('akp_blacklisted_agents_count', 'Number of currently blacklisted agents'),
}
