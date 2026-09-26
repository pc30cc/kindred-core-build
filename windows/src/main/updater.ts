import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { DesktopConfig, UpdateState } from '../shared/ipc'

// Updates come from the feed Super Admin → Windows app names (`update.feedUrl`)
// when it is on the build's allow-list (TRUSTED_FEEDS below), falling back to the GitHub releases feed baked in by electron-builder.yml
// (`publish`) when it names none. electron-updater reads `latest.yml` there,
// downloads the new installer in the background and verifies its sha512
// before anything runs. The installer then replaces the app on the next quit,
// or straight away when the operator chooses "Restart to update".

const FIRST_CHECK_MS = 15_000

// The feed URL comes from whatever server the app talks to — and that can be a
// self-hosted address typed in on the sign-in screen. The installers it points
// to run with the operator's rights and are not Authenticode-checked (the build
// is not code-signed yet), so a feed is only used when it is one of the places
// official builds are published. Anything else switches self-update off.

declare const __WEBYAR_UPDATE_FEEDS__: string | undefined

/**
 * Official release feeds, as https URL prefixes. Releases are published to
 * pc30cc/webyar-desktop-releases by .github/workflows/desktop-release.yml (see
 * `publish` in electron-builder.yml); the server's default feed is
 * https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download.
 * More prefixes can be added at build time: WEBYAR_UPDATE_FEEDS="https://a/b/,https://c/".
 */
const BUILT_IN_FEEDS = ['https://github.com/pc30cc/webyar-desktop-releases/']

type FeedPrefix = { host: string; path: string }

function parsePrefix(raw: string): FeedPrefix | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return { host: u.host.toLowerCase(), path: (u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`).toLowerCase() }
  } catch {
    return null
  }
}

const TRUSTED_FEEDS: FeedPrefix[] = [
  ...BUILT_IN_FEEDS,
  ...(typeof __WEBYAR_UPDATE_FEEDS__ === 'string' ? __WEBYAR_UPDATE_FEEDS__.split(',') : []),
]
  .filter((s) => s.trim())
  .map(parsePrefix)
  .filter((p): p is FeedPrefix => p !== null)

/** Whether `url` is https and sits under one of the build's trusted feed prefixes. */
export function isTrustedFeed(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  // Encoded separators could step out of the trusted path once decoded server-side.
  if (/%2f|%5c|%2e|\\/i.test(u.pathname)) return false
  const host = u.host.toLowerCase()
  const path = (u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`).toLowerCase()
  return TRUSTED_FEEDS.some((t) => t.host === host && path.startsWith(t.path))
}

let state: UpdateState = { kind: 'idle' }
let onChange: (s: UpdateState) => void = () => undefined
let enabled = true
let timer: ReturnType<typeof setInterval> | undefined
let appliedFeed: string | null = null
/** False once the server named a feed outside the allow-list: nothing is checked, downloaded or installed. */
let trusted = true
let rejectedFeed: string | null = null

function set(next: UpdateState): void {
  state = next
  onChange(state)
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('app:update-state', state)
}

export function updateState(): UpdateState {
  return state
}

export async function checkForUpdates(): Promise<UpdateState> {
  // A build run from source has no feed to compare against.
  if (!app.isPackaged || !enabled) return state
  if (state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'ready') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return state
}

/** `beforeQuit` lets the caller lift close-to-tray first, or the installer would find the app still running. */
export function installUpdate(beforeQuit: () => void): void {
  if (state.kind !== 'ready' || !trusted) return
  beforeQuit()
  // Silent, then relaunch: the operator already said yes, a wizard would only ask again.
  autoUpdater.quitAndInstall(true, true)
}

/** Applies the platform's update settings; safe to call again whenever they are re-read. */
export function configureUpdater(config: DesktopConfig['update']): void {
  if (!app.isPackaged) return
  if (config.feedUrl && !isTrustedFeed(config.feedUrl)) {
    if (config.feedUrl !== rejectedFeed) console.warn(`[updater] ignoring untrusted update feed ${config.feedUrl}; self-update is off`)
    rejectedFeed = config.feedUrl
    trusted = false
    enabled = false
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    clearInterval(timer)
    return
  }
  trusted = true
  rejectedFeed = null
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  enabled = config.autoUpdate
  if (config.feedUrl && config.feedUrl !== appliedFeed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: config.feedUrl })
    appliedFeed = config.feedUrl
  }
  autoUpdater.channel = config.channel === 'beta' ? 'beta' : 'latest'
  autoUpdater.allowPrerelease = config.channel === 'beta'
  clearInterval(timer)
  if (enabled) timer = setInterval(() => void checkForUpdates(), config.checkIntervalMinutes * 60_000)
}

export function startUpdater(changed: (s: UpdateState) => void, config: DesktopConfig['update']): void {
  onChange = changed
  if (!app.isPackaged) return
  // Sets autoDownload / autoInstallOnAppQuit too — both stay off for an untrusted feed.
  configureUpdater(config)
  autoUpdater.on('checking-for-update', () => set({ kind: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ kind: 'current', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => set({ kind: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (p) => {
    if (state.kind === 'downloading') set({ ...state, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => set({ kind: 'ready', version: info.version }))
  autoUpdater.on('error', (e) => set({ kind: 'error', message: e?.message ?? String(e) }))
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS)
}
