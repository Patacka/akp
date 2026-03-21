const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/'

let _apiKey = localStorage.getItem('akp_api_key') ?? ''

export function setApiKey(key: string): void {
  _apiKey = key
  if (key) {
    localStorage.setItem('akp_api_key', key)
  } else {
    localStorage.removeItem('akp_api_key')
  }
}

export function getApiKey(): string {
  return _apiKey
}

let _requestId = 1

export async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const id = _requestId++
  const url = API_BASE.endsWith('/') ? `${API_BASE}rpc` : `${API_BASE}/rpc`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (_apiKey) {
    headers['Authorization'] = `Bearer ${_apiKey}`
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: params ?? {},
  })

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
  })

  if (res.status === 401) {
    const err = new Error('Unauthorized') as Error & { status: number }
    err.status = 401
    throw err
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  }

  const json = await res.json() as { result?: T; error?: { code: number; message: string } }

  if (json.error) {
    throw new Error(json.error.message)
  }

  return json.result as T
}
