import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/ipc'

// Updates come from the public GitHub releases feed named in
// electron-builder.yml (`publish`). electron-updater reads `latest.yml` there,
// downloads the new installer in the background and verifies its sha512
// before anything runs. The installer then replaces the app on the next quit,
// or straight away when the operator chooses "Restart to update".

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15_000

let state: UpdateState = { kind: 'idle' }
let onChange: (s: UpdateState) => void = () => undefined

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
  if (!app.isPackaged) return state
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
  if (state.kind !== 'ready') return
  beforeQuit()
  // Silent, then relaunch: the operator already said yes, a wizard would only ask again.
  autoUpdater.quitAndInstall(true, true)
}

export function startUpdater(changed: (s: UpdateState) => void): void {
  onChange = changed
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ kind: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ kind: 'current', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => set({ kind: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (p) => {
    if (state.kind === 'downloading') set({ ...state, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => set({ kind: 'ready', version: info.version }))
  autoUpdater.on('error', (e) => set({ kind: 'error', message: e?.message ?? String(e) }))
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS)
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
}
