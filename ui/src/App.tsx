import React, { useState, useEffect } from 'react'
import Nav from './components/Nav'
import ApiKeyModal from './components/ApiKeyModal'
import Home from './pages/Home'
import KUList from './pages/KUList'
import KUDetail from './pages/KUDetail'
import KUCreate from './pages/KUCreate'
import Governance from './pages/Governance'
import Reputation from './pages/Reputation'
import GraphView from './pages/GraphView'
import { getApiKey, IS_DEMO } from './rpc'

interface ParsedRoute {
  page: 'home' | 'knowledge' | 'ku-detail' | 'create' | 'governance' | 'reputation' | 'graph'
  params: Record<string, string>
}

function parseHash(hash: string): ParsedRoute {
  // Remove leading '#' and ensure starts with '/'
  const path = hash.startsWith('#') ? hash.slice(1) : hash
  const normalizedPath = path.startsWith('/') ? path : '/' + path

  if (normalizedPath === '/' || normalizedPath === '/home' || normalizedPath === '') {
    return { page: 'home', params: {} }
  }

  const knowledgeDetailMatch = normalizedPath.match(/^\/knowledge\/([^/]+)$/)
  if (knowledgeDetailMatch) {
    return { page: 'ku-detail', params: { id: knowledgeDetailMatch[1] } }
  }

  if (normalizedPath === '/knowledge') {
    return { page: 'knowledge', params: {} }
  }

  if (normalizedPath === '/create') {
    return { page: 'create', params: {} }
  }

  if (normalizedPath === '/governance') {
    return { page: 'governance', params: {} }
  }

  if (normalizedPath === '/reputation') {
    return { page: 'reputation', params: {} }
  }

  if (normalizedPath === '/graph') {
    return { page: 'graph', params: {} }
  }

  // Fallback to home
  return { page: 'home', params: {} }
}

function getCurrentPath(): string {
  const hash = window.location.hash
  const path = hash.startsWith('#') ? hash.slice(1) : hash
  return path.startsWith('/') ? path : '/' + path
}

export default function App() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const route = parseHash(hash)
  const currentPath = getCurrentPath()

  useEffect(() => {
    // Set initial hash
    if (!window.location.hash) {
      window.location.hash = '#/'
    }

    function handleHashChange() {
      setHash(window.location.hash || '#/')
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  // Check server reachability on mount (skipped in demo mode)
  useEffect(() => {
    if (IS_DEMO) return
    fetch('/health')
      .then(async (res) => {
        if (!res.ok) { setServerError(`Server returned ${res.status}`); return }
        const body = await res.json() as { requiresAuth?: boolean }
        setServerError(null)
        if (body.requiresAuth && !getApiKey()) setShowApiKeyModal(true)
      })
      .catch(() => {
        setServerError('Cannot connect to AKP server at localhost:3000. Make sure the backend is running.')
      })
  }, [])

  // Show auth modal whenever any RPC call returns 401
  useEffect(() => {
    if (IS_DEMO) return
    function handleUnauthorized() { setShowApiKeyModal(true) }
    window.addEventListener('akp:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('akp:unauthorized', handleUnauthorized)
  }, [])

  function handleApiKeyModalClose() {
    setShowApiKeyModal(false)
    // Re-check connectivity
    setServerError(null)
  }

  function renderPage() {
    switch (route.page) {
      case 'home':
        return <Home />
      case 'knowledge':
        return <KUList />
      case 'ku-detail':
        return <KUDetail kuId={route.params.id} />
      case 'create':
        return <KUCreate />
      case 'governance':
        return <Governance />
      case 'reputation':
        return <Reputation />
      case 'graph':
        return <GraphView />
      default:
        return <Home />
    }
  }

  return (
    <>
      {!IS_DEMO && showApiKeyModal && (
        <ApiKeyModal onClose={handleApiKeyModalClose} />
      )}

      {IS_DEMO && (
        <div style={{ background: 'var(--accent)', color: '#fff', textAlign: 'center', padding: '6px 16px', fontSize: 13 }}>
          Read-only demo — <a href="https://github.com/Patacka/akp" style={{ color: '#fff', textDecoration: 'underline' }}>deploy your own node</a> to contribute knowledge
        </div>
      )}

      <div className="layout">
        <Nav currentPath={currentPath} />

        <main className="main-content">
          {serverError && (
            <div className="error-banner" style={{ marginBottom: 20 }}>
              <span className="error-banner-icon">!</span>
              <div>
                <strong>Server Unreachable</strong>
                <div>{serverError}</div>
              </div>
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={() => setShowApiKeyModal(true)}
              >
                Set API Key
              </button>
            </div>
          )}

          {renderPage()}
        </main>
      </div>
    </>
  )
}
