/**
 * Super Admin → Branding → Email templates: a template seen, and tried, as
 * it is sent.
 *
 * The preview renders a template — the row as saved, or the text being
 * edited — through the email core's own path (renderEmailForPreview: the
 * same fill, the same layout, the running edition's brand), filled with the
 * catalog's sample values (./templateCatalog.ts) and, for a notification,
 * the closing line its sender adds under it. The test sends the same thing
 * through the core's send (sendEmail: the layout, the headers, the
 * suppression list, the provider's checks), to the signed-in Super Admin
 * and nobody else; the route that calls it (server/routes/adminManagement.ts)
 * picks the address and counts the tests.
 *
 * Both work in the running edition only: each brand keeps its own database
 * and its own templates, and a preview in one brand's look of the other's
 * row would show a mail nobody gets.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { Edition } from '../../../shared/edition.js';
import { renderEmailForPreview, sendEmail, templateContentProblems, type EmailRequest, type SendResult } from './index.js';
import { catalogEntry, sampleTemplateData } from './templateCatalog.js';
import { notificationFooter } from '../notificationEmail/unsubscribe.js';
import { operatorNoticeProviderKey } from '../notificationEmail/dispatcher.js';
import { isNotificationEmailType } from '../notificationEmail/types.js';
import { resolveAppBaseUrl, resolveWorkspaceAppUrl } from '../auth-email.js';
import type { OperatorLocale } from '../operatorLocale.js';
import type { EmailCategory } from './providers/types.js';

/** What a template row holds, as saved or as being edited. */
export interface TemplateContent {
  subject: string;
  html_body: string;
  text_body: string | null;
}

/** The running edition's platform row of `slug` in `locale`, or null when there is none. */
export async function readPlatformTemplate(
  config: ServerConfig,
  edition: Edition,
  slug: string,
  locale: string,
): Promise<TemplateContent | null> {
  const { data, error } = await getServiceClient(config)
    .from('email_templates')
    .select('subject, html_body, text_body')
    .is('workspace_id', null)
    .eq('edition', edition)
    .eq('slug', slug)
    .eq('locale', locale)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { subject?: unknown; html_body?: unknown; text_body?: unknown } | null;
  if (!row) return null;
  return {
    subject: String(row.subject ?? ''),
    html_body: String(row.html_body ?? ''),
    text_body: typeof row.text_body === 'string' ? row.text_body : null,
  };
}

/**
 * What a template of `slug` goes out with besides its own words: the kind
 * of mail, the sample values its sender's would be, and a notification's
 * closing line. That line links to the notification settings rather than a
 * personal unsubscribe link: a sample must not switch anything off by a
 * click, and nobody subscribed to it.
 */
async function sendContext(config: ServerConfig, edition: Edition, slug: string, locale: string): Promise<{
  kind: EmailCategory;
  data: Record<string, string>;
  htmlData?: Record<string, string>;
  footer?: EmailRequest['footer'];
}> {
  const entry = catalogEntry(slug);
  const appUrl = await resolveAppBaseUrl(config).catch(() => '');
  const sample = sampleTemplateData(slug, { edition, locale, appUrl });
  let footer: EmailRequest['footer'];
  if (entry?.footer) {
    const settings = await resolveWorkspaceAppUrl(config, null, '/settings/notifications').catch(() => null);
    const lang: OperatorLocale = locale === 'fa' || locale === 'tr' ? locale : 'en';
    footer = notificationFooter(lang, entry.footer, { unsubscribe: null, settings });
  }
  return { kind: entry?.kind ?? 'transactional', data: sample.data, htmlData: sample.htmlData, footer };
}

/**
 * A template as it would be sent, in one colour scheme, with what its
 * content holds that a platform mail must not send (layout.ts
 * contentProblems: the codes, never a piece of the content).
 */
export async function previewPlatformTemplate(
  config: ServerConfig,
  input: { edition: Edition; slug: string; locale: string; content: TemplateContent; scheme: 'light' | 'dark' },
): Promise<{ subject: string; html: string; text: string; problems: string[] }> {
  const context = await sendContext(config, input.edition, input.slug, input.locale);
  const [mail, problems] = await Promise.all([
    renderEmailForPreview(config, {
      slug: input.slug,
      locale: input.locale,
      ...input.content,
      data: context.data,
      htmlData: context.htmlData,
      scheme: input.scheme,
      category: context.kind,
      footer: context.footer,
      edition: input.edition,
    }),
    templateContentProblems(config, { edition: input.edition, locale: input.locale, html_body: input.content.html_body }),
  ]);
  return { ...mail, problems };
}

/**
 * The template, filled with the sample values, sent to `to` now as platform
 * mail (no workspace, so no workspace's email log): the given content in
 * place of the stored row (EmailRequest.template), in its own language. An
 * operator notice goes through the provider its real ones take (the
 * notification provider, when Super Admin chose one), so the test shows
 * their From and fails when they would.
 */
export async function sendPlatformTemplateTest(
  config: ServerConfig,
  input: { edition: Edition; slug: string; locale: string; content: TemplateContent; to: string },
): Promise<SendResult> {
  const context = await sendContext(config, input.edition, input.slug, input.locale);
  const providerConfigKey = isNotificationEmailType(catalogEntry(input.slug)?.footer)
    ? await operatorNoticeProviderKey(config)
    : undefined;
  return sendEmail(config, {
    workspaceId: null,
    to: input.to,
    templateSlug: input.slug,
    template: { ...input.content, locale: input.locale },
    templateData: context.data,
    htmlData: context.htmlData,
    locale: input.locale,
    category: context.kind,
    footer: context.footer,
    providerConfigKey,
  });
}
