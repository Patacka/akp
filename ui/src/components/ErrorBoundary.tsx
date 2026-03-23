import React from 'react'

interface State { error: Error | null }

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32 }}>
          <div className="error-banner">
            <span className="error-banner-icon">!</span>
            <div>
              <strong>Something went wrong</strong>
              <div style={{ marginTop: 4, fontSize: 13 }}>{this.state.error.message}</div>
            </div>
            <button
              className="btn btn-sm"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              onClick={() => this.setState({ error: null })}
            >
              Retry
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
