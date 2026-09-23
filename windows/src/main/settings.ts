import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopSettings } from '../shared/ipc'

export interface StoredSettings extends DesktopSettings {
  apiOrigin?: string
  /** Set when the operator typed a server in, so the platform's answer does not override it. */
  manualOrigin?: boolean
  supportUrl?: string
  bounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean }
}

const DEFAULTS: StoredSettings = {
  openAtLogin: false,
  closeToTray: true,
  desktopNotifications: true,
  notificationSound: true,
}

let cache: StoredSettings | null = null

function file(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

export function readSettings(): StoredSettings {
  if (cache) return cache
  try {
    const path = file()
    cache = existsSync(path) ? { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) } : { ...DEFAULTS }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache!
}

export function writeSettings(patch: Partial<StoredSettings>): StoredSettings {
  const next = { ...readSettings(), ...patch }
  for (const key of Object.keys(next) as (keyof StoredSettings)[]) {
    if (next[key] === undefined) delete next[key]
  }
  cache = next
  try {
    writeFileSync(file(), JSON.stringify(next, null, 2))
  } catch {
    // A settings file we cannot write is not worth crashing over.
  }
  return next
}

export function publicSettings(): DesktopSettings {
  const s = readSettings()
  return {
    openAtLogin: s.openAtLogin,
    closeToTray: s.closeToTray,
    desktopNotifications: s.desktopNotifications,
    notificationSound: s.notificationSound,
  }
}
