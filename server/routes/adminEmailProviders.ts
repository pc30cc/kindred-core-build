/**
 * ADMIN — THE PLATFORM'S EMAIL PROVIDERS
 *
 * Mounted under the admin router, so `requireAdmin` (platform admin, checked
 * on the server) already gates every route here.
 *
 * Super Admin → Providers → Email talks only to these routes. Two slots, the
 * two rows of the config store (server/services/email/providerConfigStore.ts):
 *
 *   default       `default_email_provider`: every mail the platform sends;
 *   notification  `notification_email_provider`: optional, the operator
 *                 notification mails when Super Admin → Notifications
 *                 points them at a second provider (the dispatcher's key).
 *
 * The browser names a slot, never a row key, and never sees a secret: a
 * read carries every field that is not one plus the names of the secrets
 * that are set; a save goes through the store, which validates it against
 * the provider registry, keeps a secret left blank, encrypts what it stores
 * and writes the audit row this page shows ("changed by whom, and when").
 *
 * "Test connection" signs in without sending (the adapter's verify), and
 * "Send test email" sends one real mail through the slot's provider to the
 * signed-in admin's own address, which the server looks up: the request
 * cannot name a recipient, so the button cannot mail anyone else.
 *
 * Also here: the suppression list (addresses the platform no longer mails),
 * to search, list and remove from.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { isPluginCryptoConfigured } from '../lib/pluginCrypto.js';
import { insertAuditLogRows } from '../services/auditLog.js';
import { operatorLocale, type OperatorLocale } from '../services/operatorLocale.js';
import { sendEmail } from '../services/email/index.js';
import {
  loadEmailProviderConfig,
  readEmailProviderForAdmin,
  verifyEmailProvider,
  writeEmailProviderConfig,
  type EmailProviderKey,
} from '../services/email/providerConfigStore.js';
import { emailProviderProblems, emailProviderReadiness } from '../services/email/providers/index.js';
import { listEmailSuppressions, suppressionKey, unsuppressEmailAddress } from '../services/email/suppressions.js';
import { EMAIL_PROVIDER_ADAPTERS, parseEmailAddress, type EmailProviderConfigProblem } from '../../shared/emailProviders.js';

export const adminEmailProvidersRouter = Router();

interface AdminRequestContext {
  serverConfig: ServerConfig;
  adminUser?: { id: string };
}

function ctx(req: Request): AdminRequestContext {
  return req as Request & AdminRequestContext;
}

export const EMAIL_PROVIDER_SLOTS = {
  default: 'default_email_provider',
  notification: 'notification_email_provider',
} as const satisfies Record<string, EmailProviderKey>;
export type EmailProviderSlot = keyof typeof EMAIL_PROVIDER_SLOTS;

function slotOf(value: unknown): EmailProviderSlot | null {
  return value === 'default' || value === 'notification' ? value : null;
}

function slotOfKey(key: unknown): EmailProviderSlot | null {
  if (key === EMAIL_PROVIDER_SLOTS.default) return 'default';
  if (key === EMAIL_PROVIDER_SLOTS.notification) return 'notification';
  return null;
}

/** The action the config store writes for every change of either slot. */
const CHANGE_ACTION = 'admin.email_provider.changed';
const HISTORY_LIMIT = 20;

// ─── Test / send rate limit: 5 per minute per admin and action ───
//
// A test mail is a real mail from the platform's own sending address, and
// both checks open a connection to the provider: a button held down must not
// turn into a burst the relay or a provider counts against the domain.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const rateHits = new Map<string, number[]>();

function allowCall(key: string, now = Date.now()): boolean {
  const hits = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

/** Exposed for tests. */
export function __resetEmailProviderAdminRateLimit(): void {
  rateHits.clear();
}

// ─── The page's state ────────────────────────────────────────────

interface ChangeView {
  at: string;
  slot: EmailProviderSlot;
  provider_name: string | null;
  previous_provider: string | null;
  changed_fields: string[];
  actor: { id: string; name: string | null; email: string | null } | null;
}

interface SlotView {
  provider_name: string | null;
  config: Record<string, unknown>;
  secretKeysSet: string[];
  /** The send path's own reading (an adapter, its required fields, a valid from_email). */
  readiness: 'unconfigured' | 'configured' | 'invalid';
  problems: EmailProviderConfigProblem[];
  lastChange: ChangeView | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The last changes of either slot, newest first, each with who made it. The
 * audit row holds the provider and the names of the fields that changed,
 * never a value, so nothing here can carry a secret.
 */
async function readHistory(config: ServerConfig): Promise<ChangeView[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('audit_logs')
    .select('user_id, created_at, old_value, new_value')
    .eq('action', CHANGE_ACTION)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    console.warn('[admin/email] change history could not be read:', error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{ user_id?: string | null; created_at?: string; old_value?: unknown; new_value?: unknown }>;
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => typeof id === 'string' && !!id))];
  const people = new Map<string, { name: string | null; email: string | null }>();
  if (userIds.length) {
    const { data: profiles } = await sb.from('profiles').select('id, email, full_name').in('id', userIds);
    for (const p of (profiles ?? []) as Array<{ id: string; email?: string | null; full_name?: string | null }>) {
      people.set(String(p.id), { name: text(p.full_name), email: text(p.email) });
    }
  }
  const out: ChangeView[] = [];
  for (const row of rows) {
    const next = asRecord(row.new_value);
    const slot = slotOfKey(next.key);
    if (!slot) continue;
    const id = typeof row.user_id === 'string' ? row.user_id : null;
    out.push({
      at: String(row.created_at ?? ''),
      slot,
      provider_name: text(next.provider_name),
      previous_provider: text(asRecord(row.old_value).provider_name),
      changed_fields: Array.isArray(next.changed_fields) ? next.changed_fields.filter((f): f is string => typeof f === 'string') : [],
      actor: id ? { id, ...(people.get(id) ?? { name: null, email: null }) } : null,
    });
  }
  return out;
}

async function readSlot(config: ServerConfig, slot: EmailProviderSlot, history: ChangeView[]): Promise<SlotView> {
  const key = EMAIL_PROVIDER_SLOTS[slot];
  const admin = await readEmailProviderForAdmin(config, key);
  const loaded = await loadEmailProviderConfig(config, key);
  const provider = loaded.status === 'ok' ? loaded.provider : null;
  return {
    ...admin,
    readiness: emailProviderReadiness(provider),
    problems: provider ? emailProviderProblems(provider) : [],
    lastChange: history.find((h) => h.slot === slot) ?? null,
  };
}

/** The signed-in admin's own address: the only recipient of a test mail. */
async function adminAddress(config: ServerConfig, adminId: string | null): Promise<string | null> {
  if (!adminId) return null;
  const { data } = await getServiceClient(config).from('profiles').select('email').eq('id', adminId).maybeSingle();
  return parseEmailAddress((data as { email?: unknown } | null)?.email);
}

/**
 * The Reply-To an admin once typed under Branding → Email settings. It
 * never reached a single mail (that field was read by nothing), and Reply-To
 * now lives on the provider; the page offers the old value while the
 * provider has none, so it is not lost with the field.
 */
async function legacyReplyTo(config: ServerConfig): Promise<string | null> {
  try {
    const { data } = await getServiceClient(config)
      .from('email_settings')
      .select('reply_to_email')
      .is('workspace_id', null)
      .maybeSingle();
    return parseEmailAddress((data as { reply_to_email?: unknown } | null)?.reply_to_email);
  } catch {
    return null;
  }
}

async function readState(config: ServerConfig, adminId: string | null) {
  const history = await readHistory(config);
  const [defaultSlot, notificationSlot, testRecipient, oldReplyTo] = await Promise.all([
    readSlot(config, 'default', history),
    readSlot(config, 'notification', history),
    adminAddress(config, adminId),
    legacyReplyTo(config),
  ]);
  return {
    slots: { default: defaultSlot, notification: notificationSlot },
    adapters: EMAIL_PROVIDER_ADAPTERS,
    history,
    testRecipient,
    // A new secret is refused without PLUGIN_SECRETS_MASTER_KEY; the page
    // says so before anyone types one.
    encryptionAvailable: isPluginCryptoConfigured(config.pluginSecretsMasterKey),
    legacyReplyTo: oldReplyTo && !text(defaultSlot.config.reply_to) ? oldReplyTo : null,
  };
}

function fail(res: Response, err: unknown): void {
  // The store's read error names the database's message; the browser gets
  // the code only, the console the rest.
  console.warn('[admin/email]', err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: 'email_provider_unavailable' });
}

adminEmailProvidersRouter.get('/', async (req, res) => {
  try {
    res.json(await readState(ctx(req).serverConfig, ctx(req).adminUser?.id ?? null));
  } catch (err) {
    fail(res, err);
  }
});

// ─── Suppressions (before /:slot, which would otherwise match) ───

const suppressionQuery = z.object({
  search: z.string().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

adminEmailProvidersRouter.get('/suppressions', async (req, res) => {
  const parsed = suppressionQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query' });
  try {
    return res.json(await listEmailSuppressions(ctx(req).serverConfig, parsed.data));
  } catch (err) {
    return fail(res, err);
  }
});

adminEmailProvidersRouter.delete('/suppressions/:address', async (req, res) => {
  const config = ctx(req).serverConfig;
  const address = suppressionKey(String(req.params.address ?? ''));
  if (!address) return res.status(400).json({ error: 'invalid_address' });
  try {
    const removed = await unsuppressEmailAddress(config, address);
    if (removed) {
      const { error } = await insertAuditLogRows(config, getServiceClient(config), {
        workspace_id: null,
        user_id: ctx(req).adminUser?.id ?? null,
        action: 'admin.email_suppression.removed',
        entity_type: 'email_suppressions',
        entity_id: null,
        new_value: { address },
      });
      if (error) console.warn('[admin/email] suppression removal was not audited:', error.message);
    }
    return res.json({ removed });
  } catch (err) {
    return fail(res, err);
  }
});

// ─── One slot ────────────────────────────────────────────────────

const saveBody = z.object({
  provider_name: z.string().trim().min(1).max(64),
  config: z.record(z.unknown()).default({}),
});

adminEmailProvidersRouter.put('/:slot', async (req, res) => {
  const slot = slotOf(req.params.slot);
  if (!slot) return res.status(404).json({ error: 'unknown_slot' });
  const parsed = saveBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_field', field: 'config' });
  const config = ctx(req).serverConfig;
  const adminId = ctx(req).adminUser?.id ?? null;
  if (!adminId) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { provider_name, config: fields } = parsed.data;
    const result = await writeEmailProviderConfig(config, EMAIL_PROVIDER_SLOTS[slot], { provider_name, config: fields ?? {} }, { userId: adminId });
    if ('error' in result) {
      const status = result.error === 'storage_error' ? 500 : 400;
      return res.status(status).json({ error: result.error, ...(result.field ? { field: result.field } : {}) });
    }
    return res.json(await readState(config, adminId));
  } catch (err) {
    return fail(res, err);
  }
});

adminEmailProvidersRouter.delete('/:slot', async (req, res) => {
  const slot = slotOf(req.params.slot);
  if (!slot) return res.status(404).json({ error: 'unknown_slot' });
  const config = ctx(req).serverConfig;
  const adminId = ctx(req).adminUser?.id ?? null;
  if (!adminId) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await writeEmailProviderConfig(config, EMAIL_PROVIDER_SLOTS[slot], { provider_name: 'disabled', config: {} }, { userId: adminId });
    if ('error' in result) return res.status(500).json({ error: result.error });
    return res.json(await readState(config, adminId));
  } catch (err) {
    return fail(res, err);
  }
});

adminEmailProvidersRouter.post('/:slot/verify', async (req, res) => {
  const slot = slotOf(req.params.slot);
  if (!slot) return res.status(404).json({ error: 'unknown_slot' });
  const adminId = ctx(req).adminUser?.id ?? 'unknown';
  if (!allowCall(`${adminId}:verify`)) return res.status(429).json({ error: 'rate_limited' });
  try {
    // verifyEmailProvider's detail is the store's own sentence: never a
    // credential, never the provider's raw text.
    return res.json(await verifyEmailProvider(ctx(req).serverConfig, EMAIL_PROVIDER_SLOTS[slot]));
  } catch (err) {
    return fail(res, err);
  }
});

/** The test mail, in the admin's own language (fa/en/tr), as plain as the rest of the platform's mail. */
const TEST_MAIL: Record<OperatorLocale, { subject: string; body: (slot: string, provider: string, at: string) => string; slots: Record<EmailProviderSlot, string> }> = {
  en: {
    subject: 'Test email',
    slots: { default: 'the platform email provider', notification: 'the notification email provider' },
    body: (slot, provider, at) => `This test email was sent from Super Admin → Providers → Email through ${slot} (${provider}) at ${at}.\n\nIf you can read it, the provider delivered it. Nothing else needs to be done.`,
  },
  fa: {
    subject: 'ایمیل آزمایشی',
    slots: { default: 'سرویس ایمیل پلتفرم', notification: 'سرویس ایمیل اعلان‌ها' },
    body: (slot, provider, at) => `این ایمیل آزمایشی از سوپر ادمین ← سرویس‌دهنده‌ها ← ایمیل، با ${slot} (${provider}) در ${at} فرستاده شد.\n\nاگر آن را می‌خوانید، سرویس آن را رسانده است. کار دیگری لازم نیست.`,
  },
  tr: {
    subject: 'Test e-postası',
    slots: { default: 'platform e-posta sağlayıcısı', notification: 'bildirim e-posta sağlayıcısı' },
    body: (slot, provider, at) => `Bu test e-postası Süper Yönetici → Sağlayıcılar → E-posta bölümünden ${slot} (${provider}) ile ${at} tarihinde gönderildi.\n\nOkuyabiliyorsanız sağlayıcı teslim etti. Başka bir şey yapmanız gerekmiyor.`,
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

adminEmailProvidersRouter.post('/:slot/test-send', async (req, res) => {
  const slot = slotOf(req.params.slot);
  if (!slot) return res.status(404).json({ error: 'unknown_slot' });
  const config = ctx(req).serverConfig;
  const adminId = ctx(req).adminUser?.id ?? null;
  if (!adminId) return res.status(401).json({ error: 'unauthorized' });
  if (!allowCall(`${adminId}:send`)) return res.status(429).json({ error: 'rate_limited' });
  try {
    const to = await adminAddress(config, adminId);
    if (!to) return res.status(400).json({ error: 'no_admin_address' });
    const key = EMAIL_PROVIDER_SLOTS[slot];
    const loaded = await loadEmailProviderConfig(config, key);
    // sendEmail falls back to the platform provider when the notification
    // slot cannot send (on purpose, for real notification mail); a test of
    // that slot must not report the fallback's success as its own.
    if (loaded.status !== 'ok' || emailProviderReadiness(loaded.provider) !== 'configured') {
      return res.json({
        success: false,
        provider: loaded.status === 'ok' ? loaded.provider.provider_name : 'none',
        errorCode: loaded.status === 'error' ? 'provider_error' : 'unconfigured',
        error: loaded.status === 'error'
          ? 'provider_error: the email provider setting could not be read'
          : 'unconfigured: this provider is not set up yet, or a required field is missing',
        to,
      });
    }
    const locale = await operatorLocale(config, adminId);
    const copy = TEST_MAIL[locale] ?? TEST_MAIL.en;
    const body = copy.body(copy.slots[slot], loaded.provider.provider_name, new Date().toISOString());
    const html = `<div dir="${locale === 'fa' ? 'rtl' : 'ltr'}">${body.split('\n\n').map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</div>`;
    // No workspace: a platform send, never logged against a tenant. The
    // result's error is the email core's "<code>: <reason>", safe to show.
    const result = await sendEmail(config, {
      workspaceId: null,
      to,
      subject: copy.subject,
      text: body,
      html,
      locale,
      category: slot === 'notification' ? 'notification' : 'transactional',
      ...(slot === 'notification' ? { providerConfigKey: key } : {}),
    });
    return res.json({
      success: result.success,
      provider: result.provider,
      ...(result.id ? { id: result.id } : {}),
      ...(result.serverMessageId ? { serverMessageId: result.serverMessageId } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.error ? { error: result.error } : {}),
      to,
    });
  } catch (err) {
    return fail(res, err);
  }
});
