import { useEffect } from 'react'
import { api } from '@/api/client'
import type { InboxRealtimeEvent } from '@/api/types'
import { realtimeAllowed, setRealtimeConnected } from './pollBudget'

/**
 * Fired on `window` for every message or operator event in the workspace, so
 * anything that polls (the inbox list, the open thread, the notifier) can
 * refresh at once instead of waiting for its next tick.
 */
export const INBOX_EVENT = 'webyar:inbox'

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000]
/** Renegotiate this long before the connection token expires, as the web console does. */
const REFRESH_LEAD_MS = 120_000
/** How long to wait before asking again when the server says "poll". */
const POLICY_RETRY_MS = 5 * 60_000

/**
 * Subscribes to `ws:<workspace>:inbox` on the workspace's Centrifugo, the
 * channel the web console listens on. Every message in the workspace is
 * published there, visitor or not. When the server runs without realtime the
 * hook quietly does nothing and the pollers carry on alone.
 */
export function useInboxRealtime(workspaceId: string | null): void {
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const seen = new Set<string>()

    const later = (ms: number, intent: 'refresh' | 'reconnect') => {
      clearTimeout(timer)
      timer = setTimeout(() => void open(intent), ms)
    }
    const retry = () => {
      if (cancelled) return
      later(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)] * (0.8 + Math.random() * 0.4), 'reconnect')
    }

    const open = async (intent: 'initial' | 'refresh' | 'reconnect') => {
      if (cancelled) return
      if (!realtimeAllowed()) {
        later(POLICY_RETRY_MS, 'reconnect')
        return
      }
      let url: string, connectToken: string, channel: string, subToken: string, expiresAt: number
      try {
        const conn = await api.realtimeConnect(workspaceId, intent)
        if (conn.vendor !== 'centrifugo' || !conn.ws_url || !conn.token) {
          later(POLICY_RETRY_MS, 'reconnect')
          return
        }
        const sub = await api.realtimeInboxSubscribe(workspaceId)
        if (sub.vendor !== 'centrifugo' || !sub.channel || !sub.token) {
          later(POLICY_RETRY_MS, 'reconnect')
          return
        }
        url = conn.ws_url
        connectToken = conn.token
        channel = sub.channel
        subToken = sub.token
        expiresAt = Math.min(conn.expires_at ?? Infinity, sub.expires_at ?? Infinity)
      } catch {
        retry()
        return
      }
      if (cancelled) return

      ws?.close()
      const socket = new WebSocket(url)
      ws = socket
      let id = 0
      const send = (frame: object) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(frame))

      socket.onopen = () => send({ id: ++id, connect: { token: connectToken, name: 'webyar-desktop' } })
      socket.onmessage = (e) => {
        for (const line of String(e.data).split('\n')) {
          if (!line.trim()) continue
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(line)
          } catch {
            continue
          }
          // An empty frame is Centrifugo's ping; an unanswered ping drops the connection.
          if (Object.keys(frame).length === 0) {
            socket.send('{}')
            continue
          }
          if (frame.error) {
            console.warn('[realtime] error', JSON.stringify(frame.error))
            socket.close()
            return
          }
          if (frame.id === 1 && frame.connect) {
            send({ id: ++id, subscribe: { channel, token: subToken } })
            continue
          }
          if (frame.id === 2 && frame.subscribe) {
            attempt = 0
            setRealtimeConnected(true)
            console.warn('[realtime] subscribed', channel)
            if (Number.isFinite(expiresAt)) later(Math.max(10_000, expiresAt - Date.now() - REFRESH_LEAD_MS), 'refresh')
            continue
          }
          const push = frame.push as { channel?: string; pub?: { data?: InboxRealtimeEvent }; disconnect?: unknown } | undefined
          if (push?.disconnect) {
            socket.close()
            return
          }
          const event = push?.pub?.data
          if (!event?.type) continue
          // A resubscribe can replay recent publications.
          if (event.type === 'message') {
            if (seen.has(event.payload.id)) continue
            seen.add(event.payload.id)
            if (seen.size > 500) seen.clear()
          }
          window.dispatchEvent(new CustomEvent(INBOX_EVENT, { detail: event }))
        }
      }
      socket.onclose = () => {
        if (ws !== socket || cancelled) return
        ws = null
        setRealtimeConnected(false)
        console.warn('[realtime] closed')
        retry()
      }
    }

    void open('initial')
    return () => {
      cancelled = true
      clearTimeout(timer)
      setRealtimeConnected(false)
      ws?.close()
      ws = null
    }
  }, [workspaceId])
}
