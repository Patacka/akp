import React, { useState } from 'react'
import { setApiKey } from '../rpc'

interface ApiKeyModalProps {
  onClose: () => void
}

export default function ApiKeyModal({ onClose }: ApiKeyModalProps) {
  const [key, setKey] = useState('')

  function handleSave() {
    setApiKey(key.trim())
    onClose()
  }

  function handleSkip() {
    setApiKey('')
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') handleSkip()
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header">
          <div className="modal-title" id="modal-title">API Key Required</div>
          <div className="modal-subtitle">
            The server requires an API key. Enter your key below or skip if authentication
            is disabled on this server.
          </div>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="api-key-input">
              API Key
            </label>
            <input
              id="api-key-input"
              type="password"
              className="form-input"
              placeholder="Enter your API key..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <span className="form-hint">
              The key will be stored in your browser's localStorage.
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={handleSkip}>
            Skip (no auth)
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!key.trim()}
          >
            Save Key
          </button>
        </div>
      </div>
    </div>
  )
}
