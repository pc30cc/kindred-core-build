import type { DesktopConfig } from '../../../../shared/ipc'

// How hard the app may poll, from Super Admin → Windows app. While the
// realtime inbox channel is connected every change already arrives as an
// event, so the pollers drop to a slow safety net instead of asking the API
// every few seconds; they speed back up the moment the socket is gone.

let config: DesktopConfig | null = null
let connected = false

export function setDesktopConfig(next: DesktopConfig): void {
  config = next
}

export function realtimeAllowed(): boolean {
  return config?.realtime.enabled ?? true
}

export function setRealtimeConnected(value: boolean): void {
  connected = value
}

/** The interval for a poller whose normal cadence is `baseMs`. */
export function pollInterval(baseMs: number): () => number {
  return () => (connected ? (config?.polling.withRealtimeSeconds ?? 120) * 1000 : baseMs)
}
