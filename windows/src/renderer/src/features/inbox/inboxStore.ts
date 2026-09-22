import { create } from 'zustand'
import { api, ApiError, type InboxFilter } from '@/api/client'
import type { Conversation, ConversationStatus, InboxCounts, VisitorProfile } from '@/api/types'
import { attachmentPreview, channelKeyOf, parseDate, preview, systemText } from '@/lib/format'
import type { Language } from '@/i18n'

export interface FieldFilter {
  name: string
  email: string
  subject: string
}

export type Quick = 'all' | 'unread' | 'mine'

interface InboxStore {
  workspaceId: string | null
  filter: InboxFilter
  channel: string | null
  channels: string[]
  search: string
  fields: FieldFilter
  quick: Quick
  state: { kind: 'loading' } | { kind: 'loaded'; conversations: Conversation[] } | { kind: 'failed'; error: ApiError }
  counts: InboxCounts | null
  visitors: Record<string, VisitorProfile>
  refreshedAt: number | null

  setFilter(filter: InboxFilter): void
  setChannel(channel: string | null): void
  setSearch(search: string): void
  setFields(fields: FieldFilter): void
  setQuick(quick: Quick): void
  load(workspaceId: string, { quiet }?: { quiet?: boolean }): Promise<void>
  loadChannels(workspaceId: string): Promise<void>
  patchLocal(id: string, patch: Partial<Conversation>): void
  setStatus(conversation: Conversation, status: ConversationStatus): Promise<boolean>
  claim(conversation: Conversation): Promise<boolean>
  reset(): void
}

let loadToken = 0

export const useInbox = create<InboxStore>((set, get) => ({
  workspaceId: null,
  filter: 'open',
  channel: null,
  channels: [],
  search: '',
  fields: { name: '', email: '', subject: '' },
  quick: 'all',
  state: { kind: 'loading' },
  counts: null,
  visitors: {},
  refreshedAt: null,

  setFilter(filter) {
    set({ filter, channel: null, state: { kind: 'loading' } })
  },
  setChannel(channel) {
    // A channel inbox shows what is open on it.
    set({ channel, filter: 'open', state: { kind: 'loading' } })
  },
  setSearch(search) {
    set({ search })
  },
  setFields(fields) {
    set({ fields })
  },
  setQuick(quick) {
    set({ quick })
  },

  async load(workspaceId, { quiet = false } = {}) {
    const token = ++loadToken
    const filter = get().filter
    if (get().workspaceId !== workspaceId) set({ workspaceId, state: { kind: 'loading' }, visitors: {}, counts: null })
    else if (!quiet && get().state.kind === 'failed') set({ state: { kind: 'loading' } })
    try {
      // The counters are a nicety on top of the list; a failure there must not empty the inbox.
      const counters = api.inboxCounts(workspaceId, 'mine').catch(() => null)
      const conversations = await api.conversations(workspaceId, filter)
      // A fast switch must not let an older, slower answer land on top of a newer one.
      if (token !== loadToken) return
      set({ state: { kind: 'loaded', conversations }, counts: (await counters) ?? get().counts, refreshedAt: Date.now() })
      void loadVisitors(conversations, workspaceId)
    } catch (e) {
      if (token !== loadToken) return
      if (quiet && get().state.kind === 'loaded') return
      set({ state: { kind: 'failed', error: e instanceof ApiError ? e : new ApiError('transport') } })
    }
  },

  async loadChannels(workspaceId) {
    try {
      const channels = await api.channelInboxes(workspaceId)
      set({ channels })
      const current = get().channel
      if (current && !channels.includes(current)) set({ channel: null })
    } catch {
      set({ channels: [] })
    }
  },

  patchLocal(id, patch) {
    const s = get().state
    if (s.kind !== 'loaded') return
    set({ state: { kind: 'loaded', conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) } })
  },

  async setStatus(conversation, status) {
    // Optimistic: the row leaves the queue at once, and comes back if the server says no.
    const previous = get().state
    if (previous.kind === 'loaded') {
      const leaves = !(get().filter === 'resolved' && status === 'resolved')
      set({
        state: {
          kind: 'loaded',
          conversations: leaves
            ? previous.conversations.filter((c) => c.id !== conversation.id)
            : previous.conversations.map((c) => (c.id === conversation.id ? { ...c, status } : c)),
        },
      })
    }
    try {
      await api.updateConversation(conversation.id, conversation.workspace_id, { status })
      return true
    } catch {
      set({ state: previous })
      return false
    }
  },

  async claim(conversation) {
    try {
      await api.claim(conversation.id, conversation.workspace_id)
      const ws = get().workspaceId
      if (ws) void get().load(ws, { quiet: true })
      return true
    } catch {
      return false
    }
  },

  reset() {
    set({ workspaceId: null, state: { kind: 'loading' }, counts: null, visitors: {}, channel: null, channels: [], filter: 'open', search: '' })
  },
}))

async function loadVisitors(conversations: Conversation[], workspaceId: string) {
  if (!conversations.length) return
  try {
    const { byConversation } = await api.visitorIntel(workspaceId, { conversationIds: conversations.map((c) => c.id) })
    // Merged rather than replaced, so switching queue never blanks an avatar for a moment.
    useInbox.setState((s) => ({ visitors: { ...s.visitors, ...byConversation } }))
  } catch {
    // Decorative; the inbox is complete without it.
  }
}

export function lastActivity(c: Conversation): number {
  return (parseDate(c.last_message?.created_at) ?? parseDate(c.updated_at) ?? parseDate(c.created_at))?.getTime() ?? 0
}

/** What the list shows: searched, narrowed by the field filters and the channel, newest first. */
export function visibleConversations(s: Pick<InboxStore, 'state' | 'search' | 'fields' | 'channel' | 'quick'>, me: string | null): Conversation[] {
  if (s.state.kind !== 'loaded') return []
  const q = s.search.trim().toLowerCase()
  const has = (hay: string | null | undefined, needle: string) => {
    const n = needle.trim().toLowerCase()
    return !n || (hay ?? '').toLowerCase().includes(n)
  }
  return s.state.conversations
    .filter((c) => {
      if (q) {
        const hay = [c.contacts?.name, c.contacts?.email, c.contacts?.visitor_code, c.subject, c.last_message?.body, ...(c.tags ?? [])]
        if (!hay.some((h) => h?.toLowerCase().includes(q))) return false
      }
      if (!has(c.contacts?.name, s.fields.name) || !has(c.contacts?.email, s.fields.email) || !has(c.subject, s.fields.subject)) return false
      if (s.channel && channelKeyOf(c.metadata) !== s.channel) return false
      if (s.quick === 'unread' && !(c.unread_count && c.unread_count > 0)) return false
      if (s.quick === 'mine' && (!me || c.assigned_to !== me)) return false
      return true
    })
    .sort((a, b) => lastActivity(b) - lastActivity(a))
}

export function aiStateOf(c: Conversation): 'ai_managed' | 'needs_human' | 'human_active' | null {
  const nested = c.metadata?.ai_state
  const raw = typeof nested === 'string' && nested ? nested : c.ai_state
  return raw === 'ai_managed' || raw === 'needs_human' || raw === 'human_active' ? raw : null
}

export function conversationPreview(c: Conversation, language: Language): string {
  const last = c.last_message
  const sys = systemText(last?.system_meta ?? null, language)
  if (sys) return sys
  if (last?.attachment_kind && !preview(last.body)) {
    return attachmentPreview(last.attachment_kind, last.sender_type === 'agent', last.sender_name ?? c.contacts?.name, language)
  }
  return preview(last?.body) || preview(c.subject)
}
