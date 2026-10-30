// ============================================
// SELF-HOSTED EMAIL SERVICE
// All email delivery runs through the server runtime.
// No Supabase Edge Functions in the production email path.
// ============================================

import type { ServerConfig } from '../../config.js';
import { type SupabaseClient } from '@supabase/supabase-js';
import { serviceClientFor } from '../../lib/serviceClient.js';
import {
  describeEmailProviderProblem,
  effectiveEmailProviderConfig,
  emailProviderProblems,
  emailProviderReadiness,
  getEmailAdapter,
} from './providers/index.js';
import {
  configText,
  emailFailure,
  type EmailCategory,
  type OutboundMessage,
  type ProviderConfig,
  type SendResult,
} from './providers/types.js';
import { isEmailProviderKey, loadEmailProviderConfig, type LoadedEmailProvider } from './providerConfigStore.js';
import { isEmailSuppressed } from './suppressions.js';
import { buildEmailLogMetadata, redactEmailLogError, redactEmailLogSubject } from './redactLogMetadata.js';
import { getPlatformAllowedLocales, getPlatformEditionOrNull } from '../platformRegion.js';
import type { Edition } from '../../../shared/edition.js';
import { IRAN_BRAND, brandContactFromDomains } from '../../../shared/brand.js';
import { parseEmailAddress } from '../../../shared/emailProviders.js';

export type {
  EmailCategory,
  EmailErrorCode,
  OutboundMessage,
  ProviderConfig,
  SendResult,
} from './providers/types.js';

/**
 * Whether a failed send may succeed if the same message is tried again (a
 * timeout, a dropped connection, a provider's own outage), as opposed to a
 * failure that would only repeat (a bad or suppressed address, a refused
 * sign-in, a missing setting).
 */
export function isTransientEmailFailure(r: SendResult): boolean {
  return !r.success && !r.permanent;
}

/**
 * What a caller may ask this service to send.
 *
 * There is no `from` and no `replyTo`, and their absence is the rule rather
 * than an oversight. Transport identity — who the mail is from — belongs to
 * the platform email provider and to nothing else, so a caller cannot supply
 * it and therefore cannot pass one through from a request body. That is
 * exactly what happened: `POST /api/email/send-channel` read `from` off the
 * JSON it was handed and passed it straight down, so any workspace with the
 * email channel could send as any address it liked through the platform's own
 * Resend account.
 *
 * Closing the route alone would not have been enough. The rule has to live
 * here, in the service, or the next caller re-opens it.
 *
 * `replyTo` is the provider's too: a message carries a Reply-To when the
 * provider config sets `reply_to`, and only then. It is also not the same
 * thing as `email_settings.reply_to_email`, which is a notification
 * RECIPIENT, not a `Reply-To` header.
 */
export interface EmailRequest {
  /**
   * The tenant this mail belongs to, or `null` for PLATFORM mail (password
   * reset, email verification — anything sent to a person rather than on a
   * workspace's behalf). Platform mail is never attributed to a workspace:
   * `email_logs` is readable by that workspace's admins, so a platform send
   * pinned to an arbitrary tenant leaked reset links to strangers. A `null`
   * workspace writes no `email_logs` row (the table is workspace-scoped and
   * `workspace_id` is NOT NULL).
   */
  workspaceId: string | null;
  to: string;
  subject?: string;
  html?: string;
  text?: string;
  templateSlug?: string;
  templateData?: Record<string, string>;
  /**
   * Values for the template's HTML part only, over `templateData`, inserted
   * as they are: HTML the caller made itself (an escaped copy, a
   * transcript's rows). Every `templateData` value is escaped for the HTML
   * part anyway (fillEmailTemplate), so text needs no copy here, and one
   * escaped by hand in `templateData` would show its `&amp;`. The subject
   * and the text part always get `templateData`'s value. Never logged.
   */
  htmlData?: Record<string, string>;
  locale?: string;
  /**
   * Send through a provider chosen for this KIND of mail rather than the
   * platform default.
   *
   * There is one default transport and the platform admin owns it. This is
   * the one deliberate exception: Super Admin → Notifications may point the
   * operator notification emails — digests, transcripts, announcements — at
   * a second configured provider, so a burst of them cannot cost a platform
   * the reputation its password resets and verification codes depend on.
   * The key names an `app_runtime_config` row holding the same shape as
   * `default_email_provider`; anything missing or disabled falls back to the
   * default rather than failing, because the mail matters more than which
   * wire it went down.
   */
  providerConfigKey?: string;
  /**
   * What kind of mail this is (default `transactional`: a reset, a code, a
   * receipt). Recorded in `email_logs`, and passed to a provider that can tag
   * it; it never changes who receives the mail.
   */
  category?: EmailCategory;
  /**
   * One-click unsubscribe (RFC 8058) for mail a person subscribed to: adds
   * `List-Unsubscribe: <url>[, <mailto:…>]` and
   * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The URL must be
   * https; anything else is left out (and said so in the console).
   */
  listUnsubscribe?: { url: string; mailto?: string };
  /**
   * A closing line the caller adds in code below the mail's own text,
   * whatever the template says: the operator notification emails' visible
   * unsubscribe line. `html` goes at the end of the HTML part (before
   * `</body>` in a whole document) and the caller escapes what it puts in
   * it; `text` goes at the end of the text part.
   */
  footer?: { html: string; text: string };
}

/**
 * Resolve which email provider to use.
 *
 * PLATFORM ONLY, and that is the whole point. There is exactly one email
 * transport and the platform admin owns it:
 * `app_runtime_config.default_email_provider`, written by
 * Super Admin → Providers → Communication → Email and read, secrets
 * decrypted, by the config store (./providerConfigStore.ts).
 *
 * This used to resolve workspace-first —
 * `workspace_provider_settings` → `provider_configs` → platform — which meant
 * a workspace admin could point the platform's own password resets,
 * verification codes and invitations at their own Resend account by saving a
 * provider in Settings → Providers. Email transport is platform
 * infrastructure, not a per-tenant setting, so there is no workspace lookup
 * here at all any more.
 *
 * A workspace id is still passed around this module for entitlement checks,
 * templates, recipients and `email_logs` — it just no longer selects the
 * infrastructure.
 */
async function resolveProviderConfig(
  config: ServerConfig,
  overrideKey?: string,
): Promise<LoadedEmailProvider> {
  // Only the store's own keys can be named: the override is another
  // platform row, never an arbitrary one.
  if (overrideKey && overrideKey !== 'default_email_provider' && isEmailProviderKey(overrideKey)) {
    const override = await loadEmailProviderConfig(config, overrideKey);
    if (override.status === 'error') console.warn('[email] override provider lookup failed:', override.message);
    // A named-but-unusable override falls through to the default. The
    // alternative is a silent stop on mail somebody asked for, because an
    // admin picked a provider and never filled in its key.
    if (override.status === 'ok' && emailProviderReadiness(override.provider) === 'configured') return override;
  }
  const loaded = await loadEmailProviderConfig(config, 'default_email_provider');
  if (loaded.status === 'error') console.warn('[email] platform provider lookup failed:', loaded.message);
  return loaded;
}

/**
 * Whether the platform can send email at all (the same reading sendEmail
 * makes, never the override key): a provider this server has an adapter for,
 * with its required fields and a valid from_email. A feature that mails a
 * visitor on request (the transcript by email) is offered only then. False
 * when the setting cannot be read.
 */
export async function isEmailProviderConfigured(config: ServerConfig): Promise<boolean> {
  try {
    const loaded = await loadEmailProviderConfig(config, 'default_email_provider');
    return loaded.status === 'ok' && emailProviderReadiness(loaded.provider) === 'configured';
  } catch {
    return false;
  }
}

/**
 * The From header, fail-closed.
 *
 * Transport identity (who the mail is *from*) comes from the provider config
 * and nowhere else. Brand identity (the `{brand}` a template prints) comes
 * from platform branding. They are different things and this is the seam.
 *
 * There is no invented address. `noreply@example.com` used to stand in for a
 * missing `from_email`, which meant a half-configured provider silently sent
 * mail that every receiver rejected — a failure that looked like a delivery
 * problem for as long as nobody read the logs. A missing `from_email` is a
 * configuration error, and the provider's readiness check (run before this)
 * says so.
 *
 * `from_name` is the one part that may fall back: the provider config still
 * owns it, but a blank one becomes the platform's own brand name, which is
 * the same name the template body already prints. The name and the address
 * travel apart, and each adapter quotes the name the way its wire needs, so
 * a comma, a quote or an `@` in a brand name can never split the header.
 */
async function resolveFromAddress(
  supabase: SupabaseClient,
  provider: ProviderConfig,
  locale: string,
): Promise<{ name: string; address: string }> {
  const cfg = provider.config;
  const address = parseEmailAddress(cfg.from_email) as string;
  const name = configText(cfg, 'from_name') || (await resolveBrandName(supabase, locale));
  // A header is one line, whatever the name holds.
  return { name: name.replace(/[\r\n]+/g, ' ').trim(), address };
}

/**
 * `List-Unsubscribe` and its one-click partner, or nothing. RFC 8058 wants
 * the one-click target to be https; a mailto is offered beside it only when
 * it is one plain address.
 */
function listUnsubscribeHeaders(value: EmailRequest['listUnsubscribe']): Record<string, string> {
  if (!value) return {};
  let url: URL;
  try {
    url = new URL(String(value.url ?? '').trim());
  } catch {
    console.warn('[email] List-Unsubscribe left out: the URL is not valid');
    return {};
  }
  if (url.protocol !== 'https:') {
    console.warn('[email] List-Unsubscribe left out: the URL is not https');
    return {};
  }
  const targets = [`<${url.href}>`];
  const mailto = parseEmailAddress(String(value.mailto ?? '').replace(/^mailto:/i, '').split('?')[0]);
  if (mailto) targets.push(`<mailto:${mailto}>`);
  return { 'List-Unsubscribe': targets.join(', '), 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/**
 * The caller's closing line (EmailRequest.footer) under the mail's own text.
 * A mail with no HTML part gets none from it: its text part carries the line.
 */
function withFooter(html: string, text: string, footer: EmailRequest['footer']): { html: string; text: string } {
  if (!footer) return { html, text };
  let nextHtml = html;
  if (html && footer.html) {
    const close = html.toLowerCase().lastIndexOf('</body');
    nextHtml = close >= 0 ? `${html.slice(0, close)}${footer.html}${html.slice(close)}` : `${html}${footer.html}`;
  }
  const nextText = text.trim() && footer.text ? `${text.trimEnd()}\n\n${footer.text}` : text;
  return { html: nextHtml, text: nextText };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * `html` without the elements named (and everything inside them) and without
 * comments. A scan rather than one lazy regex: an opener with no closer
 * would make `<style[\s\S]*?</style>` read to the end of the text once for
 * every opener, and a hostile body can hold thousands. Once no closer is
 * left after an opener, none is left after a later one either, so the rest
 * is cut and the scan stops.
 */
function stripElements(html: string, names: readonly string[]): string {
  let s = html;
  for (let at = s.indexOf('<!--'); at >= 0; at = s.indexOf('<!--', at)) {
    const close = s.indexOf('-->', at + 4);
    if (close < 0) {
      s = s.slice(0, at);
      break;
    }
    s = s.slice(0, at) + s.slice(close + 3);
  }
  for (const name of names) {
    const opener = new RegExp(`<${name}(?=[\\s/>])`, 'gi');
    const lower = s.toLowerCase();
    let out = '';
    let from = 0;
    for (let m = opener.exec(s); m; m = opener.exec(s)) {
      const close = lower.indexOf(`</${name}`, m.index);
      if (close < 0) {
        out += s.slice(from, m.index);
        from = s.length;
        break;
      }
      const end = lower.indexOf('>', close);
      out += s.slice(from, m.index);
      from = end < 0 ? s.length : end + 1;
      opener.lastIndex = from;
    }
    s = out + s.slice(from);
  }
  return s;
}

/**
 * Each link as its text and its target ("Reset password (https://…)"), the
 * same scan for the same reason: an `<a` with no `</a>` after it ends the
 * links, it does not restart the search.
 */
function inlineLinks(html: string): string {
  const opener = /<a\b([^<>]*)>/gi;
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const close = lower.indexOf('</a', opener.lastIndex);
    if (close < 0) break;
    const end = lower.indexOf('>', close);
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const target = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
    const label = html.slice(opener.lastIndex, close).replace(/<[^<>]*>/g, '').replace(/\s+/g, ' ').trim();
    let text = label;
    if (target && !target.startsWith('#') && !/^(javascript|data):/i.test(target)) {
      const shown = target.replace(/^mailto:/i, '');
      const same = !label || decodeEntities(label) === decodeEntities(target) || decodeEntities(label) === decodeEntities(shown);
      text = same ? shown : `${label} (${shown})`;
    }
    out += html.slice(from, m.index) + text;
    from = end < 0 ? html.length : end + 1;
    opener.lastIndex = from;
  }
  return out + html.slice(from);
}

/**
 * A text part for a message that has only HTML. Every mail carries one: a
 * client that shows text, a screen reader, and the spam filters that score
 * an HTML-only message all read it. Links keep their target ("Reset your
 * password (https://…)"), because in a reset or an invitation the link is
 * the message; blocks become lines, and styles and scripts go. Linear in
 * the length of the HTML, whatever it holds.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  const s = inlineLinks(stripElements(html, ['head', 'style', 'script', 'title']))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<\/?(p|div|h[1-6]|tr|table|tbody|thead|ul|ol|blockquote|section|article|header|footer|hr)\b[^<>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^<>]*>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Which edition's templates to send, and in which language.
 *
 * Templates are Super Admin rows kept per edition (migration 260): the
 * Iranian edition's and the International edition's never mix, so a region
 * switch can never send one brand's mail to the other's customers. The
 * language is clamped to the languages this platform offers (Iran: Persian
 * only), the ones Super Admin can edit; the first of them stands in for a
 * language the platform does not offer.
 */
export async function resolveEmailScope(
  config: ServerConfig,
  locale: string | undefined,
): Promise<{ edition: Edition; locales: string[] } | null> {
  const edition = await getPlatformEditionOrNull(config);
  if (!edition) return null;
  const allowed = await getPlatformAllowedLocales(config).catch(() => ['en', 'fa', 'tr']);
  const requested = String(locale || '').toLowerCase().split('-')[0];
  const primary = requested && allowed.includes(requested) ? requested : allowed[0] || 'en';
  const locales = [...new Set([primary, allowed[0] || 'en', 'en'])];
  return { edition, locales };
}

/**
 * Resolve email template by slug, within ONE edition, trying each locale in
 * order (see resolveEmailScope). Templates are always global
 * (workspace_id IS NULL). Never falls back to the other edition.
 */
async function resolveTemplate(
  supabase: SupabaseClient,
  edition: Edition,
  slug: string,
  locales: string[],
): Promise<{ subject: string; html_body: string; text_body: string | null; locale: string } | null> {
  for (const locale of locales) {
    const { data: template } = await supabase
      .from('email_templates')
      .select('subject, html_body, text_body')
      .is('workspace_id', null)
      .eq('edition', edition)
      .eq('slug', slug)
      .eq('locale', locale)
      .eq('is_active', true)
      .maybeSingle();
    if (template) return { ...(template as { subject: string; html_body: string; text_body: string | null }), locale };
  }
  return null;
}

/**
 * Interpolate {key} and {{key}} variables in a string; a placeholder with no
 * key in `data` is left as it is.
 *
 * Each value is inserted as it is, in one pass over the template: a function
 * replacer, because a string replacement would expand `$&`, `$'`, `` $` ``
 * and `$$` in it, and never a second look at an inserted value, which used to
 * fill a placeholder typed inside it with a later key's value (a visitor's
 * "{transcript_text}" in the HTML transcript would have pulled the unescaped
 * text transcript into the HTML). Visitor text in a transcript, an order
 * note or a name arrives as typed. Exported for its tests.
 */
export function interpolate(text: string, data: Record<string, string>): string {
  return text.replace(/\{\{([^{}]+)\}\}|\{([^{}]+)\}/g, (match: string, double?: string, single?: string) => {
    const key = (double ?? single) as string;
    return Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : match;
  });
}

/**
 * Platform brand name for a locale, used to brand every template that
 * references {brand}. Falls back: locale → en → 'Platform'.
 */
async function resolveBrandName(supabase: SupabaseClient, locale: string): Promise<string> {
  const read = async (lc: string) => {
    const { data } = await supabase
      .from('platform_branding_localized')
      .select('platform_name')
      .eq('locale', lc)
      .maybeSingle();
    return (data?.platform_name || '').trim();
  };
  try {
    const primary = await read(locale);
    if (primary) return primary;
    if (locale !== 'en') {
      const fallback = await read('en');
      if (fallback) return fallback;
    }
    // No third tier: platform_name only exists on platform_branding_localized
    // now, so the old platform_branding fallback that used to sit here was
    // dead code that returned 400 on every miss.
  } catch {
    /* branding is optional — never block delivery */
  }
  return 'Platform';
}

/**
 * The platform's support address for {support_email}, per edition
 * (shared/brand.ts): the Iranian edition's fixed address, else
 * support@<the platform's own site host> from platform_domains. Empty when
 * unknown — never an address made from the recipient's own domain.
 */
async function resolveSupportEmail(supabase: SupabaseClient, edition: Edition): Promise<string> {
  if (edition === 'iran') return IRAN_BRAND.supportEmail;
  try {
    const { data } = await supabase
      .from('platform_domains')
      .select('primary_domain, canonical_base_url, public_base_url')
      .limit(1)
      .maybeSingle();
    return brandContactFromDomains(data as Record<string, unknown> | null).support_email || '';
  } catch {
    return '';
  }
}

type RenderedTemplate =
  | { status: 'ok'; subject: string; html: string; text: string; locale: string }
  | { status: 'missing' }
  | { status: 'edition_unavailable' };

/** Text as HTML shows it: `&`, `<`, `>` and both quotes as entities. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * A template filled in: the subject and the text part with each value as it
 * is, the HTML part with each value escaped, except the ones `htmlData`
 * gives, which the caller has made HTML itself (an escaped copy, a
 * transcript's rows) and which go in as they are, never escaped twice.
 *
 * Escaping is the default because the values are text, and much of it is
 * typed by people the mail is not from: a sign-up's full name, which anyone
 * can set for an address that is not theirs, used to reach the HTML of the
 * verification mail as markup, so a stranger could put a link of their own
 * into a platform mail signed with the platform's domain. A caller that
 * forgets htmlData now sends that name as text, and so does a Super Admin's
 * template that prints a value the caller never thought would be in HTML.
 * Exported for its tests.
 */
export function fillEmailTemplate(
  tpl: { subject: string; html_body: string; text_body: string | null },
  data: Record<string, string>,
  htmlData?: Record<string, string>,
): { subject: string; html: string; text: string } {
  const htmlValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) htmlValues[key] = escapeHtml(String(value));
  return {
    subject: interpolate(tpl.subject, data).replace(/[\r\n]+/g, ' '),
    html: interpolate(tpl.html_body, { ...htmlValues, ...(htmlData || {}) }),
    text: interpolate(tpl.text_body || '', data),
  };
}

/**
 * The running edition's Super Admin template for `slug`, filled in
 * (fillEmailTemplate). Branding defaults ({brand}, {year}, {support_email})
 * are added so every template renders them, while the caller's templateData
 * always wins. The subject is one line whatever a value holds (a visitor's
 * name typed with a line break): a header never carries one.
 */
async function renderEditionTemplate(
  config: ServerConfig,
  supabase: SupabaseClient,
  slug: string,
  templateData: Record<string, string> | undefined,
  locale: string | undefined,
  htmlData?: Record<string, string>,
): Promise<RenderedTemplate> {
  const scope = await resolveEmailScope(config, locale);
  if (!scope) return { status: 'edition_unavailable' };
  const tpl = await resolveTemplate(supabase, scope.edition, slug, scope.locales);
  if (!tpl) return { status: 'missing' };
  const data: Record<string, string> = {
    brand: await resolveBrandName(supabase, tpl.locale),
    year: String(new Date().getFullYear()),
    support_email: await resolveSupportEmail(supabase, scope.edition),
    ...(templateData || {}),
  };
  return { status: 'ok', ...fillEmailTemplate(tpl, data, htmlData), locale: tpl.locale };
}

/** Same rule as EmailRequest: the platform provider owns the From header. */
export interface PlatformEmailRequest {
  to: string;
  /** The text sent when the template is missing (or no template is named). */
  subject: string;
  html?: string;
  text?: string;
  /** The running edition's Super Admin template to send, as in EmailRequest. */
  templateSlug?: string;
  templateData?: Record<string, string>;
  /** As in EmailRequest: the HTML part's own values, inserted as they are. */
  htmlData?: Record<string, string>;
  locale?: string;
  /** As in EmailRequest. */
  category?: EmailCategory;
  /** As in EmailRequest. */
  listUnsubscribe?: { url: string; mailto?: string };
}

interface Delivery {
  result: SendResult;
  /** The subject that was (or would have been) sent, for the log. */
  subject: string;
  providerName: string;
}

/**
 * Everything a send does, the same for every provider and for both entry
 * points, in this order:
 *
 *   1. `to` is one plain address (shared/emailProviders.ts), or nothing is
 *      sent: a comma list handed to SMTP becomes several RCPT TO.
 *   2. A suppressed address (it hard-bounced, complained, or a Super Admin
 *      held it back) is not mailed.
 *   3. The platform's provider (no provider: `stub`, as callers expect).
 *   4. The running edition's template, filled in.
 *   5. The provider must be able to send: an adapter for its name, its
 *      required fields, a valid from_email (the same reading as readiness).
 *   6. One OutboundMessage: From as name and address, a text part always
 *      (derived from the HTML when the template has none), the provider's
 *      `reply_to`, `Auto-Submitted: auto-generated` on every message (an
 *      auto-responder must not answer it), the one-click unsubscribe pair
 *      and the closing line (`footer`) when the caller gives them.
 *   7. The adapter sends it, within its own timeouts.
 *
 * Every failure is a SendResult with an errorCode, `permanent` when a retry
 * of the same message cannot succeed, and an `error` that is ours alone.
 */
async function deliver(
  config: ServerConfig,
  supabase: SupabaseClient,
  input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    templateSlug?: string;
    templateData?: Record<string, string>;
    htmlData?: Record<string, string>;
    locale?: string;
    category: EmailCategory;
    listUnsubscribe?: EmailRequest['listUnsubscribe'];
    footer?: EmailRequest['footer'];
    providerConfigKey?: string;
  },
): Promise<Delivery> {
  let { subject, html, text } = input;

  const to = parseEmailAddress(input.to);
  if (!to) {
    return {
      result: emailFailure('none', 'invalid_recipient', 'the recipient must be exactly one plain address'),
      subject,
      providerName: 'none',
    };
  }
  if (await isEmailSuppressed(config, to)) {
    return {
      result: emailFailure('none', 'suppressed', 'the address is on the suppression list (it bounced or complained)'),
      subject,
      providerName: 'none',
    };
  }

  const loaded = await resolveProviderConfig(config, input.providerConfigKey);
  if (loaded.status === 'error') {
    return {
      result: emailFailure('none', 'provider_error', 'the email provider setting could not be read', { permanent: false }),
      subject,
      providerName: 'none',
    };
  }
  const provider = loaded.status === 'ok' ? loaded.provider : null;
  const providerName = provider?.provider_name || 'stub';

  let tplLocale = input.locale || 'en';
  if (input.templateSlug) {
    const rendered = await renderEditionTemplate(config, supabase, input.templateSlug, input.templateData, input.locale, input.htmlData);
    if (rendered.status === 'ok') {
      ({ subject, html, text } = rendered);
      tplLocale = rendered.locale;
    } else if (rendered.status === 'edition_unavailable' && !subject && !html) {
      // Which brand's text to send cannot be told: retry later rather than
      // guess. With the caller's own text, that text goes out instead.
      return {
        result: emailFailure(providerName, 'edition_unavailable', 'the platform edition could not be read; try again'),
        subject,
        providerName,
      };
    }
  }

  if (!subject && !html) {
    return {
      result: input.templateSlug
        ? emailFailure(providerName, 'template_missing', `no active template "${input.templateSlug}" and no subject or body of its own`)
        : emailFailure(providerName, 'rejected', 'no subject or body was given'),
      subject,
      providerName,
    };
  }

  if (!provider) {
    // Never claim delivery when no provider is active. Invitation/OTP
    // workers use this result to fail closed and keep their delivery state
    // truthful instead of reporting a message that was never sent.
    return {
      result: emailFailure('stub', 'unconfigured', 'no email provider is configured. Set one in Super Admin → Providers → Email.'),
      subject,
      providerName,
    };
  }
  const adapter = getEmailAdapter(provider.provider_name);
  const effective = effectiveEmailProviderConfig(provider);
  const problems = adapter ? emailProviderProblems(effective) : [{ field: 'provider_name', problem: 'invalid' as const }];
  if (!adapter || problems.length) {
    return {
      result: emailFailure(providerName, 'unconfigured', describeEmailProviderProblem(problems[0])),
      subject,
      providerName,
    };
  }

  ({ html, text } = withFooter(html, text, input.footer));
  const replyTo = parseEmailAddress(effective.config.reply_to);
  const message: OutboundMessage = {
    from: await resolveFromAddress(supabase, effective, tplLocale),
    to,
    subject: subject.replace(/[\r\n]+/g, ' '),
    html,
    text: text.trim() ? text : htmlToText(html),
    ...(replyTo ? { replyTo } : {}),
    headers: { 'Auto-Submitted': 'auto-generated', ...listUnsubscribeHeaders(input.listUnsubscribe) },
    category: input.category,
  };

  let result: SendResult;
  try {
    result = await adapter.send(effective, message);
  } catch (err) {
    result = emailFailure(providerName, 'provider_error', 'the provider failed unexpectedly', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  return { result, subject, providerName };
}

/**
 * Sends an email with NO workspace binding — the pre-account flows
 * (the e-mail verification code of sign-up, e-mail change, order lookup)
 * that have no workspace to scope a provider or a log row against; see
 * docs/GENERIC_VERIFICATION_CORE.md §Workspace-less email. Only the
 * platform-default provider is used. With a templateSlug, the running
 * edition's Super Admin template is sent (the request's own text only when
 * it is missing). Deliberately does not write to `email_logs` — that table
 * is workspace-scoped delivery history, not applicable to a send with no
 * workspace.
 */
export async function sendPlatformEmail(
  config: ServerConfig,
  request: PlatformEmailRequest,
): Promise<SendResult> {
  const supabase = serviceClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);
  const { result } = await deliver(config, supabase, {
    to: request.to,
    subject: request.subject || '',
    html: request.html || '',
    text: request.text || '',
    templateSlug: request.templateSlug,
    templateData: request.templateData,
    htmlData: request.htmlData,
    locale: request.locale,
    category: request.category ?? 'transactional',
    listUnsubscribe: request.listUnsubscribe,
  });
  return result;
}

/**
 * Main email sending function.
 * Resolves provider, template, and sends email.
 * Logs all delivery attempts to email_logs.
 */
export async function sendEmail(
  config: ServerConfig,
  request: EmailRequest
): Promise<SendResult> {
  const supabase = serviceClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);

  const { workspaceId, to, templateSlug, templateData } = request;

  // `workspaceId === null` is an explicit platform send; an empty string or a
  // missing field is still a caller bug.
  if (workspaceId === undefined || workspaceId === '' || !to) {
    return emailFailure('none', to ? 'rejected' : 'invalid_recipient', 'workspaceId and to are required');
  }

  const category = request.category ?? 'transactional';
  const { result, subject, providerName } = await deliver(config, supabase, {
    to,
    subject: request.subject || '',
    html: request.html || '',
    text: request.text || '',
    templateSlug,
    templateData,
    htmlData: request.htmlData,
    locale: request.locale,
    category,
    listUnsubscribe: request.listUnsubscribe,
    footer: request.footer,
    providerConfigKey: request.providerConfigKey,
  });

  // --- Log delivery attempt ---
  // DELIVERY_DIAGNOSTICS_LOGGING — the single writer of email_logs (platform
  // -level email, sendPlatformEmail, deliberately never writes here). This
  // row is the only evidence that a transactional email was actually handed
  // to a provider, or why it was not; the send itself, and the SendResult
  // every caller branches on, are already decided above and are unaffected
  // either way.
  //
  // Platform mail (workspaceId null) is never logged against a tenant, and
  // what the row keeps is scrubbed first, because this table is readable by
  // workspace admins: template data carries reset / verify links with raw
  // tokens, OTP codes and invite links (redacted, and cut out of the subject
  // too), and the error is our "<errorCode>: <reason>", never the provider's
  // own text, which can name internal hosts and addresses.
  if (config.deliveryDiagnosticsLoggingEnabled !== false && workspaceId) {
    await supabase.from('email_logs').insert({
      workspace_id: workspaceId,
      template_slug: templateSlug || null,
      recipient_email: String(to).trim().slice(0, 320),
      subject: redactEmailLogSubject(subject, templateData),
      status: result.success ? 'sent' : 'failed',
      provider_name: providerName,
      error_message: result.success ? null : redactEmailLogError(result.error),
      metadata: buildEmailLogMetadata(templateData, result.id, { serverMessageId: result.serverMessageId, category }),
      sent_at: result.success ? new Date().toISOString() : null,
    });
  }

  return result;
}
