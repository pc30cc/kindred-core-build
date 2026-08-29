/**
 * Telegram department routing.
 *
 * When a workspace runs several departments, the visitor's FIRST real
 * message (not a menu tap) is answered with a department picker so the
 * thread reaches the right team. Workspaces without departments keep the
 * exact previous behavior: the message simply lands in the shared inbox.
 *
 * State lives on `conversations.metadata`:
 *   - department_pending: 'true' while the picker is waiting for a tap
 *   - department_id / department_name: the chosen department
 *
 * Only chat-capable, visible departments are offered (the same resolver the
 * widget uses), so an empty or unreachable department is never shown.
 */

import type { ServerConfig } from '../../../config.js';
import { patchConversationMetadata } from '../../conversationMetadata.js';
import { getServiceClient } from '../../../supabase.js';
import { recordConversationEvent } from '../../conversationEvents.js';
import {
  resolveWidgetVisibleDepartments,
  type VisibleDepartment,
} from '../../calls/departments.js';
import { resolveLocalizedMessage, type TelegramSettings } from './settings.js';
import { escapeHtml } from './menu.js';

type PickerStrings = { title: string; hint: string; confirmed: (name: string) => string; changed: string };

/** Every picker string is operator-authored per locale (plugin settings). */
function strings(
  settings: TelegramSettings,
  locale?: string | null,
  fallback?: string | null,
): PickerStrings {
  const get = (key: 'deptTitle' | 'deptHint' | 'deptConfirmed' | 'deptChange') =>
    resolveLocalizedMessage(settings, locale, key, fallback);
  return {
    title: get('deptTitle'),
    hint: get('deptHint'),
    confirmed: (name) => get('deptConfirmed').replace('{department}', `<b>${escapeHtml(name)}</b>`),
    changed: get('deptChange'),
  };
}

export type TelegramScreen = { text: string; replyMarkup: Record<string, unknown> };

/** Inline keyboard listing the departments, one per row (readable labels). */
export function buildDepartmentPicker(
  settings: TelegramSettings,
  departments: VisibleDepartment[],
  locale?: string | null,
  fallback?: string | null,
): TelegramScreen {
  const s = strings(settings, locale, fallback);
  const rows = departments.map((d) => [
    { text: `🏷 ${d.name.slice(0, 48)}`, callback_data: `tg:dept:${d.id}` },
  ]);
  return {
    text: `<b>${escapeHtml(s.title)}</b>\n\n${escapeHtml(s.hint)}`,
    replyMarkup: { inline_keyboard: rows },
  };
}

async function readConversationMeta(
  config: ServerConfig,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  return ((data as any)?.metadata as Record<string, unknown>) || {};
}

async function patchConversationMeta(
  config: ServerConfig,
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // Reachable from the vNext path (Telegram conversations are AI-managed),
  // so the merge happens server-side and only touches the picker keys.
  await patchConversationMetadata(config, conversationId, patch);
}

/**
 * Decides whether this conversation still needs a department choice and, if
 * so, returns the picker screen to deliver. Returns null for the "no
 * departments" mode, for a single department (auto-assigned silently) and
 * for a thread that already carries a department.
 * Never throws — routing UX must never break message delivery.
 */
export async function resolveDepartmentPickerScreen(
  config: ServerConfig,
  args: {
    settings: TelegramSettings;
    workspaceId: string;
    conversationId: string;
    locale?: string | null;
    fallbackLocale?: string | null;
  },
): Promise<TelegramScreen | null> {
  try {
    const meta = await readConversationMeta(config, args.conversationId);
    if (meta.department_id) return null;
    if (meta.department_pending === 'true') return null;

    const visible = await resolveWidgetVisibleDepartments(config, args.workspaceId, 'chat');
    if (visible.length === 0) return null;

    if (visible.length === 1) {
      // Single department: no question to ask, just route the thread.
      await assignConversationDepartment(config, {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        department: visible[0],
        auto: true,
      });
      return null;
    }

    await patchConversationMeta(config, args.conversationId, { department_pending: 'true' });
    return buildDepartmentPicker(args.settings, visible, args.locale, args.fallbackLocale);
  } catch (err) {
    console.warn('[telegram] department picker error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Persists the chosen department on the conversation + timeline. */
export async function assignConversationDepartment(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    department: { id: string; name: string };
    auto?: boolean;
  },
): Promise<void> {
  await patchConversationMeta(config, args.conversationId, {
    department_id: args.department.id,
    department_name: args.department.name,
    department_pending: 'false',
    department_source: args.auto ? 'auto' : 'visitor',
  });
  void recordConversationEvent(config, {
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    eventType: 'department_assigned',
    actorType: 'visitor',
    actorId: null,
    payload: {
      department_id: args.department.id,
      department_name: args.department.name,
      source: args.auto ? 'auto' : 'telegram_picker',
    },
  });
}

/**
 * Handles a `tg:dept:<id>` inline tap: validates the department is still
 * visible, stores it and returns the confirmation screen.
 */
export async function applyDepartmentChoice(
  config: ServerConfig,
  args: {
    settings: TelegramSettings;
    workspaceId: string;
    conversationId: string | null;
    departmentId: string;
    locale?: string | null;
    fallbackLocale?: string | null;
  },
): Promise<TelegramScreen | null> {
  const s = strings(args.settings, args.locale, args.fallbackLocale);
  const visible = await resolveWidgetVisibleDepartments(config, args.workspaceId, 'chat').catch(
    () => [] as VisibleDepartment[],
  );
  const chosen = visible.find((d) => d.id === args.departmentId);
  if (!chosen) {
    if (!visible.length) return null;
    return buildDepartmentPicker(args.settings, visible, args.locale, args.fallbackLocale);
  }
  if (args.conversationId) {
    await assignConversationDepartment(config, {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      department: chosen,
    });
  }
  return {
    text: s.confirmed(chosen.name),
    replyMarkup: {
      inline_keyboard: [[{ text: `🗂 ${s.changed}`, callback_data: 'tg:dept' }]],
    },
  };
}

/** Re-opens the picker (used by the "change department" button). */
export async function reopenDepartmentPicker(
  config: ServerConfig,
  args: { settings: TelegramSettings; workspaceId: string; locale?: string | null; fallbackLocale?: string | null },
): Promise<TelegramScreen | null> {
  const visible = await resolveWidgetVisibleDepartments(config, args.workspaceId, 'chat').catch(
    () => [] as VisibleDepartment[],
  );
  if (visible.length < 2) return null;
  return buildDepartmentPicker(args.settings, visible, args.locale, args.fallbackLocale);
}

/** Resolves the open Telegram conversation for a chat id (callback context). */
export async function findTelegramConversationId(
  config: ServerConfig,
  args: { workspaceId: string; integrationId: string; chatId: string },
): Promise<string | null> {
  const sb = getServiceClient(config);
  const threadKey = `telegram:${args.integrationId}:${args.chatId}`;
  const { data } = await sb
    .from('conversations')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .contains('metadata', { channel_thread_key: threadKey })
    .in('status', ['open', 'pending'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data as any)?.id as string) ?? null;
}
