import type { DesktopConfig } from '../shared/ipc'
import { fetchDesktopConfig } from './api'

/** What the app does when the server has not said otherwise (or cannot be reached). */
export const DESKTOP_CONFIG_DEFAULTS: DesktopConfig = {
  update: {
    feedUrl: null,
    channel: 'stable',
    latestVersion: null,
    minimumSupportedVersion: null,
    downloadUrl: null,
    releaseNotes: null,
    autoUpdate: true,
    checkIntervalMinutes: 240,
  },
  realtime: { enabled: true },
  polling: { intervalSeconds: 15, withRealtimeSeconds: 120 },
  features: { calls: true },
}

let current: DesktopConfig = DESKTOP_CONFIG_DEFAULTS

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
const https = (v: unknown) => (typeof v === 'string' && /^https:\/\//i.test(v.trim()) ? v.trim().replace(/\/+$/, '') : null)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Reads whatever the server sent defensively: a bad field falls back on its own, not the whole answer. */
function normalize(raw: Partial<DesktopConfig>): DesktopConfig {
  const d = DESKTOP_CONFIG_DEFAULTS
  const u = (raw.update ?? {}) as Partial<DesktopConfig['update']>
  return {
    update: {
      feedUrl: https(u.feedUrl),
      channel: u.channel === 'beta' ? 'beta' : 'stable',
      latestVersion: text(u.latestVersion),
      minimumSupportedVersion: text(u.minimumSupportedVersion),
      downloadUrl: https(u.downloadUrl),
      releaseNotes: text(u.releaseNotes),
      autoUpdate: typeof u.autoUpdate === 'boolean' ? u.autoUpdate : d.update.autoUpdate,
      checkIntervalMinutes: clamp(u.checkIntervalMinutes, 15, 1440, d.update.checkIntervalMinutes),
    },
    realtime: { enabled: typeof raw.realtime?.enabled === 'boolean' ? raw.realtime.enabled : d.realtime.enabled },
    polling: {
      intervalSeconds: clamp(raw.polling?.intervalSeconds, 5, 300, d.polling.intervalSeconds),
      withRealtimeSeconds: clamp(raw.polling?.withRealtimeSeconds, 15, 900, d.polling.withRealtimeSeconds),
    },
    features: { calls: typeof raw.features?.calls === 'boolean' ? raw.features.calls : d.features.calls },
  }
}

export function desktopConfig(): DesktopConfig {
  return current
}

/** Keeps the last good answer when the server cannot be reached. */
export async function refreshDesktopConfig(): Promise<DesktopConfig> {
  const raw = await fetchDesktopConfig()
  if (raw) current = normalize(raw)
  return current
}
