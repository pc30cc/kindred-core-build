/**
 * WHAT DECIDES THERE IS SOMETHING TO SAY.
 *
 * Four producers, two shapes. The digest and the weekly summary are swept
 * on a schedule; the transcript and the payment notice are raised by
 * something that happened. All four do the same thing in the end: work out
 * who should hear about it, resolve everything the template needs, and write
 * a queued job with a key that makes a second copy impossible.
 *
 * None of them send. `dispatcher.ts` does that, and asks both switches again
 * on the way.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveWorkspaceAppUrl } from '../auth-email.js';
import { enqueueNotificationEmail, windowKey } from './queue.js';
import { isTypeEnabled, loadNotificationEmailSettings } from './settings.js';
import { NOTIFICATION_EMAILS, type NotificationEmailType } from './types.js';

function sb(config: ServerConfig) {
  return getServiceClient(config);
}

/** Every operator who may hear about this workspace, honouring the audience. */
export async function audienceFor(
  config: ServerConfig,
  workspaceId: string,
  type: NotificationEmailType,
  exclude: string[] = [],
): Promise<string[]> {
  const { data, error } = await sb(config)
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId)
    .is('suspended_at', null);
  if (error) {
    console.error('[notification-email] audience lookup failed', { message: error.message });
    return [];
  }

  const rows = (data ?? []) as Array<{ user_id: string; role: string | null }>;
  const adminsOnly = NOTIFICATION_EMAILS[type].audience === 'admins';
  const skip = new Set(exclude);

  return rows
    .filter((r) => !skip.has(String(r.user_id)))
    .filter((r) => !adminsOnly || ['owner', 'admin'].includes(String(r.role ?? '')))
    .map((r) => String(r.user_id));
}

/**
 * The console link an email points at.
 *
 * The same resolver the billing mail uses, so a workspace with its own
 * domain gets its own domain here too rather than the platform's.
 */
async function appUrl(config: ServerConfig, workspaceId: string | null, path: string): Promise<string> {
  try {
    return await resolveWorkspaceAppUrl(config, workspaceId, path);
  } catch {
    return path;
  }
}

// ───────────────────────── the unread digest ─────────────────────────

export interface SweepResult {
  workspaces: number;
  queued: number;
}

/**
 * Conversations still waiting, per workspace, to whoever is on the hook.
 *
 * One mail per operator per digest window, never one per conversation: the
 * point of a digest is that it is the thing you get INSTEAD of twelve
 * notifications. An operator who is already answering gets nothing, because
 * a conversation with a reply on it is no longer waiting.
 */
export async function sweepUnreadDigest(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<SweepResult> {
  const out: SweepResult = { workspaces: 0, queued: 0 };
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'unread_messages')) return out;

  const cutoff = new Date(now.getTime() - settings.unread_after_minutes * 60_000);

  // "Waiting" is a customer message nobody has seen yet, older than the
  // cutoff — the same definition the unread badge uses. There is no
  // `last_message_at` on a conversation to shortcut it with, and inventing
  // one would be a second source of truth for the number the inbox already
  // shows.
  const { data: unseen, error: unseenError } = await sb(config)
    .from('conversation_messages')
    .select('conversation_id')
    .eq('sender_type', 'contact')
    .is('seen_at', null)
    .lt('created_at', cutoff.toISOString())
    .order('created_at', { ascending: true })
    .limit(2000);
  if (unseenError) {
    console.error('[notification-email] digest sweep failed', { message: unseenError.message });
    return out;
  }

  const conversationIds = [
    ...new Set(((unseen ?? []) as Array<{ conversation_id: string }>).map((r) => String(r.conversation_id))),
  ].slice(0, 500);
  if (!conversationIds.length) return out;

  const { data: waiting, error } = await sb(config)
    .from('conversations')
    .select('id, workspace_id, subject')
    .in('id', conversationIds)
    .in('status', ['open', 'pending'])
    .or('is_spam.is.null,is_spam.eq.false');
  if (error) {
    console.error('[notification-email] digest sweep failed', { message: error.message });
    return out;
  }

  const byWorkspace = new Map<string, Array<{ id: string; subject: string | null }>>();
  for (const row of (waiting ?? []) as Array<{ id: string; workspace_id: string; subject: string | null }>) {
    const list = byWorkspace.get(String(row.workspace_id)) ?? [];
    list.push({ id: String(row.id), subject: row.subject });
    byWorkspace.set(String(row.workspace_id), list);
  }

  const window = windowKey(now, settings.digest_every_minutes);

  for (const [workspaceId, conversations] of byWorkspace) {
    out.workspaces += 1;
    const names = await workspaceName(config, workspaceId);
    const url = await appUrl(config, workspaceId, '/inbox');
    const recipients = await audienceFor(config, workspaceId, 'unread_messages');

    for (const userId of recipients) {
      const queued = await enqueueNotificationEmail(config, {
        userId,
        workspaceId,
        type: 'unread_messages',
        // One key per operator per workspace per window: two instances
        // sweeping the same minute produce the same key and the second is
        // refused by the index.
        dedupeKey: `unread:${userId}:${workspaceId}:${window}`,
        payload: {
          count: conversations.length,
          minutes: settings.unread_after_minutes,
          workspace: names,
          list: conversations
            .slice(0, 10)
            .map((c) => c.subject || '—')
            .join(' · '),
          action_url: url,
        },
      });
      if (queued.queued) out.queued += 1;
    }
  }

  return out;
}

// ───────────────────────── the weekly summary ─────────────────────────

/**
 * Last week, counted once.
 *
 * The window is the ISO week that just ended, so the key is the same for
 * every instance that runs it and different every Monday.
 */
export async function sweepWeeklySummary(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<SweepResult> {
  const out: SweepResult = { workspaces: 0, queued: 0 };
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'weekly_summary')) return out;

  // Only in the hour the admin chose, on the day they chose. Checked here
  // rather than by the schedule so that changing it in the console takes
  // effect on the next pass rather than on the next restart.
  if (now.getUTCDay() !== settings.weekly_summary_dow) return out;
  if (now.getUTCHours() !== settings.weekly_summary_hour) return out;

  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const week = Math.floor(now.getTime() / (7 * 24 * 60 * 60_000));

  const { data: workspaces } = await sb(config).from('workspaces').select('id, name').limit(500);

  for (const row of (workspaces ?? []) as Array<{ id: string; name: string | null }>) {
    const workspaceId = String(row.id);
    const url = await appUrl(config, workspaceId, '/inbox');
    const counts = await weekCounts(config, workspaceId, since, now);
    if (!counts.conversations && !counts.messages) continue; // nothing happened; say nothing

    out.workspaces += 1;
    for (const userId of await audienceFor(config, workspaceId, 'weekly_summary')) {
      const queued = await enqueueNotificationEmail(config, {
        userId,
        workspaceId,
        type: 'weekly_summary',
        dedupeKey: `weekly:${userId}:${workspaceId}:${week}`,
        payload: {
          workspace: row.name ?? '—',
          conversations: counts.conversations,
          resolved: counts.resolved,
          messages: counts.messages,
          action_url: url,
        },
      });
      if (queued.queued) out.queued += 1;
    }
  }

  return out;
}

/**
 * The week, counted.
 *
 * `conversation_messages` carries no workspace of its own — it belongs to a
 * conversation, which belongs to a workspace — so the message count goes
 * through the conversations touched in the window. Bounded at a thousand,
 * which is a busy week for one workspace and cheap for a job that runs once.
 */
async function weekCounts(
  config: ServerConfig,
  workspaceId: string,
  since: Date,
  until: Date,
): Promise<{ conversations: number; resolved: number; messages: number }> {
  const client = sb(config);
  const iso = (d: Date) => d.toISOString();

  const [opened, resolved, touched] = await Promise.all([
    client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', iso(since))
      .lt('created_at', iso(until)),
    client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'resolved')
      .gte('updated_at', iso(since))
      .lt('updated_at', iso(until)),
    client
      .from('conversations')
      .select('id')
      .eq('workspace_id', workspaceId)
      .gte('updated_at', iso(since))
      .limit(1000),
  ]);

  const ids = ((touched.data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
  let messages = 0;
  if (ids.length) {
    const { count } = await client
      .from('conversation_messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', ids)
      .gte('created_at', iso(since))
      .lt('created_at', iso(until));
    messages = count ?? 0;
  }

  return {
    conversations: opened.count ?? 0,
    resolved: resolved.count ?? 0,
    messages,
  };
}

async function workspaceName(config: ServerConfig, workspaceId: string): Promise<string> {
  const { data } = await sb(config).from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
  return String((data as { name?: string } | null)?.name ?? '—');
}

// ───────────────────────── the transcript ─────────────────────────

/**
 * The conversation that was just closed, to whoever handled it.
 *
 * Not to the whole workspace: a transcript is a record of work somebody did,
 * and everybody else's inbox does not need a copy of every conversation the
 * team closes. The assignee if there is one, and the operator who resolved
 * it either way.
 */
export async function queueTranscript(
  config: ServerConfig,
  args: { conversationId: string; workspaceId: string; actorId: string | null },
): Promise<number> {
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'transcripts')) return 0;

  const { data: conversation } = await sb(config)
    .from('conversations')
    .select('id, subject, assigned_to, contact_id, updated_at')
    .eq('id', args.conversationId)
    .maybeSingle();
  if (!conversation) return 0;

  const row = conversation as {
    subject: string | null;
    assigned_to: string | null;
    contact_id: string | null;
    updated_at: string | null;
  };

  const recipients = new Set<string>();
  if (row.assigned_to) recipients.add(String(row.assigned_to));
  if (args.actorId) recipients.add(String(args.actorId));
  if (!recipients.size) return 0;

  const [transcript, contact, workspace, url] = await Promise.all([
    renderTranscript(config, args.conversationId),
    contactName(config, row.contact_id),
    workspaceName(config, args.workspaceId),
    appUrl(config, args.workspaceId, `/inbox?c=${encodeURIComponent(args.conversationId)}`),
  ]);

  let queued = 0;
  for (const userId of recipients) {
    const result = await enqueueNotificationEmail(config, {
      userId,
      workspaceId: args.workspaceId,
      type: 'transcripts',
      // One per operator per conversation: reopening and resolving again
      // does not send a second copy, which is the right answer — the
      // transcript they have is of the same conversation.
      dedupeKey: `transcript:${userId}:${args.conversationId}`,
      payload: {
        subject: row.subject || '—',
        contact,
        workspace,
        resolved_at: row.updated_at ?? '',
        transcript,
        action_url: url,
      },
    });
    if (result.queued) queued += 1;
  }
  return queued;
}

/** The last of the conversation, as plain lines. Bounded, and escaped. */
async function renderTranscript(config: ServerConfig, conversationId: string): Promise<string> {
  const { data } = await sb(config)
    .from('conversation_messages')
    .select('sender_type, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);

  const rows = (data ?? []) as Array<{ sender_type: string; body: string | null; created_at: string | null }>;
  return rows
    .map((m) => {
      const who = m.sender_type === 'contact' ? '←' : '→';
      return `<p>${who} ${escapeHtml(String(m.body ?? '').slice(0, 2000))}</p>`;
    })
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function contactName(config: ServerConfig, contactId: string | null): Promise<string> {
  if (!contactId) return '—';
  const { data } = await sb(config).from('contacts').select('name, email').eq('id', contactId).maybeSingle();
  const row = (data ?? {}) as { name?: string | null; email?: string | null };
  return String(row.name || row.email || '—');
}

// ───────────────────────── the payment notice ─────────────────────────

/**
 * Money arrived, to the people whose money it is.
 *
 * Owners and workspace admins only. An operator who answers chats has no
 * business being told what the company paid, and the audience rule in
 * `types.ts` is what enforces it.
 */
export async function queueInvoicePaid(
  config: ServerConfig,
  args: { workspaceId: string; amount: string; invoiceNumber?: string | null; invoiceId?: string | null },
): Promise<number> {
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'paid_invoices')) return 0;

  const [workspace, url] = await Promise.all([
    workspaceName(config, args.workspaceId),
    appUrl(config, args.workspaceId, '/billing'),
  ]);

  let queued = 0;
  for (const userId of await audienceFor(config, args.workspaceId, 'paid_invoices')) {
    const result = await enqueueNotificationEmail(config, {
      userId,
      workspaceId: args.workspaceId,
      type: 'paid_invoices',
      dedupeKey: `invoice:${userId}:${args.invoiceId ?? args.invoiceNumber ?? args.amount}:${args.workspaceId}`,
      payload: {
        workspace,
        amount: args.amount,
        invoice_label: args.invoiceNumber ? ` (${args.invoiceNumber})` : '',
        action_url: url,
      },
    });
    if (result.queued) queued += 1;
  }
  return queued;
}

// ───────────────────────── the announcement ─────────────────────────

/**
 * What Super Admin wants every operator to read.
 *
 * Bounded by the same two switches as everything else: the platform's, and
 * each operator's own. An announcement nobody can decline is a different
 * product.
 */
export async function queueProductUpdate(
  config: ServerConfig,
  args: { title: string; body: string; announcementId: string },
): Promise<number> {
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'product_updates')) return 0;

  const { data } = await sb(config)
    .from('workspace_members')
    .select('user_id')
    .is('suspended_at', null)
    .limit(5000);

  const users = new Set(
    ((data ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id)),
  );

  let queued = 0;
  for (const userId of users) {
    const result = await enqueueNotificationEmail(config, {
      userId,
      type: 'product_updates',
      dedupeKey: `announcement:${userId}:${args.announcementId}`,
      payload: { title: args.title, body: args.body },
    });
    if (result.queued) queued += 1;
  }
  return queued;
}
