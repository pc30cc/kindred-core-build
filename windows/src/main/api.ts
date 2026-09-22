import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiRequest, ApiResult } from '../shared/ipc'
import { readSettings, writeSettings } from './settings'
import { sampleRequest } from './sample'

/** The bootstrap the very first request goes to — the same one the iOS build compiles in. */
export const DEFAULT_ORIGIN = 'https://api.webyar.ai'

/** A sample backend for laying out screens with no account. Only ever on when asked for explicitly. */
export const isSample = process.env.WEBYAR_SAMPLE === '1'

const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebyarDesktop/${app.getVersion()}`

function tokenPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'session.bin')
}

/**
 * The session token lives on disk encrypted with DPAPI (`safeStorage`), which
 * ties it to this Windows user account — the desktop counterpart of the iOS
 * Keychain. Held in memory after the first read.
 */
let token: string | null | undefined

function readToken(): string | null {
  if (token !== undefined) return token
  try {
    const path = tokenPath()
    if (!existsSync(path)) return (token = null)
    const raw = readFileSync(path)
    token = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch {
    token = null
  }
  return token
}

function setToken(value: string | null): void {
  token = value
  const path = tokenPath()
  if (value === null) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8')
  writeFileSync(path, data)
}

export function hasToken(): boolean {
  return isSample ? sampleSignedIn : readToken() !== null
}

let sampleSignedIn = true

export function currentOrigin(): string {
  const s = readSettings()
  const stored = s.apiOrigin
  if (stored && /^https:\/\//i.test(stored)) return stored.replace(/\/+$/, '')
  return DEFAULT_ORIGIN
}

function buildUrl(req: ApiRequest): string {
  const url = new URL(req.path, currentOrigin() + '/')
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null) continue
    url.searchParams.set(k, String(v))
  }
  return url.toString()
}

export async function request<T>(req: ApiRequest): Promise<ApiResult<T>> {
  if (!req.path.startsWith('/api/')) return { ok: false, kind: 'transport', message: 'invalid path' }
  if (isSample) return sampleRequest(req) as ApiResult<T>

  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT }
  const t = readToken()
  if (t) headers.Authorization = `Bearer ${t}`
  let body: string | undefined
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(req.body)
  }

  let response: Response
  try {
    response = await fetch(buildUrl(req), {
      method: req.method,
      headers,
      body,
      // A hung request is worse than a failed one: fail fast enough to show a retry.
      signal: AbortSignal.timeout(req.timeoutMs ?? (req.responseType === 'bytes' ? 60_000 : 20_000)),
    })
  } catch {
    return { ok: false, kind: 'transport' }
  }

  if (!response.ok) {
    // Only 401 means the session is void. A 403 is "not this", never "sign out".
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      parsed = undefined
    }
    if (response.status === 401) return { ok: false, kind: 'unauthorized', status: 401, body: parsed }
    const message =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : undefined
    return { ok: false, kind: 'server', status: response.status, message, body: parsed }
  }

  try {
    if (req.responseType === 'none') return { ok: true, status: response.status, data: null as T }
    if (req.responseType === 'bytes') {
      const buf = new Uint8Array(await response.arrayBuffer())
      return { ok: true, status: response.status, data: buf as T }
    }
    const text = await response.text()
    return { ok: true, status: response.status, data: (text ? JSON.parse(text) : null) as T }
  } catch {
    return { ok: false, kind: 'decoding', status: response.status }
  }
}

export async function login(email: string, password: string): Promise<ApiResult<{ user: unknown }>> {
  if (isSample) {
    sampleSignedIn = true
    return sampleRequest({ method: 'POST', path: '/api/auth/login' }) as ApiResult<{ user: unknown }>
  }
  // `client: 'mobile'` asks for a Bearer-transport session in the response body. The
  // server honours it only for a request with no Origin header — which this is.
  const result = await request<{ sessionToken?: string; user?: unknown }>({
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password, client: 'mobile' },
  })
  if (!result.ok) return result
  if (!result.data?.sessionToken || !result.data.user) return { ok: false, kind: 'decoding' }
  setToken(result.data.sessionToken)
  return { ok: true, status: result.status, data: { user: result.data.user } }
}

/** Only a confirmed server-side revocation clears the token; a dropped connection proves nothing. */
export async function logout(): Promise<ApiResult<null>> {
  if (isSample) {
    sampleSignedIn = false
    return { ok: true, status: 200, data: null }
  }
  const result = await request<null>({ method: 'POST', path: '/api/auth/logout', responseType: 'none' })
  if (result.ok || (!result.ok && result.kind === 'unauthorized')) setToken(null)
  return result.ok ? result : result.kind === 'unauthorized' ? { ok: true, status: 200, data: null } : result
}

export function discardSession(): void {
  if (isSample) {
    sampleSignedIn = false
    return
  }
  setToken(null)
}

/**
 * Asks the platform where it lives and moves there if the answer differs — the same
 * thing the iOS app does at launch, including forgetting a stored origin that has
 * stopped answering so one bad edit in Super Admin cannot brick every install.
 */
export async function refreshOrigin(): Promise<void> {
  if (isSample) return
  const ask = async (origin: string): Promise<{ apiBaseUrl?: string; supportUrl?: string; helpCenterUrl?: string; publicBaseUrl?: string } | null> => {
    try {
      const r = await fetch(new URL('/api/platform/origins', origin + '/'), {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) return null
      return await r.json()
    } catch {
      return null
    }
  }
  const https = (v?: string) => (v && /^https:\/\//i.test(v) ? v.replace(/\/+$/, '') : undefined)
  const adopt = (o: NonNullable<Awaited<ReturnType<typeof ask>>>) => {
    const support = https(o.supportUrl) ?? https(o.helpCenterUrl) ?? https(o.publicBaseUrl)
    const api = https(o.apiBaseUrl)
    const s = readSettings()
    writeSettings({
      supportUrl: support ?? s.supportUrl,
      // A server typed in by hand wins over what the default platform says.
      apiOrigin: s.manualOrigin ? s.apiOrigin : api && api !== currentOrigin() ? api : s.apiOrigin,
    })
  }
  const answer = await ask(currentOrigin())
  if (answer) return adopt(answer)
  const s = readSettings()
  if (!s.apiOrigin || s.manualOrigin) return
  writeSettings({ apiOrigin: undefined })
  const fallback = await ask(DEFAULT_ORIGIN)
  if (fallback) adopt(fallback)
}

/** A self-hosted deployment typed in on the sign-in screen. `null` goes back to the default. */
export function setServer(origin: string | null): string {
  if (origin === null || origin.trim() === '') {
    writeSettings({ apiOrigin: undefined, manualOrigin: false })
    return currentOrigin()
  }
  let value = origin.trim()
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('https only')
  writeSettings({ apiOrigin: url.origin, manualOrigin: true })
  return currentOrigin()
}
