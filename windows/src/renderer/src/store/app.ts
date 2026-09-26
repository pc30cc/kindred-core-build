import { create } from 'zustand'
import { api, ApiError, setUnauthorizedHandler } from '@/api/client'
import type { AccountProfile, Entitlements, User, Workspace, CallInvitation } from '@/api/types'
import { translate, type Language } from '@/i18n'
import { featureEnabled, moduleInPlan } from '@/lib/entitlements'

export type Appearance = 'system' | 'light' | 'dark'
export type Section = 'inbox' | 'colleagues' | 'email' | 'contacts' | 'settings'
export type SessionState = { kind: 'restoring' } | { kind: 'signedOut' } | { kind: 'signedIn'; user: User }
export type PlanState = { kind: 'loading' } | { kind: 'loaded'; value: Entitlements } | { kind: 'failed' }

export interface ActiveCall {
  invitation: CallInvitation
  contactName: string
  contactAvatarURL?: string | null
  conversationId: string
}

interface AppStore {
  language: Language
  appearance: Appearance
  session: SessionState
  sessionEndedMessage: string | null
  workspaces: Workspace[]
  workspace: Workspace | null
  plan: PlanState
  profile: AccountProfile | null
  section: Section
  conversationId: string | null
  colleagueId: string | null
  emailThreadId: string | null
  contactId: string | null
  detailsOpen: boolean
  paletteOpen: boolean
  inboxUnread: number
  colleaguesUnread: number
  call: ActiveCall | null

  setLanguage(language: Language): void
  setAppearance(appearance: Appearance): void
  restore(): Promise<void>
  signedIn(user: User): Promise<void>
  signOut(): Promise<boolean>
  handleUnauthorized(): void
  accountWasDeleted(): void
  clearSessionEndedMessage(): void
  loadWorkspaces(): Promise<void>
  selectWorkspace(workspace: Workspace): void
  loadPlan(): Promise<void>
  loadProfile(): Promise<void>
  adoptProfile(profile: AccountProfile | null): void
  go(section: Section): void
  openConversation(id: string | null): void
  openColleague(id: string | null): void
  openEmail(id: string | null): void
  openContact(id: string | null): void
  toggleDetails(): void
  setPaletteOpen(open: boolean): void
  setUnread(kind: 'inbox' | 'colleagues', count: number): void
  startCall(call: ActiveCall | null): void
}

const LANGUAGE_KEY = 'app.language'
const APPEARANCE_KEY = 'app.appearance'
const SESSION_CACHE_KEY = 'session.user'
const DETAILS_KEY = 'app.detailsOpen'

/** How soon the plan is asked for again: after a failure, and otherwise. */
const PLAN_RETRY_MS = 20_000
const PLAN_REFRESH_MS = 3 * 60_000
let planTimer: ReturnType<typeof setTimeout> | undefined
/** The workspace the loaded plan belongs to. */
let planWorkspaceId: string | null = null

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage is a convenience; the app works without it.
  }
}

function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

/** The first launch follows Windows' own language when it is one of ours; Persian otherwise. */
function initialLanguage(): Language {
  const system = navigator.language.slice(0, 2)
  const fallback: Language = system === 'en' ? 'en' : system === 'tr' ? 'tr' : 'fa'
  return stored<Language>(LANGUAGE_KEY, ['en', 'fa', 'tr'], fallback)
}

export const useApp = create<AppStore>((set, get) => ({
  language: initialLanguage(),
  appearance: stored<Appearance>(APPEARANCE_KEY, ['system', 'light', 'dark'], 'system'),
  session: { kind: 'restoring' },
  sessionEndedMessage: null,
  workspaces: [],
  workspace: null,
  plan: { kind: 'loading' },
  profile: null,
  section: 'inbox',
  conversationId: null,
  colleagueId: null,
  emailThreadId: null,
  contactId: null,
  detailsOpen: stored(DETAILS_KEY, ['1', '0'], '1') === '1',
  paletteOpen: false,
  inboxUnread: 0,
  colleaguesUnread: 0,
  call: null,

  setLanguage(language) {
    save(LANGUAGE_KEY, language)
    set({ language })
  },
  setAppearance(appearance) {
    save(APPEARANCE_KEY, appearance)
    set({ appearance })
  },

  async restore() {
    if (get().session.kind !== 'restoring') return
    await api.refreshOrigin()
    if (!(await api.hasToken())) {
      set({ session: { kind: 'signedOut' } })
      return
    }
    try {
      const user = await api.currentUser()
      save(SESSION_CACHE_KEY, JSON.stringify(user))
      set({ session: { kind: 'signedIn', user } })
      await get().loadWorkspaces()
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unauthorized') {
        // The server said the session is void. That is the only thing that signs an operator out.
        await api.discardSession()
        save(SESSION_CACHE_KEY, null)
        set({ session: { kind: 'signedOut' } })
        return
      }
      // Offline at launch proves nothing about the session. Stay in with the account we
      // last saw; the first 401 from any screen signs out properly.
      const cached = cachedUser()
      if (cached) {
        set({ session: { kind: 'signedIn', user: cached } })
        await get().loadWorkspaces()
      } else {
        set({ session: { kind: 'signedOut' } })
      }
    }
  },

  async signedIn(user) {
    save(SESSION_CACHE_KEY, JSON.stringify(user))
    set({ sessionEndedMessage: null, session: { kind: 'signedIn', user } })
    await get().loadWorkspaces()
  },

  async signOut() {
    try {
      await api.logout()
    } catch (e) {
      if (!(e instanceof ApiError && e.kind === 'unauthorized')) return false
    }
    reset(set)
    return true
  },

  handleUnauthorized() {
    if (get().session.kind === 'signedOut') return
    void api.discardSession()
    reset(set)
    set({ sessionEndedMessage: translate(get().language, 'sessionExpired') })
  },

  accountWasDeleted() {
    void api.discardSession()
    reset(set)
    set({ sessionEndedMessage: translate(get().language, 'accountDeleted') })
  },

  clearSessionEndedMessage() {
    set({ sessionEndedMessage: null })
  },

  async loadWorkspaces() {
    try {
      void get().loadProfile()
      const list = await api.workspaces()
      const current = get().workspace
      const keep = current && list.some((w) => w.id === current.id)
      const savedId = localStorage.getItem('app.workspace')
      const next = keep ? current : list.find((w) => w.id === savedId) ?? list[0] ?? null
      set({ workspaces: list, workspace: next })
      await get().loadPlan()
    } catch {
      // Leave what we had; each screen surfaces its own error state.
      if (get().plan.kind === 'loading') set({ plan: { kind: 'failed' } })
    }
  },

  selectWorkspace(workspace) {
    if (workspace.id === get().workspace?.id) return
    save('app.workspace', workspace.id)
    set({
      workspace,
      plan: { kind: 'loading' },
      conversationId: null,
      colleagueId: null,
      emailThreadId: null,
      contactId: null,
    })
    void get().loadPlan()
  },

  // Nothing gated shows while the plan cannot be read (the web's rule, src/lib/planAccess.ts),
  // so it is asked for again after 20 s; one in hand is refreshed every 3 minutes, because Super
  // Admin can change it at any time. A refresh that fails keeps this workspace's snapshot.
  async loadPlan() {
    const id = get().workspace?.id
    clearTimeout(planTimer)
    if (!id) {
      set({ plan: { kind: 'failed' } })
      return
    }
    try {
      const value = await api.entitlements(id)
      if (get().workspace?.id !== id) return
      planWorkspaceId = id
      set({ plan: { kind: 'loaded', value } })
    } catch {
      if (get().workspace?.id !== id) return
      if (get().plan.kind !== 'loaded' || planWorkspaceId !== id) set({ plan: { kind: 'failed' } })
    }
    clearTimeout(planTimer)
    planTimer = setTimeout(() => {
      if (get().workspace?.id === id) void get().loadPlan()
    }, get().plan.kind === 'loaded' ? PLAN_REFRESH_MS : PLAN_RETRY_MS)
  },

  async loadProfile() {
    try {
      const account = await api.account()
      set({ profile: account.profile ?? null })
    } catch {
      // A missing photo is not an error state.
    }
  },

  adoptProfile(profile) {
    if (profile) set({ profile })
  },

  go(section) {
    set({ section })
  },
  openConversation(id) {
    set({ section: 'inbox', conversationId: id })
  },
  openColleague(id) {
    set({ section: 'colleagues', colleagueId: id })
  },
  openEmail(id) {
    set({ section: 'email', emailThreadId: id })
  },
  openContact(id) {
    set({ section: 'contacts', contactId: id })
  },
  toggleDetails() {
    const next = !get().detailsOpen
    save(DETAILS_KEY, next ? '1' : '0')
    set({ detailsOpen: next })
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open })
  },
  setUnread(kind, count) {
    set(kind === 'inbox' ? { inboxUnread: count } : { colleaguesUnread: count })
  },
  startCall(call) {
    set({ call })
  },
}))

function reset(set: (partial: Partial<AppStore>) => void) {
  save(SESSION_CACHE_KEY, null)
  clearTimeout(planTimer)
  planWorkspaceId = null
  set({
    session: { kind: 'signedOut' },
    workspaces: [],
    workspace: null,
    plan: { kind: 'loading' },
    profile: null,
    conversationId: null,
    colleagueId: null,
    emailThreadId: null,
    contactId: null,
    inboxUnread: 0,
    colleaguesUnread: 0,
    call: null,
    section: 'inbox',
  })
}

setUnauthorizedHandler(() => useApp.getState().handleUnauthorized())

// Selectors — the plan gates, the same way round as the console's sidebar.
export const planValue = (s: AppStore): Entitlements | null => (s.plan.kind === 'loaded' ? s.plan.value : null)
export const planResolved = (s: AppStore): boolean => s.plan.kind !== 'loading'
export const contactsVisible = (s: AppStore): boolean => moduleInPlan(planValue(s), 'contacts')
export const colleaguesVisible = (s: AppStore): boolean => featureEnabled(planValue(s), 'inbox_team_chat')
export const emailVisible = (s: AppStore): boolean => moduleInPlan(planValue(s), 'email_inbox')
export const currentUser = (s: AppStore): User | null => (s.session.kind === 'signedIn' ? s.session.user : null)

export function displayNameOf(user: User | null, profile?: AccountProfile | null): string {
  const n = profile?.full_name?.trim() || user?.fullName?.trim()
  return n || user?.email || '—'
}
