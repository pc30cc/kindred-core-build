import type { ApiRequest, ApiResult } from '../shared/ipc'

// An in-memory backend for laying out and screenshotting screens that
// otherwise need a live account — the desktop twin of the iOS SampleAPI.
// Reached only when the process is started with WEBYAR_SAMPLE=1; nothing a
// user can click, type or receive from a server turns it on.

const now = Date.now()
let seq = 1000
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

const me = { id: 'u-me', email: 'sara@webyar.ai', fullName: 'Sara Ahmadi', emailVerified: true }
const ws = { id: 'ws-1', name: 'Webyar Store', slug: 'webyar-store', logo_url: null }

type Msg = {
  id: string
  conversation_id: string
  sender_type: string
  sender_id: string | null
  body: string
  created_at: string
  sender_name: string | null
  sender_avatar: string | null
  metadata?: Record<string, unknown>
  attachments?: unknown[]
}

const contacts = [
  { id: 'c1', name: 'Ali Rezaei', email: 'ali@example.com', phone: '+98 912 000 1122', visitor_code: 'V-4821', created_at: ago(60 * 24 * 12) },
  { id: 'c2', name: 'Maryam Karimi', email: 'maryam.k@example.com', phone: null, visitor_code: 'V-1180', created_at: ago(60 * 24 * 3) },
  { id: 'c3', name: null, email: null, phone: null, visitor_code: 'V-9034', created_at: ago(90) },
  { id: 'c4', name: 'John Carter', email: 'john@carter.io', phone: '+1 415 555 0142', visitor_code: 'V-2207', created_at: ago(60 * 24 * 40) },
  { id: 'c5', name: 'Elif Yılmaz', email: 'elif@ornek.com.tr', phone: null, visitor_code: 'V-7710', created_at: ago(60 * 24 * 2) },
  { id: 'c6', name: 'Reza Moradi', email: 'reza.m@example.com', phone: '+98 935 111 2233', visitor_code: 'V-3391', created_at: ago(60 * 24 * 80) },
]

const conversations = [
  { id: 'cv1', contact: 0, status: 'open', priority: 'urgent', assigned_to: 'u-me', unread: 2, ai: 'human_active', tags: ['billing', 'vip'], channel: 'widget', last: 'سلام، سفارش من هنوز نرسیده. می‌تونید پیگیری کنید؟', lastAt: ago(3) },
  { id: 'cv2', contact: 1, status: 'open', priority: 'high', assigned_to: null, unread: 1, ai: 'ai_managed', tags: [], channel: 'telegram', last: 'Is there a discount for annual plans?', lastAt: ago(18) },
  { id: 'cv3', contact: 2, status: 'open', priority: 'normal', assigned_to: null, unread: 0, ai: 'needs_human', tags: ['shipping'], channel: 'widget', last: 'ممنون از راهنمایی‌تون 🙏', lastAt: ago(52) },
  { id: 'cv4', contact: 3, status: 'pending', priority: 'normal', assigned_to: 'u-2', unread: 0, ai: null, tags: [], channel: 'whatsapp', last: 'I will send the invoice number shortly.', lastAt: ago(60 * 5) },
  { id: 'cv5', contact: 4, status: 'open', priority: 'low', assigned_to: 'u-me', unread: 0, ai: null, tags: ['onboarding'], channel: 'widget', last: 'Kurulum tamamlandı, teşekkürler!', lastAt: ago(60 * 26) },
  { id: 'cv6', contact: 5, status: 'resolved', priority: 'normal', assigned_to: 'u-me', unread: 0, ai: null, tags: [], channel: 'bale', last: 'مشکل حل شد، ممنون.', lastAt: ago(60 * 24 * 3) },
]

const messages: Record<string, Msg[]> = {
  cv1: [
    m('cv1', 'contact', 'سلام وقت بخیر', 60 * 26),
    m('cv1', 'ai', 'سلام! به فروشگاه وب‌یار خوش آمدید. چطور می‌توانم کمکتان کنم؟', 60 * 26 - 1),
    m('cv1', 'contact', 'سفارشم رو سه روز پیش ثبت کردم، کد پیگیری ۸۴۲۱۹', 60 * 26 - 2),
    { ...m('cv1', 'system', 'Sara Ahmadi joined the conversation', 60 * 25), metadata: { kind: 'routing_agent_joined', agent_name: 'سارا احمدی' } },
    m('cv1', 'agent', 'سلام علی جان، سارا هستم از پشتیبانی. همین الان بررسی می‌کنم.', 60 * 25 - 1, 'Sara Ahmadi'),
    m('cv1', 'agent', 'بسته امروز صبح از انبار خارج شده و تا فردا به دستتون می‌رسه.', 12, 'Sara Ahmadi'),
    m('cv1', 'contact', 'عالیه، مرسی 🙏', 6),
    m('cv1', 'contact', 'سلام، سفارش من هنوز نرسیده. می‌تونید پیگیری کنید؟', 3),
  ],
  cv2: [
    m('cv2', 'contact', 'Hi! I am comparing your plans.', 40),
    m('cv2', 'ai', 'Hello Maryam! Happy to help. We offer Starter, Growth and Scale plans — which features matter most to you?', 39),
    m('cv2', 'contact', 'Mostly the AI agent and the call widget.', 30),
    m('cv2', 'ai', 'Both are included from the Growth plan. Would you like a comparison table?', 29),
    m('cv2', 'contact', 'Is there a discount for annual plans?', 18),
  ],
  cv3: [
    m('cv3', 'contact', 'هزینه ارسال به شیراز چقدره؟', 70),
    m('cv3', 'agent', 'برای شیراز ارسال پیشتاز ۴۵ هزار تومان و زمان تحویل ۲ روز کاری است.', 60, 'Sara Ahmadi'),
    m('cv3', 'contact', 'ممنون از راهنمایی‌تون 🙏', 52),
  ],
  cv4: [
    m('cv4', 'contact', 'Hello, I was charged twice this month.', 60 * 6),
    m('cv4', 'agent', 'Sorry about that, John. Could you share the invoice number?', 60 * 5 + 10, 'Nima Jafari'),
    m('cv4', 'contact', 'I will send the invoice number shortly.', 60 * 5),
  ],
  cv5: [
    m('cv5', 'contact', 'Widget kurulumunda yardıma ihtiyacım var.', 60 * 28),
    m('cv5', 'agent', 'Tabii! Kodu sitenizin </body> etiketinden önce ekleyin.', 60 * 27, 'Sara Ahmadi'),
    m('cv5', 'contact', 'Kurulum tamamlandı, teşekkürler!', 60 * 26),
  ],
  cv6: [
    m('cv6', 'contact', 'پرداخت انجام نمی‌شه', 60 * 24 * 3 + 30),
    m('cv6', 'agent', 'درگاه دوباره فعال شد، لطفاً مجدد امتحان کنید.', 60 * 24 * 3 + 10, 'Sara Ahmadi'),
    m('cv6', 'contact', 'مشکل حل شد، ممنون.', 60 * 24 * 3),
  ],
}

function m(conv: string, type: string, body: string, minutesAgo: number, name: string | null = null): Msg {
  return {
    id: `m${seq++}`,
    conversation_id: conv,
    sender_type: type,
    sender_id: type === 'agent' ? 'u-me' : null,
    body,
    created_at: ago(minutesAgo),
    sender_name: name,
    sender_avatar: null,
  }
}

function conversationRow(c: (typeof conversations)[number]) {
  const contact = contacts[c.contact]
  return {
    id: c.id,
    workspace_id: ws.id,
    contact_id: contact.id,
    subject: null,
    status: c.status,
    priority: c.priority,
    assigned_to: c.assigned_to,
    tags: c.tags,
    created_at: ago(60 * 24 * 5),
    updated_at: c.lastAt,
    contacts: { name: contact.name, email: contact.email, avatar_url: null, visitor_code: contact.visitor_code },
    last_message: { body: c.last, created_at: c.lastAt, sender_type: 'contact' },
    unread_count: c.unread,
    ai_state: c.ai,
    metadata: { channel: c.channel, ai_state: c.ai },
  }
}

const visitors: Record<string, unknown> = {
  cv1: { geo: { country_code: 'IR', country: 'Iran', city: 'Tehran' }, device: { os: 'Android', browser: 'Chrome', device: 'Mobile' } },
  cv2: { geo: { country_code: 'AE', country: 'United Arab Emirates', city: 'Dubai' }, device: { os: 'iOS', browser: 'Safari', device: 'Mobile' } },
  cv3: { geo: { country_code: 'IR', country: 'Iran', city: 'Shiraz' }, device: { os: 'Windows', browser: 'Edge', device: 'Desktop' } },
  cv4: { geo: { country_code: 'US', country: 'United States', city: 'San Francisco' }, device: { os: 'macOS', browser: 'Chrome', device: 'Desktop' } },
  cv5: { geo: { country_code: 'TR', country: 'Türkiye', city: 'Istanbul' }, device: { os: 'Windows', browser: 'Chrome', device: 'Desktop' } },
  cv6: { geo: { country_code: 'IR', country: 'Iran', city: 'Mashhad' }, device: { os: 'Linux', browser: 'Firefox', device: 'Desktop' } },
}

const members = [
  { id: 'wm1', user_id: 'u-me', role: 'owner', suspended_at: null, profile: { id: 'u-me', full_name: 'Sara Ahmadi', email: 'sara@webyar.ai', avatar_url: null }, department_names: ['Support'] },
  { id: 'wm2', user_id: 'u-2', role: 'agent', suspended_at: null, profile: { id: 'u-2', full_name: 'Nima Jafari', email: 'nima@webyar.ai', avatar_url: null }, department_names: ['Billing'] },
  { id: 'wm3', user_id: 'u-3', role: 'admin', suspended_at: null, profile: { id: 'u-3', full_name: 'Leila Hosseini', email: 'leila@webyar.ai', avatar_url: null }, department_names: ['Sales'] },
]

const notes: Record<string, unknown[]> = {
  cv1: [{ id: 'n1', body: 'مشتری VIP — در صورت تأخیر کد تخفیف ۱۰٪ بدهید.', author_id: 'u-3', author: members[2].profile, created_at: ago(60 * 24) }],
}

const team: Record<string, unknown[]> = {
  'u-2': [
    { id: 't1', sender_id: 'u-2', recipient_id: 'u-me', body: 'سارا، مشتری John Carter رو می‌تونی ببینی؟ پرداخت تکراری داشته.', created_at: ago(45), read_at: null },
    { id: 't2', sender_id: 'u-me', recipient_id: 'u-2', body: 'حتماً، الان چک می‌کنم.', created_at: ago(40), read_at: ago(39) },
    { id: 't3', sender_id: 'u-2', recipient_id: 'u-me', body: 'مرسی 🙌', created_at: ago(38), read_at: null },
  ],
  'u-3': [{ id: 't4', sender_id: 'u-3', recipient_id: 'u-me', body: 'Weekly report is ready in the dashboard.', created_at: ago(60 * 20), read_at: ago(60 * 19) }],
}

const emailThreads = [
  { id: 'e1', provider: 'gmail', subject: 'Partnership proposal — Q4', participants: [{ email: 'support@webyar.ai' }, { email: 'partners@acme.com' }], lastMessageAt: ago(35), isRead: false, isStarred: true, labels: ['INBOX'], lastMessageSnippet: 'Hi team, following our call last week we would like to propose…' },
  { id: 'e2', provider: 'gmail', subject: 'فاکتور شماره ۱۴۰۳-۲۲۱', participants: [{ email: 'support@webyar.ai' }, { email: 'finance@example.ir' }], lastMessageAt: ago(60 * 7), isRead: true, isStarred: false, labels: ['INBOX'], lastMessageSnippet: 'با سلام، فاکتور پیوست ارسال شد. لطفاً بررسی بفرمایید.' },
  { id: 'e3', provider: 'gmail', subject: 'Your weekly analytics digest', participants: [{ email: 'support@webyar.ai' }, { email: 'digest@analytics.io' }], lastMessageAt: ago(60 * 30), isRead: true, isStarred: false, labels: ['INBOX'], lastMessageSnippet: 'Visitors up 18% week over week. Top page: /pricing…' },
]

const entitlements = {
  workspaceId: ws.id,
  plan: { slug: 'growth', name: 'Growth', tier: 'growth' },
  modules: { contacts: { value: true }, voice_video: { value: true }, email_inbox: { value: true } },
  features: {
    inbox_needs_human: { value: true },
    inbox_ai_queue: { value: true },
    inbox_team_chat: { value: true },
    widget_attachments: { value: true },
    widget_voice_notes: { value: true },
    widget_emoji: { value: true },
    mobile_promo_banner: { value: false },
  },
  // Only a key that is exactly true is on, so the channel inboxes the sample lays out are listed too.
  channels: {
    chat_widget: { value: true }, voice: { value: true }, video: { value: true },
    telegram: { value: true }, whatsapp: { value: true }, bale: { value: true },
  },
  limits: {},
}

let prefs: Record<string, unknown> = {
  disable_all: false, push_scope: 'all', push_preview: true, push_internal_notes: true, play_sound: true,
  push_when_online: true, push_when_offline: true, quiet_hours_enabled: false, quiet_hours_start: '22:00', quiet_hours_end: '08:00',
}
let availability = { prefs: { force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'Asia/Tehran' }, status: { state: 'online', reason: 'app' } }

function ok(data: unknown): ApiResult {
  return { ok: true, status: 200, data }
}

export function sampleRequest(req: ApiRequest): ApiResult {
  const { method, path } = req
  const q = req.query ?? {}
  const body = (req.body ?? {}) as Record<string, unknown>
  let match: RegExpMatchArray | null

  if (path === '/api/auth/login' || path === '/api/auth/session') return ok({ user: me, sessionToken: 'sample' })
  if (path === '/api/workspaces') return ok({ workspaces: [ws, { id: 'ws-2', name: 'Kindred Agency', slug: 'kindred', logo_url: null }] })
  if (path.startsWith('/api/plans/workspace/')) return ok(entitlements)
  if (path === '/api/account/me' && method === 'GET') return ok({ id: me.id, email: me.email, phone: null, email_confirmed_at: ago(99999), created_at: ago(99999), profile: { id: me.id, full_name: me.fullName, avatar_url: null, preferred_locale: 'fa' } })
  if (path === '/api/conversations/inbox-tab-counts') return ok({ open: 4, pending: 1, resolved: 12, all: 17, needs_human: 1, automated: 1 })
  if (path === '/api/conversations' && method === 'GET') {
    const status = q.status as string | undefined
    const queue = q.queue as string
    let list = conversations
    if (queue === 'automated') list = list.filter((c) => c.ai === 'ai_managed')
    else if (queue === 'spam') list = []
    else if (status) list = list.filter((c) => c.status === status)
    if (q.needsHuman) list = list.filter((c) => c.ai === 'needs_human')
    return ok({ conversations: list.map(conversationRow) })
  }
  if ((match = path.match(/^\/api\/conversations\/([^/]+)\/messages$/))) return ok({ messages: messages[match[1]] ?? [] })
  if (path === '/api/conversations/send-message') {
    const conv = String(body.conversation_id)
    ;(messages[conv] ??= []).push(m(conv, 'agent', String(body.body ?? ''), 0, me.fullName))
    const row = conversations.find((c) => c.id === conv)
    if (row) {
      row.last = String(body.body ?? '')
      row.lastAt = new Date().toISOString()
    }
    return ok({ ok: true })
  }
  if ((match = path.match(/^\/api\/conversations\/([^/]+)\/notes$/))) {
    if (method === 'POST') (notes[match[1]] ??= []).push({ id: `n${seq++}`, body: body.body, author_id: me.id, author: members[0].profile, created_at: new Date().toISOString() })
    return ok({ notes: notes[match[1]] ?? [] })
  }
  if (path === '/api/visitor-intel/network/batch') {
    const ids = (body.conversation_ids as string[] | undefined) ?? []
    const byConversation = Object.fromEntries(ids.filter((id) => visitors[id]).map((id) => [id, visitors[id]]))
    const cids = (body.contact_ids as string[] | undefined) ?? []
    const byContact = Object.fromEntries(cids.map((id, i) => [id, Object.values(visitors)[i % 6]]))
    return ok({ by_conversation: byConversation, by_contact: byContact })
  }
  if (path === '/api/workspace-members') return ok({ members })
  if (path === '/api/canned-responses') {
    return ok({ items: [
      { id: 'cr1', shortcut: 'hi', title: 'خوش‌آمدگویی', body: 'سلام {{contact.name}} عزیز، {{agent.first_name}} هستم از {{workspace.name}}. چطور می‌تونم کمکتون کنم؟', locale: 'fa', usage_count: 42 },
      { id: 'cr2', shortcut: 'ship', title: 'زمان ارسال', body: 'سفارش‌ها معمولاً ظرف ۲ تا ۳ روز کاری به دستتان می‌رسد.', locale: 'fa', usage_count: 17 },
      { id: 'cr3', shortcut: 'thanks', title: 'Thanks', body: 'Thanks for reaching out, {{contact.name}}! Anything else I can help with?', locale: 'en', usage_count: 9 },
    ] })
  }
  if (path === '/api/plugins/catalog') return ok({ items: [{ slug: 'telegram', installed: true, supportsInbox: true, planAllowed: true }, { slug: 'whatsapp', installed: true, supportsInbox: true, planAllowed: true }, { slug: 'bale', installed: true, supportsInbox: true, planAllowed: true }] })
  if (path === '/api/team-chat/colleagues') {
    return ok({ me: 'u-me', total_unread: 2, colleagues: [
      { user_id: 'u-2', role: 'agent', full_name: 'Nima Jafari', email: 'nima@webyar.ai', avatar_url: null, unread: 2, last_message: { body: 'مرسی 🙌', created_at: ago(38), outgoing: false } },
      { user_id: 'u-3', role: 'admin', full_name: 'Leila Hosseini', email: 'leila@webyar.ai', avatar_url: null, unread: 0, last_message: { body: 'Weekly report is ready in the dashboard.', created_at: ago(60 * 20), outgoing: false } },
    ] })
  }
  if (path === '/api/team-chat/thread') return ok({ me: 'u-me', messages: team[String(q.peer_id)] ?? [] })
  if (path === '/api/team-chat/messages') {
    ;(team[String(body.recipient_id)] ??= []).push({ id: `t${seq++}`, sender_id: 'u-me', recipient_id: body.recipient_id, body: body.body, created_at: new Date().toISOString(), read_at: null })
    return ok({ ok: true })
  }
  if (path === '/api/plugins/gmail/connection') return ok({ connection: { connected: true, emailAddress: 'support@webyar.ai', status: 'active' } })
  if ((match = path.match(/^\/api\/email-inbox\/[^/]+\/threads$/))) return ok({ threads: emailThreads })
  if ((match = path.match(/^\/api\/email-inbox\/[^/]+\/threads\/([^/]+)$/))) {
    const thread = emailThreads.find((t) => t.id === match![1]) ?? emailThreads[0]
    return ok({ thread, messages: [
      { id: 'em1', direction: 'inbound', fromAddress: thread.participants[1].email, toAddresses: [{ email: 'support@webyar.ai' }], textBody: `${thread.lastMessageSnippet}\n\nBest regards,\nThe team`, sentAt: thread.lastMessageAt, isRead: true },
    ] })
  }
  if (path === '/api/contacts') return ok({ contacts: contacts.map((c) => ({ ...c, workspace_id: ws.id, avatar_url: null })) })
  if (path === '/api/availability') {
    if (method === 'PATCH') {
      availability = { ...availability, prefs: { ...availability.prefs, ...body } as typeof availability.prefs }
      availability.status.state = availability.prefs.force_offline ? 'offline' : 'online'
    }
    return ok(availability)
  }
  if (path === '/api/notifications/prefs') {
    if (method === 'PATCH') {
      const { platform: _p, ...rest } = body
      prefs = { ...prefs, ...rest }
    }
    return ok({ platform: 'web', prefs })
  }
  if (path === '/api/account/security/sessions') {
    return ok({ current_session_id: 's1', sessions: [
      { id: 's1', browser: null, os: 'Windows', device: 'Desktop', ip: '5.120.10.4', city: 'Tehran', country: 'Iran', country_code: 'IR', is_current: true, created_at: ago(60 * 24), last_active_at: ago(1) },
      { id: 's2', browser: 'Safari', os: 'iOS', device: 'Mobile', ip: '5.120.10.9', city: 'Tehran', country: 'Iran', country_code: 'IR', is_current: false, created_at: ago(60 * 24 * 9), last_active_at: ago(60 * 3) },
    ] })
  }
  if (path === '/api/mobile-app/promotions') return ok({ enabled: false })
  if ((match = path.match(/^\/api\/call-invitations\/([^/]+)$/))) return ok({ invitation: { id: match[1], status: 'pending', channel: 'audio' } })
  if (path === '/api/call-invitations') return ok({ invitation: { id: 'inv1', status: 'pending', channel: body.channel } })
  if (req.responseType === 'bytes') return { ok: false, kind: 'server', status: 404 }
  return ok({ ok: true })
}
