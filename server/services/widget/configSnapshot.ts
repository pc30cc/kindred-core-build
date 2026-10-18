/**
 * Widget config snapshot — what POST /api/widget/bootstrap and
 * GET /api/widget/config need from the database, cached per workspace.
 *
 * WHAT IS CACHED: the INPUTS, never a finished response. Every value the two
 * endpoints read that depends neither on the visitor nor on the clock — the
 * widget_settings row, entitlements, branding, the team and its availability
 * prefs, the published smart rules, the AI agent's visitor-facing snapshot,
 * the derived logo / launcher-image / avatar URLs, the call channels.
 *
 * WHAT IS COMPUTED PER REQUEST, with no I/O (buildWidgetConfigBody,
 * bootstrapAvailability): availability at `now` (business hours and personal
 * schedules flip exactly on time), the team's online dots, the smart rules'
 * end_at filter, the platform AI kill-switch overlay (15 s cache), the
 * content-hashed asset URLs (2 s manifest cache), apiBase / assetBase from
 * the request, locale clamping. Tokens, cookies and the visitor identity are
 * never cached (they stay in the route).
 *
 * Cache rules (workspace snapshot; the machinery is lib/memoCache.ts):
 *   - Fresh for WIDGET_CONFIG_CACHE_TTL_MS, default 60 s. Every writer of an
 *     input publishes an invalidation (lib/cacheBus.ts), which reaches every
 *     backend process through PostgreSQL LISTEN/NOTIFY — so a change usually
 *     shows on the next page view. Correctness never depends on that bus:
 *     the TTL alone bounds how stale a process can be. 0 turns every cache
 *     in this file off (each request reads, as before).
 *   - Single flight per workspace; a build running when its workspace is
 *     invalidated is handed to the requests already waiting on it but never
 *     stored (it may have read the old values).
 *   - Stale-while-revalidate: past its TTL an entry is still served for up
 *     to 10 min while ONE background rebuild runs; a failed or degraded
 *     rebuild keeps it, so a database blip no longer greys every launcher.
 *   - Degraded build (a read answered with an error, or an unreadable
 *     entitlement) lives 5 s; a workspace without a widget_settings row and
 *     a workspace that does not exist live 15 s.
 *   - LRU bound WIDGET_CONFIG_CACHE_MAX (default 2000). Not-found answers
 *     have their own, smaller LRU: random workspace ids cannot push real
 *     snapshots out.
 *   - Full rebuilds (~30 queries) are rate-limited per process
 *     (WIDGET_CONFIG_REBUILDS_PER_SEC, default 25/s, burst 2×): a request
 *     over the budget waits up to 5 s for its turn, then gets 503; a
 *     background refresh over the budget is simply skipped. The existence
 *     read in front of it (one query) is not counted, so a flood of made-up
 *     ids cannot starve real workspaces. A cache hit is always free.
 *   - Keys are lower-cased workspace ids (uuid comparison is case-blind in
 *     PostgreSQL; spelling one id two ways must not double the work).
 *
 * Separate caches: the platform snapshot (widget_platform_settings, the
 * legacy pre-chat fallback, every platform_branding_localized name and the
 * Super Admin's chat widget template catalog per edition; 30 s) and
 * quota_full (60 s, it moves with usage, which has no write hook).
 */
import type { Request } from 'express';
import type { ServerConfig } from '../../config.js';
import { getServiceClient, type ServiceClient } from '../../supabase.js';
import { onInvalidate } from '../../lib/cacheBus.js';
import { MemoBusyError, MemoCache, RateGate, envNonNegativeInt, type MemoLoadContext } from '../../lib/memoCache.js';
import { canonicalWorkspaceId } from '../../lib/workspaceId.js';
import {
  getLoaderAssetBase,
  getRequestBaseUrl,
  resolveWidgetApiBase,
  resolveWidgetAssetBase,
} from './public.js';
import { getWidgetAssetName, getOptionalWidgetAssetName, getLoaderVersion, widgetAssetUrl } from './manifest.js';
import { resolveEditionWidgetTemplateId, resolveWidgetTemplateId, widgetTemplateAssetKeys } from './presentationAssets.js';
import { readChatTemplateRows } from './templateCatalog.js';
import { EDITION_CHAT_WIDGET_TEMPLATES, chatWidgetTemplate, widgetDateHints, type ChatWidgetTemplate } from '../../../shared/widgetTemplates.js';
import {
  resolveChatTemplateCatalog,
  resolveChatTemplateOptions,
  type ChatTemplateCatalog,
  type ChatTemplateOptions,
} from '../../../shared/chatTemplateCatalog.js';
import { INTL_BRAND } from '../../../shared/internationalMode.js';
import { WEBYAR_BRAND, isWebyarKitEdition } from '../../../shared/webyarBrand.js';
import type { Edition } from '../../../shared/edition.js';
import { isPoweredByAllowedForPlan, buildPoweredByConfig } from './poweredBy.js';
import {
  resolveWidgetEntitlements,
  applyWidgetEntitlementsToSettings,
  type WidgetEntitlements,
} from './entitlements.js';
import { loadPublishedSmartRules, isSmartRuleUnexpired, type PublicSmartRule } from './smartEngagement.js';
import { resolveEffectiveAiNudgePolicy } from './aiNudge/policy.js';
import { resolveAvailability, resolveConversationQuotaFull, snapshotToWirePayload } from './availability.js';
import {
  AVAILABILITY_PREFS_COLUMNS,
  listCustomerAvailableOperators,
  type AvailabilityPrefsRow,
  type WorkspaceAvailabilityPrefs,
} from './customerAvailability.js';
import { createStorageUrlResolver, hydrateUserAvatars, type StorageUrlResolver } from '../storage/urlResolver.js';
import { resolveAgentLogoUrl, type AgentMode } from '../ai-agent/settings.js';
import {
  getPlatformAiAgentSettings,
  isPlatformSettingsLookupFailed,
  __resetPlatformAiAgentSettingsCache,
  type PlatformAiAgentSettings,
} from '../ai-agent/platformSettings.js';
import { PLATFORM_STATUS_UNAVAILABLE } from '../ai-agent/platformGuards.js';
import { loadEffectiveCallChannels, type EffectiveCallChannels } from '../calls/controlPlane.js';
import { getPlatformAllowedLocales, getPlatformEditionOrNull } from '../platformRegion.js';

// ═══════════════════════════════════════════════════════════════════════
// Defaults and pre-chat policy (moved from server/routes/widget.ts)
// ═══════════════════════════════════════════════════════════════════════

// Seeded English defaults. When the widget locale is not English these are
// treated as "unset" so the visitor sees a localized string instead of the
// leftover English seed value.
const SEED_LAUNCHER_TEXTS = ['chat with us', 'support', 'hello!'];
const SEED_WELCOME_TEXTS = ['hello! how can we help you?', 'how can we help you?'];
const LOCALIZED_WIDGET_DEFAULTS: Record<string, { launcher: string; welcome: string }> = {
  fa: { launcher: 'با ما گفتگو کنید', welcome: 'سلام! چطور می‌توانیم کمکتان کنیم؟' },
  tr: { launcher: 'Bizimle sohbet edin', welcome: 'Merhaba! Size nasıl yardımcı olabiliriz?' },
  en: { launcher: 'Chat with us', welcome: 'Hello! How can we help you?' },
};

export function resolveLocalizedDefault(
  value: unknown,
  kind: 'launcher' | 'welcome',
  locale: string | null | undefined,
): string {
  const lang = String(locale || 'en').toLowerCase().split('-')[0];
  const defaults = LOCALIZED_WIDGET_DEFAULTS[lang] || LOCALIZED_WIDGET_DEFAULTS.en;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return lang === 'en' ? '' : defaults[kind];
  if (lang === 'en') return raw;
  const seeds = kind === 'launcher' ? SEED_LAUNCHER_TEXTS : SEED_WELCOME_TEXTS;
  if (seeds.includes(raw.toLowerCase())) return defaults[kind];
  return raw;
}

export const DEFAULT_WIDGET_SETTINGS = {
  enabled: true,
  primary_color: '#3B82F6',
  secondary_color: '#6366f1',
  greeting_message: '',
  welcome_message: 'Hello! How can we help you?',
  // NULL (not '') = "never authored" → the UI/widget uses its default text.
  // An explicit '' is an authored "hide this line" signal.
  reply_time_text: null as string | null,
  brand_name: null as string | null,

  placeholder_text: '',
  position: 'bottom-right',
  show_logo: true,
  show_team_avatars: true,
  show_powered_by: true,
  offline_message: '',
  auto_open_delay: 0,
  theme: 'modern',
  fab_icon: 'chat',
  fab_shape: 'circle',
  fab_label: '',
  fab_scale: 100,
  fab_icon_color: '#ffffff',
  fab_image_storage_key: null as string | null,
  fab_image_url: null as string | null,
  fab_text_color: '#ffffff',
  default_mode: 'chat',
  chat_enabled: true,
  kb_enabled: true,
  visitor_tracking_enabled: true,
  support_mode: 'human_first',
  widget_language: 'auto',
  mobile_behavior: 'bottom_sheet',
  locale: 'en',
  // Phase 5 — Availability
  live_chat_enabled: true,
  offline_mode: 'accept_messages',
  business_hours: { enabled: false, timezone: 'UTC', schedule: [] },
  availability_labels: {},
  // Phase 6a — Attachments (off by default)
  attachments_enabled: false,
  attachments_max_size_mb: 10,
  attachments_allowed_mimes: [
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'application/pdf', 'text/plain',
  ],
  // Voice notes — independent of file attachments (own toggle, own
  // fixed audio-mime allow-list server-side; see widgetAttachments.ts).
  voice_notes_enabled: false,
  // Emoji picker — client-side only, on by default.
  emoji_enabled: true,
  // Phase 7 — Read receipts (on by default; admin can disable per-workspace)
  read_receipts_enabled: true,
};

const PRECHAT_RUNTIME_KEY = 'widget_prechat_fields';
export const PRECHAT_FIELD_KEYS = {
  name: 'widget_prechat_name',
  email: 'widget_prechat_email',
  phone: 'widget_prechat_phone',
} as const;
const DEFAULT_PRECHAT_POLICY = {
  name: 'default_on',
  email: 'default_on',
  phone: 'default_on',
} as const;

type PreChatMode = 'force_on' | 'force_off' | 'default_on' | 'default_off';

export function normalizePreChatPolicy(value: unknown): Record<'name' | 'email' | 'phone', PreChatMode> {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const valid = (v: unknown): v is PreChatMode => v === 'force_on' || v === 'force_off' || v === 'default_on' || v === 'default_off';
  return {
    name: valid(source.name) ? source.name : DEFAULT_PRECHAT_POLICY.name,
    email: valid(source.email) ? source.email : DEFAULT_PRECHAT_POLICY.email,
    phone: valid(source.phone) ? source.phone : DEFAULT_PRECHAT_POLICY.phone,
  };
}

// Loads policy from widget_platform_settings (preferred) or falls back to app_runtime_config
async function loadPlatformPreChatPolicy(supabase: ServiceClient): Promise<{ value: unknown; error: boolean }> {
  const { data: platformRow, error } = await supabase
    .from('widget_platform_settings')
    .select('prechat_name_policy, prechat_email_policy, prechat_phone_policy')
    .limit(1)
    .maybeSingle();
  if (platformRow) {
    return {
      value: {
        name: platformRow.prechat_name_policy,
        email: platformRow.prechat_email_policy,
        phone: platformRow.prechat_phone_policy,
      },
      error: false,
    };
  }
  const { data: legacy, error: legacyError } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', PRECHAT_RUNTIME_KEY)
    .maybeSingle();
  return { value: legacy?.value || null, error: !!error || !!legacyError };
}

export function buildPreChatConfig(policyValue: unknown, workspaceFlags: Array<{ key: string; enabled: boolean | null }> = []) {
  const policy = normalizePreChatPolicy(policyValue);
  const flagMap = new Map(workspaceFlags.map((flag) => [flag.key, flag.enabled]));

  const resolveField = (field: keyof typeof PRECHAT_FIELD_KEYS) => {
    const mode = policy[field];
    const locked = mode === 'force_off';
    const workspaceOverride = flagMap.has(PRECHAT_FIELD_KEYS[field]) ? flagMap.get(PRECHAT_FIELD_KEYS[field]) ?? false : null;
    const enabled = locked ? false : workspaceOverride === null ? mode === 'default_on' : !!workspaceOverride;
    return { enabled, locked, mode, workspaceOverride };
  };

  return {
    name: resolveField('name'),
    email: resolveField('email'),
    phone: resolveField('phone'),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Snapshot shapes
// ═══════════════════════════════════════════════════════════════════════

function readWidgetSettingsRow(sb: ServiceClient, workspaceId: string) {
  return sb.from('widget_settings').select('*').eq('workspace_id', workspaceId).maybeSingle();
}
/** widget_settings (select '*'), loosely typed as supabase-js returns it to every route. */
export type WidgetSettingsRow = NonNullable<Awaited<ReturnType<typeof readWidgetSettingsRow>>['data']>;

/** Phase 4 — the AI Agent activation snapshot the widget uses to decide on the greeting. */
export interface WidgetAiAgentInfo {
  enabled: boolean;
  mode: string;
  introEnabled: boolean;
  suppressGreeting: boolean;
  /** AI will actually converse with the visitor (provider proven). */
  visitorFacing: boolean;
  /** AI may send the static intro first (no provider required). */
  introCapable: boolean;
  providerReady: boolean;
  /** Coarse, non-sensitive diagnosis. Never a provider/model/key. */
  reason: string;
  agentName: string | null;
  agentLogoUrl: string | null;
  disabledByPlatform: boolean;
  disabledMessage: string | null;
  // Owner-configurable text for the inline pre-chat card shown when the
  // AI hands off to a human mid-conversation. Empty = client falls back
  // to its own built-in copy.
  handoffPrechatMessageLocalized: Record<string, string>;
}

function aiAgentOff(): WidgetAiAgentInfo {
  return {
    enabled: false,
    mode: 'off',
    introEnabled: false,
    suppressGreeting: false,
    visitorFacing: false,
    introCapable: false,
    providerReady: false,
    reason: 'platform_disabled',
    agentName: null,
    agentLogoUrl: null,
    disabledByPlatform: false,
    disabledMessage: null,
    handoffPrechatMessageLocalized: {},
  };
}

// E12 — platform kill switch wins over workspace AI settings. When the
// platform disables AI Agent globally we MUST advertise it as disabled to
// the widget so it stops suppressing the generic greeting and never requests
// the AI intro.
function aiAgentDisabledByPlatform(platform: PlatformAiAgentSettings | null): WidgetAiAgentInfo {
  return {
    enabled: false,
    mode: 'off',
    introEnabled: false,
    suppressGreeting: false,
    visitorFacing: false,
    introCapable: false,
    providerReady: false,
    reason: 'platform_disabled',
    agentName: null,
    agentLogoUrl: null,
    disabledByPlatform: true,
    disabledMessage: platform?.disabled_message || null,
    handoffPrechatMessageLocalized: {},
  };
}

export interface TeamProfile {
  id: string;
  name: string;
  avatar: string | null;
}

export interface WorkspaceWidgetSnapshot {
  builtAt: number;
  /** A read failed or an entitlement was unreadable: kept 5 s only. */
  degraded: boolean;
  /** null = the workspace does not exist (or could not be read). */
  workspace: { id: string; name: string | null } | null;
  /** The raw widget_settings row (null when missing or unreadable). */
  widgetRow: WidgetSettingsRow | null;
  /**
   * The widget_settings read failed (widgetRow is null for that reason, not
   * because there is no row): its origin allow-list is unknown, so the
   * bootstrap must not skip the origin check.
   */
  widgetRowUnreadable: boolean;
  /** DEFAULT_WIDGET_SETTINGS + the row, plan entitlements applied. */
  settings: WidgetSettingsRow | null;
  entitlements: WidgetEntitlements | null;
  branding: { logo_url?: string | null; logo_storage_key?: string | null; primary_color?: string | null } | null;
  poweredByPlanAllows: boolean;
  preChatFlags: Array<{ key: string; enabled: boolean | null }>;
  /** Published + active, sanitized; the end_at filter runs per request. */
  smart: { enabled: boolean; rules: PublicSmartRule[] };
  aiProactive: { enabled: boolean; mode: string };
  aiAgent: WidgetAiAgentInfo;
  availabilityPrefs: WorkspaceAvailabilityPrefs;
  /** Lower-cased member ids, for `user:<id>` invalidation. */
  memberIds: Set<string>;
  /** The first four members' profiles, in the order the read returned them; null = none. */
  team: TeamProfile[] | null;
  logoUrl: string | null;
  fabImageUrl: string | null;
  /** null = could not be read (resolves as every channel off). */
  callChannels: EffectiveCallChannels | null;
}

export interface WidgetPlatformSnapshot {
  builtAt: number;
  degraded: boolean;
  /** widget_platform_settings: the URL bases, welcome default and powered-by wording. */
  widget: Record<string, unknown> | null;
  /** The platform pre-chat policy (widget_platform_settings, else the legacy app_runtime_config key). */
  preChatPolicy: unknown;
  /** platform_branding_localized: locale → platform_name. */
  names: Map<string, string | null>;
  /**
   * The Super Admin's chat widget template catalog per edition
   * (widget_edition_settings.chat_templates, raw; shared/chatTemplateCatalog.ts
   * reads it). Empty when no edition has a row, or before migration 275.
   */
  chatTemplates: Partial<Record<Edition, unknown>>;
  /** False while widget_edition_settings does not exist (before 275). */
  chatTemplatesReady: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Cache settings
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = 60_000;
const DEGRADED_TTL_MS = 5_000;
const NEGATIVE_TTL_MS = 15_000;
const PLATFORM_TTL_MS = 30_000;
const QUOTA_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_REBUILDS_PER_SEC = 25;

/** The fresh lifetime of a good workspace snapshot; 0 = caching off. */
export function widgetConfigCacheTtlMs(): number {
  return envNonNegativeInt('WIDGET_CONFIG_CACHE_TTL_MS') ?? DEFAULT_TTL_MS;
}

function cachingEnabled(): boolean {
  return widgetConfigCacheTtlMs() > 0;
}

/**
 * A lifetime capped by the configured TTL: a shorter WIDGET_CONFIG_CACHE_TTL_MS
 * shortens every cache here, 0 turns them all off.
 */
function capped(limitMs: number): number {
  const configured = envNonNegativeInt('WIDGET_CONFIG_CACHE_TTL_MS');
  return configured === null ? limitMs : Math.min(configured, limitMs);
}

function maxEntries(): number {
  const configured = envNonNegativeInt('WIDGET_CONFIG_CACHE_MAX');
  return configured && configured > 0 ? configured : DEFAULT_MAX_ENTRIES;
}

function rebuildsPerSecond(): number {
  return envNonNegativeInt('WIDGET_CONFIG_REBUILDS_PER_SEC') ?? DEFAULT_REBUILDS_PER_SEC;
}

/**
 * One key per workspace whatever the spelling (lib/workspaceId.ts); null for
 * a value that is no uuid at all, which is answered without a cache or query.
 */
function cacheKey(workspaceId: string): string | null {
  return canonicalWorkspaceId(workspaceId);
}

/** Rebuilds (waves 2-3, ~30 queries) per second, per process. */
const rebuildGate = new RateGate(
  'widget-config-snapshot',
  rebuildsPerSecond,
  () => Math.max(1, rebuildsPerSecond() * 2),
  5_000,
);

// ═══════════════════════════════════════════════════════════════════════
// Workspace snapshot
// ═══════════════════════════════════════════════════════════════════════

const snapshots = new MemoCache<WorkspaceWidgetSnapshot>({
  name: 'widget-config-snapshot',
  enabled: cachingEnabled,
  ttlMs: (snap) => {
    if (snap.degraded) return capped(DEGRADED_TTL_MS);
    // Not found, or found without a widget_settings row: a row created
    // right after (a new workspace, a SQL insert) shows within 15 s.
    if (!snap.workspace || !snap.widgetRow) return capped(NEGATIVE_TTL_MS);
    return widgetConfigCacheTtlMs();
  },
  max: maxEntries,
  isNegative: (snap) => !snap.workspace,
  negativeMax: () => Math.max(100, Math.floor(maxEntries() / 4)),
  keepPrevious: (previous, next) => next.degraded && !previous.degraded,
  // Only a good snapshot is served past its lifetime. A degraded or
  // not-found one (5 s / 15 s) is rebuilt in the foreground once it is old,
  // so a database blip, or a row created after the miss, cannot be served
  // for the 10 min stale window while background rebuilds are refused.
  serveStale: (snap) => !snap.degraded && !!snap.workspace && !!snap.widgetRow,
});

function emptySnapshot(builtAt: number, degraded: boolean): WorkspaceWidgetSnapshot {
  return {
    builtAt,
    degraded,
    workspace: null,
    widgetRow: null,
    widgetRowUnreadable: false,
    settings: null,
    entitlements: null,
    branding: null,
    poweredByPlanAllows: true,
    preChatFlags: [],
    smart: { enabled: false, rules: [] },
    aiProactive: { enabled: false, mode: 'off' },
    aiAgent: aiAgentOff(),
    availabilityPrefs: { memberIds: [], prefsByUser: new Map() },
    memberIds: new Set(),
    team: null,
    logoUrl: null,
    fabImageUrl: null,
    callChannels: null,
  };
}

async function buildAiAgentInfo(
  config: ServerConfig,
  workspaceId: string,
  platform: PlatformAiAgentSettings | null,
  aiSettings: { enabled?: unknown; mode?: unknown; ai_intro_enabled?: unknown; agent_name?: string | null; agent_logo_url?: string | null; metadata?: unknown } | null,
  handoffPrechatMessageLocalized: Record<string, string>,
  resolver: StorageUrlResolver,
): Promise<WidgetAiAgentInfo> {
  try {
    if (platform && platform.ai_agent_enabled === false) return aiAgentDisabledByPlatform(platform);
    if (!aiSettings) return aiAgentOff();
    const mode = String(aiSettings.mode || 'off');
    const introEnabled = aiSettings.ai_intro_enabled !== false;
    // P0-AI — ONE authoritative visitor-facing AI snapshot. `visitorFacing`
    // now genuinely means "the AI will converse with this visitor": it
    // requires a resolvable provider, so `provider_pending` no longer
    // suppresses the greeting for a workspace whose AI can only ever emit
    // a single canned line and then go silent. `introCapable` (all gates
    // except the provider) is what governs the static intro itself.
    const { resolveVisitorAiSnapshot } = await import('../ai-agent/visitorAiSnapshot.js');
    const aiSnapshot = await resolveVisitorAiSnapshot(config, workspaceId, {
      enabled: !!aiSettings.enabled,
      mode: mode as AgentMode,
    });
    return {
      enabled: !!aiSettings.enabled,
      mode,
      introEnabled,
      // Suppress the generic greeting only when the AI will actually
      // speak first AND can carry the conversation afterwards.
      suppressGreeting: aiSnapshot.visitorFacing && aiSnapshot.introCapable && introEnabled,
      visitorFacing: aiSnapshot.visitorFacing,
      introCapable: aiSnapshot.introCapable && introEnabled,
      providerReady: aiSnapshot.providerReady,
      reason: aiSnapshot.reason,
      agentName: aiSettings.agent_name || null,
      agentLogoUrl: await resolveAgentLogoUrl(config, workspaceId, aiSettings, resolver),
      disabledByPlatform: false,
      disabledMessage: null,
      handoffPrechatMessageLocalized,
    };
  } catch (e) {
    console.warn('[widget-config] ai_agent_settings lookup failed:', e instanceof Error ? e.message : e);
    return aiAgentOff();
  }
}

/**
 * Read everything, in parallel waves (a cold build is ~4 round trips, not
 * the ~20 sequential ones the two routes used to make per request):
 *   1. the workspace — a random id costs this one query;
 *   2. settings, branding, flags, plan, entitlements, members, AI settings,
 *      call channels;
 *   3. prefs, profiles (→ avatars), smart rules, nudge policy, AI snapshot,
 *      and ONE storage resolver for the logo, launcher image, agent logo and
 *      avatars.
 */
async function buildSnapshot(config: ServerConfig, workspaceId: string, ctx: MemoLoadContext): Promise<WorkspaceWidgetSnapshot> {
  const sb = getServiceClient(config);
  let degraded = false;
  const note = (error: unknown) => {
    if (error) degraded = true;
  };

  // ── Wave 1 ──
  const { data: workspace, error: workspaceError } = await sb
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .maybeSingle();
  // An unreadable workspace reads as missing — as both routes always
  // treated it — but only for the degraded lifetime.
  if (workspaceError || !workspace) return emptySnapshot(Date.now(), !!workspaceError);

  // The expensive part is budgeted per process; a background refresh over
  // the budget is skipped (the stale entry stays), a request waits its turn.
  if (ctx.background) {
    if (!rebuildGate.tryAcquire()) throw new MemoBusyError('widget-config-snapshot');
  } else {
    await rebuildGate.acquire();
  }
  const builtAt = Date.now();

  // ── Wave 2 ──
  const [
    widgetResult,
    brandingResult,
    flagsResult,
    poweredByPlanAllows,
    entitlements,
    membersResult,
    aiMainResult,
    aiHandoffResult,
    callChannels,
    aiPlatform,
  ] = await Promise.all([
    readWidgetSettingsRow(sb, workspaceId),
    sb.from('workspace_branding')
      .select('logo_url, logo_storage_key, primary_color')
      .eq('workspace_id', workspaceId).maybeSingle(),
    sb.from('feature_flags').select('key, enabled').eq('workspace_id', workspaceId).in('key', Object.values(PRECHAT_FIELD_KEYS)),
    isPoweredByAllowedForPlan(sb, workspaceId),
    // Plan intersection — a downgrade must disable behaviours in widgets that
    // are already embedded on customer sites, not just hide the operator UI.
    resolveWidgetEntitlements(config, workspaceId).catch((err: unknown) => {
      console.error('[widget/config] entitlement resolution failed', err);
      return null;
    }),
    sb.from('workspace_members').select('user_id').eq('workspace_id', workspaceId),
    sb.from('ai_agent_settings')
      .select('enabled, mode, ai_intro_enabled, agent_name, agent_logo_url, metadata')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    // Best-effort, separate from the query above on purpose: this column
    // ships in a migration that may not be applied to every environment
    // yet. Fetching it in the SAME select as the fields above would make
    // one missing column fail the whole lookup — which previously broke
    // suppressGreeting entirely. Its error is therefore not "degraded".
    (async () => {
      try {
        return await sb
          .from('ai_agent_settings')
          .select('handoff_prechat_message_localized')
          .eq('workspace_id', workspaceId)
          .maybeSingle();
      } catch {
        return { data: null, error: null };
      }
    })(),
    loadEffectiveCallChannels(config, workspaceId).catch(() => {
      degraded = true;
      return null;
    }),
    getPlatformAiAgentSettings(config).catch(() => null),
  ]);

  const widgetRow = widgetResult.error ? null : widgetResult.data ?? null;
  note(widgetResult.error);
  note(brandingResult.error);
  note(flagsResult.error);
  note(membersResult.error);
  note(aiMainResult.error);
  if (!entitlements || entitlements.degraded) degraded = true;
  // An unresolved platform AI lookup reads as "AI off" — never for long.
  if (aiPlatform && isPlatformSettingsLookupFailed(aiPlatform)) degraded = true;

  const settings = widgetRow
    ? (entitlements
      ? applyWidgetEntitlementsToSettings({ ...DEFAULT_WIDGET_SETTINGS, ...widgetRow }, entitlements)
      : { ...DEFAULT_WIDGET_SETTINGS, ...widgetRow })
    : null;
  const memberIds = ((membersResult.data || []) as Array<{ user_id: string | null }>)
    .map((m) => m.user_id)
    .filter((id): id is string => !!id);
  const branding = brandingResult.data ?? null;
  const aiSettings = aiMainResult.data ?? null;
  const hpRow = aiHandoffResult.data as { handoff_prechat_message_localized?: unknown } | null;
  const handoffPrechatMessageLocalized = hpRow && hpRow.handoff_prechat_message_localized
    && typeof hpRow.handoff_prechat_message_localized === 'object'
    ? hpRow.handoff_prechat_message_localized as Record<string, string>
    : {};

  // GET /config needs the rest only for an enabled widget; bootstrap needs
  // the prefs unless the widget is switched off.
  const forConfig = !!settings && !!widgetRow?.enabled;
  const needsPrefs = widgetRow?.enabled !== false;
  const smartOn = forConfig && settings.smart_engagement_enabled === true;
  const resolver = createStorageUrlResolver(config);

  // ── Wave 3 ──
  const [prefsResult, teamResult, smart, aiProactive, aiAgent, logoUrl, fabImageUrl] = await Promise.all([
    needsPrefs && memberIds.length
      ? sb.from('user_availability_prefs')
        .select(AVAILABILITY_PREFS_COLUMNS)
        .in('user_id', memberIds)
        .is('workspace_id', null)
      : Promise.resolve({ data: [] as AvailabilityPrefsRow[], error: null }),
    forConfig ? loadTeam(sb, resolver, memberIds) : Promise.resolve({ team: null, error: false }),
    // Smart Engagement rules (active + published only). Failure here must
    // never take down /config — the helper already degrades to an empty list.
    forConfig
      ? loadPublishedSmartRules(sb, workspaceId, smartOn)
      : Promise.resolve({ enabled: false, rules: [] as PublicSmartRule[], error: false }),
    // AI Proactive Nudge — only {enabled, mode} ever reach the browser.
    // Guidance text, path targeting and platform ceilings stay server-side;
    // POST /api/widget/nudge/evaluate re-resolves the full policy itself on
    // every call, so a stale/forged client value here can only ever waste
    // one harmless round-trip, never bypass a limit.
    smartOn
      ? resolveEffectiveAiNudgePolicy(config, workspaceId).then(
        (policy) => {
          // An unresolved policy (a failed lookup) is off, and kept briefly.
          const reason = policy.unavailableReason || '';
          if (reason === 'unresolved' || reason.endsWith(PLATFORM_STATUS_UNAVAILABLE)) degraded = true;
          return { enabled: policy.available, mode: policy.mode as string };
        },
        () => ({ enabled: false, mode: 'off' }),
      )
      : Promise.resolve({ enabled: false, mode: 'off' }),
    forConfig
      ? buildAiAgentInfo(config, workspaceId, aiPlatform, aiSettings, handoffPrechatMessageLocalized, resolver)
      : Promise.resolve(aiAgentOff()),
    // `widget_settings.logo_url` is an operator-typed external link and is
    // kept as-is; the workspace's own uploaded logo is derived from its
    // storage key so it follows a provider promotion with no row rewrite.
    forConfig
      ? (async () => settings.logo_url
        || (await resolver.workspace(workspaceId, branding?.logo_storage_key))
        || null)()
      : Promise.resolve(null),
    // Optional launcher image. DERIVED from the stored key for whichever
    // provider is primary right now, so promoting a new one needs no row
    // rewritten. The legacy `fab_image_url` tail is a deprecated read-only
    // fallback for rows uploaded before the key column existed.
    forConfig
      ? (async () => (await resolver.workspace(workspaceId, settings.fab_image_storage_key))
        ?? (typeof settings.fab_image_url === 'string' && /^https?:\/\//i.test(settings.fab_image_url.trim())
          ? settings.fab_image_url.trim()
          : null))()
      : Promise.resolve(null),
  ]);
  note(prefsResult.error);
  if (teamResult.error || smart.error) degraded = true;

  const prefsByUser = new Map<string, AvailabilityPrefsRow>();
  for (const r of (prefsResult.data || []) as AvailabilityPrefsRow[]) {
    if (r.user_id) prefsByUser.set(r.user_id, r);
  }

  return {
    builtAt,
    degraded,
    workspace: { id: String(workspace.id), name: workspace.name ?? null },
    widgetRow,
    widgetRowUnreadable: !!widgetResult.error,
    settings,
    entitlements,
    branding,
    poweredByPlanAllows,
    preChatFlags: (flagsResult.data || []) as Array<{ key: string; enabled: boolean | null }>,
    smart: { enabled: smart.enabled, rules: smart.rules },
    aiProactive,
    aiAgent,
    availabilityPrefs: { memberIds, prefsByUser },
    memberIds: new Set(memberIds.map((id) => id.toLowerCase())),
    team: teamResult.team,
    logoUrl,
    fabImageUrl,
    callChannels,
  };
}

/** The first four members' names and avatars (the team stack). */
async function loadTeam(
  sb: ServiceClient,
  resolver: StorageUrlResolver,
  memberIds: string[],
): Promise<{ team: TeamProfile[] | null; error: boolean }> {
  const first = memberIds.slice(0, 4);
  if (!first.length) return { team: null, error: false };
  const { data: profiles, error } = await sb
    .from('profiles').select('id, full_name, avatar_storage_key')
    .in('id', first);
  if (!profiles) return { team: null, error: !!error };
  const withAvatars = await hydrateUserAvatars(resolver, profiles);
  return {
    team: withAvatars.map((p) => ({ id: p.id, name: p.full_name || 'Operator', avatar: p.avatar_url })),
    error: !!error,
  };
}

/**
 * The workspace's snapshot: from memory when fresh, else (single flight)
 * built. Throws only when a build throws and no entry ≤10 min old exists.
 */
export function getWorkspaceWidgetSnapshot(config: ServerConfig, workspaceId: string): Promise<WorkspaceWidgetSnapshot> {
  const key = cacheKey(workspaceId);
  // Not a uuid in any spelling: no such workspace, and nothing to cache.
  if (!key) return Promise.resolve(emptySnapshot(Date.now(), false));
  return snapshots.get(key, (ctx) => buildSnapshot(config, key, ctx));
}

export { MemoBusyError as WidgetConfigBusyError };

// ═══════════════════════════════════════════════════════════════════════
// Platform snapshot and quota
// ═══════════════════════════════════════════════════════════════════════

const platformCache = new MemoCache<WidgetPlatformSnapshot>({
  name: 'widget-platform-snapshot',
  enabled: cachingEnabled,
  ttlMs: (snap) => capped(snap.degraded ? DEGRADED_TTL_MS : PLATFORM_TTL_MS),
  max: () => 1,
  keepPrevious: (previous, next) => next.degraded && !previous.degraded,
  serveStale: (snap) => !snap.degraded,
});

/**
 * The last catalog read that succeeded in this process. It outlives
 * `platformCache.clear()` (every `platform` publish, a Super Admin save
 * included), so a failed read right after one keeps the workspaces' templates
 * instead of switching every visitor to the edition default for the degraded
 * lifetime. A process that has never read it has nothing to keep.
 */
let lastGoodChatTemplates: { builtAt: number; byEdition: Partial<Record<Edition, unknown>>; ready: boolean } | null = null;

async function loadPlatformSnapshot(config: ServerConfig): Promise<WidgetPlatformSnapshot> {
  const builtAt = Date.now();
  const sb = getServiceClient(config);
  const [widgetResult, preChat, namesResult, templateRows] = await Promise.all([
    // Single source of truth for widget URLs — never read platform_domains/branding for these.
    sb.from('widget_platform_settings')
      .select('widget_loader_base_url, widget_asset_base_url, widget_public_base_url, widget_api_base_url, default_welcome_message, powered_by_enabled, powered_by_text, powered_by_brand_text, powered_by_url')
      .limit(1).maybeSingle(),
    loadPlatformPreChatPolicy(sb),
    // Platform identity for the powered-by footer and platform_display_name.
    // NEVER the workspace row. platform_name lives on
    // platform_branding_localized ('en' is the terminal fallback).
    sb.from('platform_branding_localized').select('locale, platform_name'),
    // The chat widget template catalog: its own read, tolerant of a database
    // from before migration 275 (no table = no catalog = the edition's
    // default template, as before). A failed read marks the snapshot
    // degraded (5 s) and serves the last good catalog meanwhile.
    readChatTemplateRows(sb),
  ]);
  // An older build finishing late never replaces a newer good read.
  if (!templateRows.error && (!lastGoodChatTemplates || lastGoodChatTemplates.builtAt <= builtAt)) {
    lastGoodChatTemplates = { builtAt, byEdition: templateRows.byEdition, ready: templateRows.ready };
  }
  const catalogRows = templateRows.error && lastGoodChatTemplates ? lastGoodChatTemplates : templateRows;
  if (namesResult.error) {
    console.warn('[widget] platform brand name lookup failed:', namesResult.error.message);
  }
  const names = new Map<string, string | null>();
  for (const row of (namesResult.data || []) as Array<{ locale?: string | null; platform_name?: string | null }>) {
    if (row.locale) names.set(row.locale, row.platform_name ?? null);
  }
  return {
    builtAt,
    degraded: !!widgetResult.error || preChat.error || !!namesResult.error || templateRows.error,
    widget: (widgetResult.data as Record<string, unknown> | null) ?? null,
    preChatPolicy: preChat.value,
    names,
    chatTemplates: catalogRows.byEdition,
    chatTemplatesReady: catalogRows.ready,
  };
}

export function getWidgetPlatformSnapshot(config: ServerConfig): Promise<WidgetPlatformSnapshot> {
  return platformCache.get('platform', () => loadPlatformSnapshot(config));
}

/** The edition's chat widget template catalog, from a platform snapshot (no I/O). */
export function chatTemplateCatalogOf(platform: WidgetPlatformSnapshot, edition: Edition | null): ChatTemplateCatalog {
  return resolveChatTemplateCatalog(edition, platform.chatTemplates?.[edition ?? 'iran']);
}

/**
 * The running platform's chat widget template catalog, as visitors get it
 * (the platform snapshot, 30 s; a Super Admin save clears it everywhere).
 * `ready` is false before migration 275. For the dashboard routes.
 */
export async function getChatTemplateCatalog(
  config: ServerConfig,
): Promise<{ catalog: ChatTemplateCatalog; edition: Edition | null; ready: boolean }> {
  const [platform, edition] = await Promise.all([getWidgetPlatformSnapshot(config), getPlatformEditionOrNull(config)]);
  return { catalog: chatTemplateCatalogOf(platform, edition), edition, ready: platform.chatTemplatesReady !== false };
}

export interface EffectiveChatTemplate {
  id: string;
  /** null only for an id no descriptor knows (never one the catalog resolves). */
  descriptor: ChatWidgetTemplate | null;
  options: ChatTemplateOptions;
}

/**
 * The chat widget template a workspace's visitors wear and its options (no
 * I/O): the workspace's choice while the edition's catalog has it enabled
 * (`settings` has the plan applied: without widget_appearance the choice reads
 * as none), else the catalog's default. The same answer GET /config gives.
 */
export function resolveEffectiveChatTemplate(
  platform: WidgetPlatformSnapshot,
  edition: Edition | null,
  settings: WidgetSettingsRow | null,
): EffectiveChatTemplate {
  const catalog = chatTemplateCatalogOf(platform, edition);
  const chosen = settings as { widget_template_id?: string | null; widget_template_options?: unknown } | null;
  const id = resolveWidgetTemplateId(resolveEditionWidgetTemplateId(edition, chosen?.widget_template_id, catalog));
  return {
    id,
    descriptor: chatWidgetTemplate(id),
    options: resolveChatTemplateOptions(catalog, id, chosen?.widget_template_options),
  };
}

/**
 * resolveEffectiveChatTemplate for a workspace, from the cached snapshots (no
 * query on a hit): what the server reads before serving or writing anything
 * for a template's feature (the closed line, the rating after a chat, the
 * transcript by email), so it never disagrees with the widget the visitor
 * has. Throws only when the snapshot build does (as GET /config would fail).
 *
 * Without widget settings (no row, or a read that failed: the degraded
 * snapshot's few seconds) GET /config serves no widget, and the choice is
 * unknown: it reads as the edition's own template (`default` / `intl`), never
 * the catalog's default, so a workspace that chose `default` is not taken
 * for Template 2 while its row cannot be read.
 */
export async function workspaceChatTemplate(config: ServerConfig, workspaceId: string): Promise<EffectiveChatTemplate> {
  const [snap, platform, edition] = await Promise.all([
    getWorkspaceWidgetSnapshot(config, workspaceId),
    getWidgetPlatformSnapshot(config),
    getPlatformEditionOrNull(config),
  ]);
  if (!snap.settings) {
    const id = EDITION_CHAT_WIDGET_TEMPLATES[edition ?? 'iran'].default;
    return { id, descriptor: chatWidgetTemplate(id), options: {} };
  }
  return resolveEffectiveChatTemplate(platform, edition, snap.settings);
}

const quotaCache = new MemoCache<boolean | null>({
  name: 'widget-quota-full',
  enabled: cachingEnabled,
  ttlMs: () => capped(QUOTA_TTL_MS),
  max: maxEntries,
});

/** resolveConversationQuotaFull, cached 60 s per workspace (usage has no write hook). */
export function getQuotaFull(config: ServerConfig, workspaceId: string): Promise<boolean | null> {
  const key = cacheKey(workspaceId);
  if (!key) return Promise.resolve(null);
  return quotaCache.get(key, () => resolveConversationQuotaFull(config, key));
}

// ═══════════════════════════════════════════════════════════════════════
// Per-request payloads (no I/O)
// ═══════════════════════════════════════════════════════════════════════

export interface WidgetConfigInputs {
  config: ServerConfig;
  req: Request;
  workspaceId: string;
  snap: WorkspaceWidgetSnapshot;
  platform: WidgetPlatformSnapshot;
  edition: Edition | null;
  platformLocales: string[];
  /** getPlatformAiAgentSettings(), or null when it failed. */
  aiPlatform: PlatformAiAgentSettings | null;
  quotaFull: boolean | null;
  now: Date;
}

/**
 * The GET /api/widget/config body (and POST /bootstrap's inline `config`),
 * from the snapshot. Moved from the route; the output is unchanged apart
 * from the asset URLs (widgetAssetUrl) and the additive `modules.rt_*`.
 */
export async function buildWidgetConfigBody(input: WidgetConfigInputs): Promise<{ status: number; body: Record<string, unknown> }> {
  const { config, req, workspaceId, snap, platform, edition, platformLocales, aiPlatform, quotaFull, now } = input;
  const widget = snap.widgetRow;
  if (!widget) {
    return { status: 404, body: { error: 'Widget not found or not configured' } };
  }

  if (!widget.enabled) {
    return { status: 200, body: { enabled: false } };
  }

  const ws = snap.settings;
  const widgetEntitlements = snap.entitlements;
  const branding = snap.branding;
  const platformWidget = platform.widget as Record<string, string | boolean | null> | null;
  const platformBranding = platform.names.has('en') ? { platform_name: platform.names.get('en') } : null;
  const poweredByPlanAllows = snap.poweredByPlanAllows;
  const workspace = snap.workspace;

  const smartPayload = {
    enabled: snap.smart.enabled,
    rules: snap.smart.rules.filter((rule) => isSmartRuleUnexpired(rule, now.getTime())),
  };

  // The platform switches are read per request (15 s cache): the snapshot
  // may be minutes old, a kill switch must not wait for it.
  const aiProactiveSnapshot: { enabled: boolean; mode: string } = aiPlatform?.ai_proactive_nudge_enabled !== true
    ? { enabled: false, mode: 'off' }
    : { ...snap.aiProactive };
  const platformDisabled = !!aiPlatform && aiPlatform.ai_agent_enabled === false;
  const aiAgentInfo: WidgetAiAgentInfo = platformDisabled ? aiAgentDisabledByPlatform(aiPlatform) : snap.aiAgent;

  let teamMembers: Array<{ name: string; avatar: string | null; online: boolean }> = [];
  if (snap.team) {
    // Resolve who's online right now so the widget can render a green status
    // dot on each avatar. Visitor-facing dots follow CUSTOMER availability
    // (manual status + schedule), never connection state.
    const presenceByUser = new Map<string, 'online' | 'offline'>();
    try {
      const { available } = await listCustomerAvailableOperators(config, workspaceId, now, snap.availabilityPrefs);
      for (const op of available) presenceByUser.set(op.user_id, 'online');
    } catch { /* presence is cosmetic — never fail the bootstrap */ }
    teamMembers = snap.team.map((p) => ({
      name: p.name,
      avatar: p.avatar,
      online: presenceByUser.get(p.id) === 'online',
    }));
    // Online operators first so the stack leads with available staff.
    teamMembers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  }

  const apiBase = resolveWidgetApiBase({
    widgetApiBaseUrl: platformWidget?.widget_api_base_url as string | null | undefined,
    platformApiBaseUrl: null,
    requestBaseUrl: getRequestBaseUrl(req),
    allowRequestFallback: !platformWidget?.widget_api_base_url,
  });
  const assetBase = resolveWidgetAssetBase({
    widgetBaseUrl: platformWidget?.widget_asset_base_url as string | null | undefined,
    widgetLoaderBaseUrl: platformWidget?.widget_loader_base_url as string | null | undefined,
    widgetPublicBaseUrl: platformWidget?.widget_public_base_url as string | null | undefined,
    assetBaseUrl: platformWidget?.widget_asset_base_url as string | null | undefined,
    loaderAssetBase: getLoaderAssetBase(req),
  });

  const runtimeJsName = getWidgetAssetName('runtime.js');
  const runtimeCssName = getWidgetAssetName('runtime.css');
  const callRuntimeJsName = getWidgetAssetName('runtime-call.js');
  // Presentation layer — registry + active template assets. Widget Core
  // ships no markup, so these are part of the required boot payload.
  // The platform's edition and the Super Admin's catalog pick the template
  // (shared/chatTemplateCatalog.ts): the workspace's choice while it is
  // enabled (`ws` has the plan applied: without widget_appearance the choice
  // reads as none), else the catalog's default. With no catalog — no row, a
  // database from before migration 275 — the Iranian edition, and an
  // edition that cannot be read, wear `default` exactly as before; the
  // International edition wears `intl`. The browser registry resolves the
  // same ids. Its options ride along; the template's display name never does.
  const {
    id: templateId,
    descriptor: templateDescriptor,
    options: templateOptions,
  } = resolveEffectiveChatTemplate(platform, edition, ws);

  const templateAssets = widgetTemplateAssetKeys(templateId);
  const presentationRegistryJsName = getWidgetAssetName('presentation-registry.js');
  const presentationJsName = getWidgetAssetName(templateAssets.script);
  const presentationCssName = getWidgetAssetName(templateAssets.style);
  // A skin template's own stylesheet, loaded after the base one (none in
  // the Iranian edition).
  const presentationSkinCssName = templateAssets.skin ? getOptionalWidgetAssetName(templateAssets.skin) : null;
  // Optional, template-owned font asset (hashed). Resolved existence-aware:
  // templates that ship no font asset yield `null`, so the loader never
  // requests a 404. The loader stays generic either way.
  const presentationFontsCssName = getOptionalWidgetAssetName(templateAssets.fonts);

  const chatModuleName = getWidgetAssetName('runtime-chat.js');
  const kbModuleName = getWidgetAssetName('runtime-kb.js');
  const smartEngineName = getWidgetAssetName('smart-engine.js');
  // Self-hosted LiveKit JS SDK. Hashed at build time so we can serve it
  // with `immutable, max-age=1y`. The widget never contacts a CDN for
  // this asset — see scripts/widget-hash.js VENDOR_FILES.
  const livekitSdkName = getWidgetAssetName('vendor/livekit-client.umd.min.js');
  const loaderVersion = getLoaderVersion();
  const preChat = buildPreChatConfig(platform.preChatPolicy, snap.preChatFlags || []);
  // Platform region lock — a single-language deployment must serve the
  // widget only in that language, whatever the workspace row still holds.
  const clampLoc = (loc: string | null | undefined, fallbackToFirst = true) => {
    const base = String(loc || '').toLowerCase().split('-')[0];
    if (base && platformLocales.includes(base)) return base;
    return fallbackToFirst ? (platformLocales[0] || 'en') : '';
  };
  const effectiveLocale = clampLoc(
    ws.widget_language && ws.widget_language !== 'auto' ? ws.widget_language : ws.locale,
  );
  const effectiveWidgetLanguage =
    platformLocales.length === 1
      ? platformLocales[0]
      : ws.widget_language && ws.widget_language !== 'auto'
        ? clampLoc(ws.widget_language)
        : 'auto';
  // A content-hashed name is its own version (no query); an unhashed
  // fallback name keeps ?v=<loaderVersion> (see widgetAssetUrl).
  const assetUrl = (name: string | null) => widgetAssetUrl(assetBase, name, loaderVersion);
  // Powered-by footer — platform admin owns wording, brand and link;
  // plans decide who sees it. The workspace may only hide it when its plan
  // grants `widget_powered_by_toggle` (default preference: shown).
  const workspaceMayHidePoweredBy = widgetEntitlements?.features?.widget_powered_by_toggle === true;
  const workspaceWantsPoweredBy = workspaceMayHidePoweredBy
    ? ws.show_powered_by !== false
    : true;
  // The platform's own name (the panel's source, platform_branding_
  // localized): in the International edition in the widget's language,
  // else — and in the Iranian edition — the English row.
  const platformBrandName = (() => {
    if (edition === 'international' && effectiveLocale && effectiveLocale !== 'en') {
      const name = String(platform.names.get(effectiveLocale) || '').trim();
      if (name) return name;
    }
    return String(platformBranding?.platform_name || '').trim();
  })();
  const poweredBy = buildPoweredByConfig(
    platformWidget as Record<string, unknown>,
    // Iran (and an unknown edition) credits the English platform name, as
    // it always did; International credits it in the widget's language.
    edition === 'international' ? platformBrandName : platformBranding?.platform_name || '',
    poweredByPlanAllows && workspaceWantsPoweredBy,
  );
  // The International template credits the platform with its logo (the
  // RESPOK kit's horizontal mark, the one the app's launch screen wears;
  // the "color" variant, drawn for the widget's light surface). Absolute:
  // the widget runs on customers' sites.
  if (poweredBy && edition === 'international' && assetBase) {
    (poweredBy as typeof poweredBy & { logo?: string }).logo = `${assetBase}${INTL_BRAND.horizontal.light}`;
  }
  // The Iranian edition (region_mode = 'iran' exactly; an edition that
  // cannot be read keeps the text) credits WebYar with the brand kit's
  // Persian logotype ("color", for the widget's light surface); its name
  // stays the alt text and the fallback if the image cannot load.
  if (poweredBy && isWebyarKitEdition(edition) && assetBase) {
    (poweredBy as typeof poweredBy & { logo?: string }).logo = `${assetBase}${WEBYAR_BRAND.logo.light}`;
  }
  // Dates: Jalali in Tehran time for Persian in the Iranian edition (as
  // before); Gregorian in the visitor's own zone in the International one.
  const dateHints = widgetDateHints(edition);
  const widgetConfig = {
    enabled: true,
    workspaceId,
    apiBase,
    assetBase,
    debugMode: ws.debug_mode ?? false,
    // Workspace identity owns all widget headers. Platform identity is
    // intentionally separate and is used only by the powered-by footer.
    // An explicit empty string means the workspace cleared the display name.
    brandName: typeof ws.brand_name === 'string'
      ? ws.brand_name.trim()
      : (workspace?.name || 'Support'),

    // Explicit platform brand for the "powered by" footer. The footer must
    // ALWAYS name the platform, never the workspace's own brand.
    platformName: poweredBy?.brand || '',
    poweredBy,
    showPoweredBy: !!poweredBy,

    // The platform's edition and identity (additive). `edition` is null
    // when the platform settings could not be read; the widget then
    // behaves as the Iranian edition, as it always did.
    edition,
    platformBrandName,
    calendar: dateHints.calendar,
    timeZone: dateHints.timeZone,


    primaryColor: ws.primary_color || branding?.primary_color || '#3B82F6',
    secondaryColor: ws.secondary_color || '#6366f1',
    // `widget_settings.logo_url` (an operator-typed external link) or the
    // workspace's own logo derived from its storage key — snapshot.
    logoUrl: snap.logoUrl,
    launcherText: resolveLocalizedDefault(
      ws.launcher_text,
      'launcher',
      effectiveLocale,
    ),
    // Three-tier resolution: workspace override → platform default → hardcoded fallback.
    // Stored in `widget_settings.welcome_message` (per-workspace) or
    // `widget_platform_settings.default_welcome_message` (platform-wide).
    welcomeMessage:
      resolveLocalizedDefault(
        ws.welcome_message,
        'welcome',
        effectiveLocale,
      )
      || platformWidget?.default_welcome_message
      || '',
    // Workspace-authored reply-time note for the widget header. An explicit
    // empty string means "hide it"; NULL (never configured) falls back to
    // the locale default in the presentation layer.
    replyTimeText: typeof ws.reply_time_text === 'string' ? ws.reply_time_text.trim() : null,

    greetingMessage: ws.greeting_message || '',
    placeholderText: ws.placeholder_text || '',
    offlineMessage: ws.offline_message || '',
    position: ws.position || 'bottom-right',
    locale: effectiveLocale,
    widgetLanguage: effectiveWidgetLanguage,
    loaderVersion,
    theme: ws.theme || 'modern',
    fab: {
      icon: ws.fab_icon || 'chat',
      helpIcon: ws.fab_help_icon || 'help_circle',
      shape: ws.fab_shape || 'circle',
      label: ws.fab_label || '',
      chatLabel: ws.fab_chat_label || '',
      helpLabel: ws.fab_help_label || '',
      scale: ws.fab_scale ?? 100,
      iconColor: ws.fab_icon_color || '#ffffff',
      textColor: ws.fab_text_color || '#ffffff',
      animation: ws.fab_animation ?? true,
      // Optional launcher image, derived from its storage key (snapshot).
      // The storage key itself is never sent to a visitor. On hover the
      // runtime circle-reveals the configured icon underneath.
      imageUrl: snap.fabImageUrl,
    },
    features: {
      chat: ws.chat_enabled ?? true,
      knowledgeBase: ws.kb_enabled ?? true,
      visitorTracking: ws.visitor_tracking_enabled ?? true,
    },
    preChat,
    // Phase 8 — Server-authoritative availability. Computed via resolver
    // so runtime never has to interpret weekly schedules. Locked rules:
    //  - business_hours.enabled === false  =>  state = 'online' always.
    //  - offline_message comes from offline_message_localized (per-locale)
    //    with legacy offline_message as fallback. No translation pipeline.
    // `quota_full` (phase 4) only while billing locks are on: the monthly
    // chat quota is full, so a new conversation goes to the
    // leave-a-message form (see resolveConversationQuotaFull).
    availability: snapshotToWirePayload(
      await resolveAvailability(config, {
        workspaceId,
        locale: effectiveLocale,
        // The raw row (not the entitlement-applied `ws`), as its own read was.
        settingsRow: widget,
        availabilityPrefs: snap.availabilityPrefs,
        now,
      }),
      { quota_full: quotaFull },
    ),
    // Phase 6a — Attachment config exposed to the widget runtime.
    // The widget enforces these as a UX guard; the backend re-validates.
    attachments: {
      enabled: ws.attachments_enabled === true,
      maxSizeMb: Math.max(1, Math.min(25, ws.attachments_max_size_mb ?? 10)),
      allowedMimes: Array.isArray(ws.attachments_allowed_mimes) && ws.attachments_allowed_mimes.length > 0
        ? ws.attachments_allowed_mimes
        : ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain'],
      maxCount: 1, // v1: single file per message
      // Voice notes — independent toggle from file attachments (own
      // fixed audio-mime allow-list is enforced server-side, not
      // configurable via allowedMimes above).
      voiceNotesEnabled: ws.voice_notes_enabled === true,
    },
    composer: {
      emojiEnabled: ws.emoji_enabled !== false,
    },
    // Phase 7 — Read receipts toggle. When false, the widget shows only
    // sending/sent (no "Seen" indicator). The widget never invents seen
    // state; it only renders what the backend has actually recorded.
    readReceipts: {
      enabled: ws.read_receipts_enabled !== false,
    },
    supportMode: ws.support_mode || 'human_first',
    defaultMode: ws.default_mode || 'chat',
    mobileBehavior: ws.mobile_behavior || 'bottom_sheet',
    autoOpenDelay: ws.auto_open_delay || 0,
    showLogo: ws.show_logo ?? true,
    showTeamAvatars: ws.show_team_avatars !== false,
    workspaceName: typeof ws.brand_name === 'string'
      ? ws.brand_name.trim()
      : (workspace?.name || ''),

    teamMembers,
    onlineOperators: 0, // Resolved client-side from realtime presence when supported.
    runtimeUrl: assetUrl(runtimeJsName),
    styleUrl: assetUrl(runtimeCssName),
    callRuntimeUrl: assetUrl(callRuntimeJsName),
    templateId,
    // Additive: the template's options (shared/chatTemplateCatalog.ts), `{}`
    // for a template without any (the Iranian `default`).
    templateOptions,
    presentationRegistryUrl: assetUrl(presentationRegistryJsName),
    presentationUrl: assetUrl(presentationJsName),
    presentationStyleUrl: assetUrl(presentationCssName),
    // Additive: the template's skin stylesheet, loaded after the base one;
    // null when the template has none (the Iranian `default`).
    presentationSkinUrl: assetUrl(presentationSkinCssName),
    presentationFontsUrl: assetUrl(presentationFontsCssName),

    // Pass 1 — explicit LiveKit SDK URL. Self-hosted, hashed asset. The
    // call runtime MUST consume this and never fall back to a CDN. When
    // assetBase is unresolved (very unusual — most likely a misconfigured
    // deploy) we surface `null` so the widget can render a clear
    // `provider_not_ready` error instead of silently breaking.
    livekitSdkUrl: assetUrl(livekitSdkName),
    // Lazy runtime modules, keyed by runtime.js's ModuleLoader names
    // ('rt_' + vendor for the realtime drivers). Additive: an older runtime
    // ignores the keys it does not know and loads the canonical names.
    modules: {
      chat: assetUrl(chatModuleName),
      kb: assetUrl(kbModuleName),
      // Core's renderer features (runtime-ext.js), named only for a template
      // whose renderer declares some (shared/widgetTemplates.ts
      // `coreFeatures`): the loader fetches it with that template's files.
      // `default` and `intl` never get it, so their payload is as before.
      ...(templateDescriptor?.coreFeatures ? { ext: assetUrl(getWidgetAssetName('runtime-ext.js')) } : {}),
      // The late pack of such a template whose renderer has extras: the
      // extras and Core's late module, which runtime-ext.js requests after
      // the first paint (the loader never does). `default` and `intl` have
      // none.
      ...(templateDescriptor?.coreFeatures && templateDescriptor.extras ? {
        late: assetUrl(getWidgetAssetName('runtime-late.js')),
        extras: assetUrl(getWidgetAssetName(templateDescriptor.extras)),
      } : {}),
      rt_resolver: assetUrl(getWidgetAssetName('runtime-rt-resolver.js')),
      rt_centrifugo: assetUrl(getWidgetAssetName('runtime-rt-centrifugo.js')),
      rt_supabase: assetUrl(getWidgetAssetName('runtime-rt-supabase.js')),
    },
    // Smart Engagement — proactive rules. The payload is already
    // sanitized and stripped of management fields; evaluation happens in
    // the browser with the shared engine bundle.
    smart: {
      enabled: smartPayload.enabled,
      engineUrl: smartPayload.enabled
        ? assetUrl(smartEngineName)
        : null,
      rules: smartPayload.rules,
      // AI Proactive Nudge — {enabled, mode} only, see resolveEffectiveAiNudgePolicy.
      aiProactive: aiProactiveSnapshot,
    },
    // Phase 4 — AI Agent snapshot. Used by the widget runtime to decide
    // whether to suppress the generic welcome greeting (the AI intro will
    // take its place after pre-chat).
    aiAgent: aiAgentInfo,
  };

  return { status: 200, body: widgetConfig };
}

/**
 * GET /config's body for `workspaceId`: gathers the inputs (all cached) in
 * parallel and builds it. POST /bootstrap passes what it already holds.
 */
export async function resolveWidgetConfigBody(
  config: ServerConfig,
  req: Request,
  workspaceId: string,
  known: {
    snap?: WorkspaceWidgetSnapshot;
    platform?: WidgetPlatformSnapshot;
    edition?: Edition | null;
    quotaFull?: boolean | null;
    now?: Date;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [snap, platform, edition, platformLocales, aiPlatform, quotaFull] = await Promise.all([
    known.snap ?? getWorkspaceWidgetSnapshot(config, workspaceId),
    known.platform ?? getWidgetPlatformSnapshot(config),
    'edition' in known ? known.edition : getPlatformEditionOrNull(config),
    getPlatformAllowedLocales(config),
    getPlatformAiAgentSettings(config).catch(() => null),
    'quotaFull' in known ? known.quotaFull : getQuotaFull(config, workspaceId),
  ]);
  return buildWidgetConfigBody({
    config,
    req,
    workspaceId,
    snap,
    platform,
    edition,
    platformLocales,
    aiPlatform,
    quotaFull,
    now: known.now ?? new Date(),
  });
}

/**
 * Phase 8 — the bootstrap's server-authoritative availability, from the
 * snapshot (the raw row and the prefs) at `now`; no I/O.
 */
export async function bootstrapAvailability(
  config: ServerConfig,
  workspaceId: string,
  snap: WorkspaceWidgetSnapshot,
  localeHint: string,
  now: Date,
  quotaFull: boolean | null,
): Promise<ReturnType<typeof snapshotToWirePayload>> {
  const availability = await resolveAvailability(config, {
    workspaceId,
    locale: localeHint,
    settingsRow: snap.widgetRow,
    availabilityPrefs: snap.availabilityPrefs,
    now,
  });
  return snapshotToWirePayload(availability, { quota_full: quotaFull });
}

// ═══════════════════════════════════════════════════════════════════════
// Invalidation (lib/cacheBus.ts). Handlers are local and never publish.
// ═══════════════════════════════════════════════════════════════════════

// A resync (the bus reconnected; nothing known changed) expires instead of
// dropping: each workspace's next page view is answered from its old copy
// while ONE gated background rebuild runs, instead of every active workspace
// rebuilding in the foreground at once.
onInvalidate('widget', (workspaceId, { resync }) => {
  if (!workspaceId) {
    if (resync) {
      snapshots.expireAll();
      quotaCache.expireAll();
    } else {
      snapshots.clear();
      quotaCache.clear();
    }
    return;
  }
  const key = cacheKey(workspaceId);
  if (!key) return;
  snapshots.invalidate(key);
  quotaCache.invalidate(key);
});

// A profile (name, avatar) or availability change: every snapshot whose
// team holds that user. Builds already running may have read the old row.
onInvalidate('user', (userId, { resync }) => {
  if (!userId) {
    if (resync) snapshots.expireAll();
    else snapshots.clear();
    return;
  }
  const id = userId.toLowerCase();
  snapshots.invalidateWhere((snap) => snap.memberIds.has(id));
});

// Platform-wide inputs: the platform snapshot, and the platform AI settings
// a snapshot build reads (a rebuild right after an invalidation must not
// see the 15 s cached old row).
onInvalidate('platform', (_key, { resync }) => {
  if (resync) platformCache.expireAll();
  else platformCache.clear();
  __resetPlatformAiAgentSettingsCache();
});

/** Test-only — forget every snapshot, the platform snapshot and quota answers. */
export function __resetWidgetConfigCachesForTests(): void {
  snapshots.clear();
  platformCache.clear();
  lastGoodChatTemplates = null;
  quotaCache.clear();
  rebuildGate.reset();
}

/** Test-only — the cached snapshot of a workspace, without building one. */
export function __peekWidgetSnapshotForTests(workspaceId: string): WorkspaceWidgetSnapshot | undefined {
  const key = cacheKey(workspaceId);
  return key ? snapshots.peek(key) : undefined;
}
