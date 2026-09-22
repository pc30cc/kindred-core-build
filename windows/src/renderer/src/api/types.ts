// The server is the schema of record. Every type here mirrors a response the
// REST API already returns to the web console and the iOS app, field for
// field, so the three clients cannot disagree about what a conversation is.

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }
export type JSONObject = { [key: string]: JSONValue }

export interface User {
  id: string
  email?: string | null
  fullName?: string | null
  emailVerified?: boolean
  email_confirmed_at?: string | null
}

export interface Workspace {
  id: string
  name: string
  slug: string
  logo_url?: string | null
}

export interface Contact {
  id: string
  workspace_id?: string
  name?: string | null
  email?: string | null
  phone?: string | null
  avatar_url?: string | null
  visitor_code?: string | null
  created_at?: string | null
}

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'closed'
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface ConversationContact {
  name?: string | null
  email?: string | null
  avatar_url?: string | null
  visitor_code?: string | null
}

export interface MessagePreview {
  body?: string | null
  created_at?: string | null
  sender_type?: string | null
  sender_name?: string | null
  attachment_kind?: string | null
  system_kind?: string | null
  system_meta?: JSONObject | null
}

export interface Conversation {
  id: string
  workspace_id: string
  contact_id?: string | null
  subject?: string | null
  status: ConversationStatus
  assigned_to?: string | null
  priority?: ConversationPriority | null
  tags?: string[] | null
  created_at?: string | null
  updated_at?: string | null
  contacts?: ConversationContact | null
  last_message?: MessagePreview | null
  unread_count?: number | null
  ai_state?: string | null
  metadata?: JSONObject | null
}

export type SenderType = 'agent' | 'contact' | 'ai' | 'bot' | 'system'

export interface MessageAttachment {
  id: string
  file_name?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  kind?: string | null
}

export interface Message {
  id: string
  conversation_id: string
  sender_type: SenderType
  sender_id?: string | null
  body: string
  created_at?: string | null
  sender_name?: string | null
  sender_avatar?: string | null
  metadata?: JSONObject | null
  attachments?: MessageAttachment[] | null
}

export interface EffectiveState<T> {
  value?: T | null
  source?: string | null
}

export interface Entitlements {
  workspaceId?: string
  features?: Record<string, EffectiveState<boolean>>
  modules?: Record<string, EffectiveState<boolean>>
  channels?: Record<string, EffectiveState<boolean>>
  limits?: Record<string, EffectiveState<number>>
  plan?: { slug?: string | null; name?: string | null; tier?: string | null } | null
}

export interface InboxCounts {
  open?: number
  pending?: number
  resolved?: number
  all?: number
  needs_human?: number
  automated?: number
}

export interface VisitorProfile {
  geo?: { country_code?: string | null; country?: string | null; city?: string | null } | null
  device?: { browser?: string | null; os?: string | null; device?: string | null } | null
}

export interface MemberProfile {
  id?: string | null
  full_name?: string | null
  email?: string | null
  avatar_url?: string | null
}

export interface WorkspaceMember {
  id: string
  user_id: string
  role?: string | null
  suspended_at?: string | null
  profile?: MemberProfile | null
  department_names?: string[] | null
}

export interface ConversationNote {
  id: string
  body: string
  author_id?: string | null
  author?: MemberProfile | null
  created_at?: string | null
}

export type CallChannel = 'audio' | 'video'

export interface CallInvitation {
  id: string
  status?: string | null
  channel?: string | null
  conversation_id?: string | null
  call_session_id?: string | null
  expires_at?: string | null
}

export interface CallToken {
  token: string
  provider?: string | null
  ws_url?: string | null
  rtc_url?: string | null
  turn?: { urls?: string[] | null; username?: string | null; credential?: string | null } | null
  ice_policy?: string | null
  warnings?: string[] | null
}

export interface AccountProfile {
  id?: string | null
  full_name?: string | null
  avatar_url?: string | null
  preferred_locale?: string | null
}

export interface Account {
  id: string
  email?: string | null
  phone?: string | null
  email_confirmed_at?: string | null
  created_at?: string | null
  profile?: AccountProfile | null
}

export interface AccountSession {
  id: string
  browser?: string | null
  os?: string | null
  device?: string | null
  ip?: string | null
  city?: string | null
  country?: string | null
  country_code?: string | null
  is_current?: boolean | null
  created_at?: string | null
  last_active_at?: string | null
}

export interface AvailabilityPrefs {
  force_offline: boolean
  available_when_using_app: boolean
  schedule_enabled: boolean
  timezone?: string | null
}

export interface AvailabilityResponse {
  prefs: AvailabilityPrefs
  status: { state?: string | null; reason?: string | null }
}

export interface NotificationPrefs {
  disable_all: boolean
  push_scope: 'all' | 'assigned' | 'mentions' | 'none'
  push_preview: boolean
  push_internal_notes: boolean
  play_sound: boolean
  push_when_online: boolean
  push_when_offline: boolean
  quiet_hours_enabled: boolean
  quiet_hours_start?: string | null
  quiet_hours_end?: string | null
  quiet_hours_timezone?: string | null
}

export interface CannedResponse {
  id: string
  shortcut: string
  title: string
  body: string
  locale: string
  usage_count?: number | null
}

export interface Colleague {
  user_id: string
  role?: string | null
  full_name?: string | null
  email?: string | null
  avatar_url?: string | null
  unread?: number | null
  last_message?: { body?: string | null; created_at?: string | null; outgoing?: boolean | null; attachment_kind?: string | null } | null
}

export interface ColleaguesResponse {
  colleagues: Colleague[]
  total_unread?: number | null
  me?: string | null
}

export interface TeamMessage {
  id: string
  sender_id: string
  recipient_id?: string | null
  body?: string | null
  attachment?: MessageAttachment | null
  read_at?: string | null
  created_at?: string | null
}

export interface EmailAddress {
  email: string
}

export interface EmailThreadSummary {
  id: string
  provider?: string | null
  subject?: string | null
  participants?: EmailAddress[] | null
  lastMessageAt?: string | null
  isRead?: boolean | null
  isStarred?: boolean | null
  labels?: string[] | null
  lastMessageSnippet?: string | null
}

export interface EmailAttachmentView {
  id: string
  filename?: string | null
  contentType?: string | null
  sizeBytes?: number | null
  url?: string | null
}

export interface EmailMessageView {
  id: string
  direction?: string | null
  fromAddress?: string | null
  toAddresses?: EmailAddress[] | null
  ccAddresses?: EmailAddress[] | null
  textBody?: string | null
  htmlBody?: string | null
  snippet?: string | null
  isRead?: boolean | null
  deliveryStatus?: string | null
  deliveryError?: string | null
  sentAt?: string | null
  attachments?: EmailAttachmentView[] | null
}

export interface GmailConnection {
  connected?: boolean | null
  emailAddress?: string | null
  status?: string | null
}

export interface PromoCreative {
  title: string
  body: string
  ctaLabel?: string | null
  ctaURL?: string | null
  imageURL?: string | null
}

export interface Promotions {
  enabled: boolean
  banner?: PromoCreative | null
  fullscreen?: PromoCreative | null
  minIntervalMinutes?: number | null
  maxPerDay?: number | null
  startAfterLaunches?: number | null
}

export type AccountDeletion = { kind: 'deleted' } | { kind: 'blocked'; workspaces: string[] }
