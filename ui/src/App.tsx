import React, { useState, useEffect } from 'react'
import Nav from './components/Nav'
import ApiKeyModal from './components/ApiKeyModal'
import Home from './pages/Home'
import KUList from './pages/KUList'
import KUDetail from './pages/KUDetail'
import KUCreate from './pages/KUCreate'
import Governance from './pages/Governance'
import Reputation from './pages/Reputation'
import { getApiKey } from './rpc'

interface ParsedRoute {
  page: 'home' | 'knowledge' | 'ku-detail' | 'create' | 'governance' | 'reputation'
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

  // Check server reachability on mount
  useEffect(() => {
    fetch('/health')
      .then((res) => {
        if (res.status === 401) {
          // Server reachable but needs auth
          if (!getApiKey()) {
            setShowApiKeyModal(true)
          }
        } else if (!res.ok) {
          setServerError(`Server returned ${res.status}`)
        } else {
          setServerError(null)
        }
      })
      .catch(() => {
        setServerError('Cannot connect to AKP server at localhost:3000. Make sure the backend is running.')
      })
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
      default:
        return <Home />
    }
  }

  return (
    <>
      {showApiKeyModal && (
        <ApiKeyModal onClose={handleApiKeyModalClose} />
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
