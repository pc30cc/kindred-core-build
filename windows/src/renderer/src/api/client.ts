import type { ApiRequest, ApiResult } from '../../../shared/ipc'
import type {
  Account,
  AccountDeletion,
  AccountProfile,
  AccountSession,
  AvailabilityPrefs,
  AvailabilityResponse,
  CallChannel,
  CallInvitation,
  CallToken,
  CannedResponse,
  ColleaguesResponse,
  Contact,
  Conversation,
  ConversationNote,
  ConversationPriority,
  ConversationStatus,
  EmailMessageView,
  EmailThreadSummary,
  Entitlements,
  GmailConnection,
  InboxCounts,
  Message,
  NotificationPrefs,
  Promotions,
  TeamMessage,
  User,
  VisitorProfile,
  Workspace,
  WorkspaceMember,
} from './types'

/** Every way a request can fail, in the terms the UI reacts to — the same four the iOS app has. */
export class ApiError extends Error {
  constructor(
    readonly kind: 'unauthorized' | 'transport' | 'server' | 'decoding',
    readonly status?: number,
    readonly serverMessage?: string,
    readonly body?: unknown,
  ) {
    super(serverMessage ?? kind)
  }

  /** 501: the deployment does not carry this feature, and a retry can never succeed. */
  get isFeatureMissing(): boolean {
    return this.kind === 'server' && this.status === 501
  }
}

/** Called for every 401, wherever it comes from. The app state signs the operator out. */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

async function call<T>(req: ApiRequest, { signOutOn401 = true } = {}): Promise<T> {
  const result = (await window.webyar.api.request<T>(req)) as ApiResult<T>
  if (result.ok) return result.data
  if (result.kind === 'unauthorized' && signOutOn401) onUnauthorized?.()
  throw new ApiError(result.kind, result.status, result.message, result.body)
}

const get = <T>(path: string, query?: ApiRequest['query']) => call<T>({ method: 'GET', path, query })
const send = (method: ApiRequest['method'], path: string, body?: unknown, query?: ApiRequest['query']) =>
  call<null>({ method, path, body, query, responseType: 'none' })
const post = <T>(path: string, body?: unknown) => call<T>({ method: 'POST', path, body })

export type InboxFilter = 'open' | 'needsHuman' | 'pending' | 'ai' | 'resolved' | 'spam'

function queueOf(filter: InboxFilter): { queue: string; status?: string; needsHuman?: string } {
  switch (filter) {
    case 'open':
      return { queue: 'main', status: 'open' }
    case 'needsHuman':
      return { queue: 'main', status: 'open', needsHuman: 'true' }
    case 'pending':
      return { queue: 'main', status: 'pending' }
    case 'resolved':
      return { queue: 'main', status: 'resolved' }
    case 'ai':
      return { queue: 'automated' }
    case 'spam':
      return { queue: 'spam' }
  }
}

export function newClientMessageId(): string {
  return crypto.randomUUID()
}

export const api = {
  // Session
  async login(email: string, password: string): Promise<User> {
    const result = await window.webyar.api.login(email, password)
    if (!result.ok) throw new ApiError(result.kind, result.status, result.message, result.body)
    return result.data.user as User
  },
  async currentUser(): Promise<User> {
    const r = await call<{ user?: User }>({ method: 'GET', path: '/api/auth/session' }, { signOutOn401: false })
    if (!r.user) throw new ApiError('unauthorized', 401)
    return r.user
  },
  async logout(): Promise<void> {
    const result = await window.webyar.api.logout()
    if (!result.ok) throw new ApiError(result.kind, result.status, result.message)
  },
  discardSession: () => window.webyar.api.discardSession(),
  hasToken: () => window.webyar.api.hasToken(),
  refreshOrigin: () => window.webyar.api.refreshOrigin(),
  requestPasswordReset: (email: string, locale: string) =>
    call<null>({ method: 'POST', path: '/api/auth-email/send-reset', body: { email, locale }, responseType: 'none' }, { signOutOn401: false }),

  // Workspaces and plan
  workspaces: async () => (await get<{ workspaces: Workspace[] }>('/api/workspaces')).workspaces,
  entitlements: (workspaceId: string) => get<Entitlements>(`/api/plans/workspace/${workspaceId}/effective`),

  // Conversations
  async conversations(workspaceId: string, filter: InboxFilter): Promise<Conversation[]> {
    const q = queueOf(filter)
    return (await get<{ conversations: Conversation[] }>('/api/conversations', { workspace_id: workspaceId, ...q })).conversations
  },
  inboxCounts: (workspaceId: string, scope = 'mine') =>
    get<InboxCounts>('/api/conversations/inbox-tab-counts', { workspace_id: workspaceId, scope }),
  messages: async (conversationId: string) =>
    (await get<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages`)).messages,
  sendMessage: (p: { conversationId: string; workspaceId: string; body: string; attachmentId?: string | null; clientMessageId?: string }) =>
    send('POST', '/api/conversations/send-message', {
      conversation_id: p.conversationId,
      workspace_id: p.workspaceId,
      body: p.body,
      // The server collapses a replay of the same key, which is what makes a retry safe.
      client_message_id: p.clientMessageId ?? newClientMessageId(),
      attachment_id: p.attachmentId ?? null,
    }),
  markSeen: (conversationId: string) => send('POST', `/api/conversations/${conversationId}/seen`),
  updateConversation(
    conversationId: string,
    workspaceId: string,
    patch: { status?: ConversationStatus; priority?: ConversationPriority; assigned_to?: string | null; tags?: string[] },
  ) {
    // Omitted keys are left alone; an explicit `assigned_to: null` unassigns.
    return send('PATCH', `/api/conversations/${conversationId}`, { workspace_id: workspaceId, ...patch })
  },
  claim: (conversationId: string, workspaceId: string) =>
    send('POST', `/api/conversations/${conversationId}/claim`, { workspace_id: workspaceId }),
  async takeOver(conversationId: string, workspaceId: string): Promise<void> {
    const body = { workspaceId, assign_to_me: true }
    try {
      await send('POST', `/api/conversations/${conversationId}/take-over`, body)
    } catch (e) {
      // Older deployments answer only the AI-agent route. A 404 is the one error worth a second try.
      if (e instanceof ApiError && e.kind === 'server' && e.status === 404) {
        await send('POST', `/api/ai-agent/conversations/${conversationId}/take-over`, body)
      } else throw e
    }
  },
  aiSayNow: (conversationId: string, body: string, voice: 'specialist' | 'assistant') =>
    send('POST', `/api/ai-agent/conversations/${conversationId}/ai-say-now`, { body, attribution: voice }),
  workspaceMembers: async (workspaceId: string) =>
    (await get<{ members: WorkspaceMember[] }>('/api/workspace-members', { workspaceId })).members,
  notes: async (conversationId: string, workspaceId: string) =>
    (await get<{ notes: ConversationNote[] }>(`/api/conversations/${conversationId}/notes`, { workspace_id: workspaceId })).notes,
  addNote: (conversationId: string, workspaceId: string, body: string) =>
    send('POST', `/api/conversations/${conversationId}/notes`, { workspace_id: workspaceId, body }),
  deleteNote: (conversationId: string, workspaceId: string, noteId: string) =>
    send('DELETE', `/api/conversations/${conversationId}/notes/${noteId}`, undefined, { workspace_id: workspaceId }),

  // Visitor intelligence — decorative; callers treat a failure as "no extra detail".
  async visitorIntel(workspaceId: string, ids: { conversationIds?: string[]; contactIds?: string[] }) {
    const conversation_ids = ids.conversationIds ? [...new Set(ids.conversationIds.filter(Boolean))].slice(0, 500) : undefined
    const contact_ids = ids.contactIds ? [...new Set(ids.contactIds.filter(Boolean))].slice(0, 500) : undefined
    if (!conversation_ids?.length && !contact_ids?.length) return { byConversation: {}, byContact: {} }
    const r = await post<{ by_conversation?: Record<string, VisitorProfile>; by_contact?: Record<string, VisitorProfile> }>(
      '/api/visitor-intel/network/batch',
      { workspace_id: workspaceId, conversation_ids, contact_ids },
    )
    return { byConversation: r.by_conversation ?? {}, byContact: r.by_contact ?? {} }
  },

  // Attachments: reserve, upload, then reference. A client never learns a storage URL.
  async uploadAttachment(p: { workspaceId: string; conversationId: string | null; fileName: string; mimeType: string; data: Uint8Array }): Promise<string> {
    const reserve = await post<{ attachment_id: string }>('/api/conversation-attachments/init', {
      workspace_id: p.workspaceId,
      conversation_id: p.conversationId,
      file_name: p.fileName,
      mime_type: p.mimeType,
      size_bytes: p.data.byteLength,
    })
    await send('POST', `/api/conversation-attachments/${reserve.attachment_id}/upload`, {
      workspace_id: p.workspaceId,
      data: toBase64(p.data),
    })
    return reserve.attachment_id
  },
  attachmentData: (id: string) =>
    call<Uint8Array>({ method: 'GET', path: `/api/conversation-attachments/${encodeURIComponent(id)}/file`, responseType: 'bytes' }),

  // Calls on a conversation
  inviteToCall: async (conversationId: string, workspaceId: string, channel: CallChannel) =>
    (await post<{ invitation: CallInvitation }>('/api/call-invitations', { workspace_id: workspaceId, conversation_id: conversationId, channel })).invitation,
  cancelInvitation: (id: string) => send('POST', `/api/call-invitations/${id}/cancel`),
  invitation: async (id: string) => (await get<{ invitation: CallInvitation }>(`/api/call-invitations/${id}`)).invitation,
  callToken: (callSessionId: string, displayName?: string | null) =>
    post<CallToken>(`/api/calls/${callSessionId}/token`, { participant_type: 'operator', display_name: displayName ?? null }),
  hangUp: (callSessionId: string) => send('POST', `/api/calls/${callSessionId}/hangup`),

  // Email inbox — a real mailbox on its own `/api/email-inbox` surface.
  emailThreads: async (workspaceId: string, search?: string) =>
    (await get<{ threads: EmailThreadSummary[] }>(`/api/email-inbox/${workspaceId}/threads`, { limit: 50, q: search || undefined })).threads,
  emailThread: (workspaceId: string, threadId: string) =>
    get<{ thread: EmailThreadSummary; messages: EmailMessageView[] }>(`/api/email-inbox/${workspaceId}/threads/${threadId}`),
  setEmailRead: (workspaceId: string, threadId: string, isRead: boolean) =>
    send('POST', `/api/email-inbox/${workspaceId}/threads/${threadId}/read`, { is_read: isRead }),
  setEmailStarred: (workspaceId: string, threadId: string, starred: boolean) =>
    send('POST', `/api/email-inbox/${workspaceId}/threads/${threadId}/star`, { starred }),
  sendEmail: (workspaceId: string, p: { threadId?: string | null; to: string[]; subject: string; body: string }) =>
    send('POST', `/api/email-inbox/${workspaceId}/send`, { thread_id: p.threadId ?? null, to: p.to, subject: p.subject, text_body: p.body }),
  gmailConnection: async (workspaceId: string) =>
    (await get<{ connection?: GmailConnection | null }>('/api/plugins/gmail/connection', { workspace_id: workspaceId })).connection ?? null,

  // Channel inboxes the workspace has installed — Telegram, Bale and the rest.
  async channelInboxes(workspaceId: string): Promise<string[]> {
    const r = await get<{ items?: { slug?: string; installed?: boolean; supportsInbox?: boolean; planAllowed?: boolean }[] }>(
      '/api/plugins/catalog',
      { workspace_id: workspaceId },
    )
    return (r.items ?? [])
      .filter((i) => i.installed === true && i.supportsInbox === true && i.planAllowed !== false && i.slug)
      .map((i) => i.slug!)
  },

  // Colleagues — operator-to-operator messages.
  colleagues: (workspaceId: string) => get<ColleaguesResponse>('/api/team-chat/colleagues', { workspace_id: workspaceId }),
  teamThread: (workspaceId: string, peerId: string) =>
    get<{ messages: TeamMessage[]; me?: string | null }>('/api/team-chat/thread', { workspace_id: workspaceId, peer_id: peerId }),
  sendTeamMessage: (workspaceId: string, recipientId: string, body: string, attachmentId?: string | null) =>
    send('POST', '/api/team-chat/messages', { workspace_id: workspaceId, recipient_id: recipientId, body, attachment_id: attachmentId ?? null }),
  markTeamRead: (workspaceId: string, peerId: string) =>
    send('POST', '/api/team-chat/read', { workspace_id: workspaceId, peer_id: peerId }),

  // Saved replies, shared across the workspace.
  cannedResponses: async (workspaceId: string, locale: string, query: string) =>
    (await get<{ items: CannedResponse[] }>('/api/canned-responses', { workspace_id: workspaceId, locale, limit: 50, q: query.trim() || undefined })).items,
  trackCannedUse: (id: string, workspaceId: string) =>
    send('POST', `/api/canned-responses/${id}/track-use`, { workspace_id: workspaceId }),

  // Availability
  availability: () => get<AvailabilityResponse>('/api/availability'),
  updateAvailability: (change: Partial<Pick<AvailabilityPrefs, 'force_offline' | 'available_when_using_app' | 'schedule_enabled'>>) =>
    call<AvailabilityResponse>({ method: 'PATCH', path: '/api/availability', body: change }),

  promotions: (workspaceId: string, locale: string) =>
    get<Promotions>('/api/mobile-app/promotions', { workspace_id: workspaceId, locale }),

  contacts: async (workspaceId: string) => (await get<{ contacts: Contact[] }>('/api/contacts', { workspace_id: workspaceId })).contacts,

  // Account
  account: () => get<Account>('/api/account/me'),
  async updateProfile(fullName: string | null, preferredLocale: string | null): Promise<Account> {
    await send('PATCH', '/api/account/me', { full_name: fullName, preferred_locale: preferredLocale })
    return api.account()
  },
  uploadAvatar: async (data: Uint8Array, contentType: string, fileName: string | null) =>
    (await post<{ profile?: AccountProfile | null }>('/api/account/avatar', { data: toBase64(data), contentType, fileName })).profile ?? null,
  deleteAvatar: () => send('DELETE', '/api/account/avatar'),
  sessions: () => get<{ sessions: AccountSession[]; current_session_id?: string | null }>('/api/account/security/sessions'),
  revokeSession: (id: string) => send('DELETE', `/api/account/security/sessions/${id}`),
  changePassword: (currentPassword: string, newPassword: string) =>
    send('POST', '/api/account/change-password', { currentPassword, newPassword }),
  async deleteAccount(password: string): Promise<AccountDeletion> {
    try {
      await call<null>({ method: 'DELETE', path: '/api/account', body: { password }, responseType: 'none' }, { signOutOn401: false })
      return { kind: 'deleted' }
    } catch (e) {
      // "You still own these workspaces" arrives as a 409 with a list — an answer, not an error.
      const body = e instanceof ApiError ? (e.body as { error?: string; workspaces?: string[] } | undefined) : undefined
      if (e instanceof ApiError && e.status === 409 && body?.error === 'owns_workspaces') {
        return { kind: 'blocked', workspaces: body.workspaces ?? [] }
      }
      throw e
    }
  },

  // Notification preferences. The desktop app is a desk surface, so it reads and writes
  // the same row the web console does rather than the phone's.
  notificationPrefs: async () =>
    (await get<{ prefs: NotificationPrefs }>('/api/notifications/prefs', { platform: 'web' })).prefs,
  updateNotificationPrefs: async (prefs: Partial<NotificationPrefs>) =>
    (await call<{ prefs: NotificationPrefs }>({ method: 'PATCH', path: '/api/notifications/prefs', body: { ...prefs, platform: 'web' } })).prefs,
}

function toBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(binary)
}
