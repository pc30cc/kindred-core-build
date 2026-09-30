/**
 * Platform support — the two mails a ticket sends.
 *
 *   platform_support_ticket_created  to the support team: the answering
 *                                    workspace's owners and admins, plus the
 *                                    addresses Super Admin added.
 *   platform_support_ticket_reply    to the operator who filed the ticket,
 *                                    when the team answers it.
 *
 * Templates are seeded by migration 242 in en/fa/tr and editable in Super
 * Admin → Branding → Email templates. Sending is best effort: a ticket and a
 * reply are saved, published and pushed whether or not a mail goes out.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail } from '../email/index.js';
import { resolveAppBaseUrl, resolveWorkspaceAppUrl } from '../auth-email.js';
import { templateValue } from './text.js';

const LOCALES = new Set(['en', 'fa', 'tr']);

export function emailLocale(raw: string | null | undefined, fallback = 'en'): string {
  const base = String(raw ?? '').toLowerCase().split(/[-_]/)[0];
  return LOCALES.has(base) ? base : fallback;
}

interface Recipient {
  email: string;
  locale: string;
}

/** The support workspace's owners and admins, then Super Admin's extra addresses. */
async function supportTeamRecipients(
  config: ServerConfig,
  supportWorkspaceId: string,
  extraEmails: readonly string[],
): Promise<Recipient[]> {
  const sb = getServiceClient(config);
  const { data: members } = await sb
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', supportWorkspaceId)
    .in('role', ['owner', 'admin']);
  const ids = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  const out: Recipient[] = [];
  const seen = new Set<string>();
  let teamLocale = 'fa';
  if (ids.length) {
    const { data: profiles } = await sb
      .from('profiles')
      .select('id, email, preferred_locale')
      .in('id', ids);
    for (const p of (profiles ?? []) as Array<{ email: string | null; preferred_locale: string | null }>) {
      const email = (p.email || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const locale = emailLocale(p.preferred_locale, 'fa');
      if (out.length === 0) teamLocale = locale;
      out.push({ email, locale });
    }
  }
  for (const raw of extraEmails) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, locale: teamLocale });
  }
  return out;
}

export interface TicketCreatedMail {
  supportWorkspaceId: string;
  conversationId: string;
  number: number;
  subject: string;
  body: string;
  requesterName: string;
  requesterEmail: string | null;
  workspaceName: string | null;
  extraEmails: readonly string[];
}

export async function sendTicketCreatedEmails(config: ServerConfig, mail: TicketCreatedMail): Promise<void> {
  try {
    const recipients = await supportTeamRecipients(config, mail.supportWorkspaceId, mail.extraEmails);
    if (!recipients.length) return;
    const actionUrl = await resolveWorkspaceAppUrl(
      config,
      mail.supportWorkspaceId,
      `/inbox?c=${encodeURIComponent(mail.conversationId)}`,
    );
    await Promise.allSettled(
      recipients.map((to) =>
        sendEmail(config, {
          workspaceId: mail.supportWorkspaceId,
          to: to.email,
          locale: to.locale,
          templateSlug: 'platform_support_ticket_created',
          // What a person typed goes last, so no later key is substituted
          // inside it.
          templateData: {
            ticket_number: String(mail.number),
            action_url: actionUrl,
            requester_email: templateValue(mail.requesterEmail || '—'),
            workspace_name: templateValue(mail.workspaceName || '—'),
            requester_name: templateValue(mail.requesterName),
            subject: templateValue(mail.subject),
            message: templateValue(mail.body),
          },
        }).then((result) => {
          if (!result.success) {
            console.warn('[platform-support] ticket mail not sent:', result.provider, result.error ?? '');
          }
        }),
      ),
    );
  } catch (err) {
    console.warn('[platform-support] ticket mail failed:', err instanceof Error ? err.message : err);
  }
}

export interface TicketReplyMail {
  supportWorkspaceId: string;
  userId: string;
  number: number;
  subject: string | null;
  reply: string;
  agentName: string | null;
}

export async function sendTicketReplyEmail(config: ServerConfig, mail: TicketReplyMail): Promise<void> {
  try {
    const { data: profile } = await getServiceClient(config)
      .from('profiles')
      .select('email, preferred_locale')
      .eq('id', mail.userId)
      .maybeSingle();
    const row = profile as { email: string | null; preferred_locale: string | null } | null;
    const to = (row?.email || '').trim();
    if (!to) return;
    const locale = emailLocale(row?.preferred_locale, 'fa');
    const result = await sendEmail(config, {
      workspaceId: mail.supportWorkspaceId,
      to,
      locale,
      templateSlug: 'platform_support_ticket_reply',
      templateData: {
        ticket_number: String(mail.number),
        action_url: await resolveAppBaseUrl(config),
        agent_name: templateValue(mail.agentName || (locale === 'fa' ? 'پشتیبانی' : locale === 'tr' ? 'Destek' : 'Support')),
        subject: templateValue(mail.subject || `#${mail.number}`),
        reply: templateValue(mail.reply),
      },
    });
    if (!result.success) {
      console.warn('[platform-support] reply mail not sent:', result.provider, result.error ?? '');
    }
  } catch (err) {
    console.warn('[platform-support] reply mail failed:', err instanceof Error ? err.message : err);
  }
}
