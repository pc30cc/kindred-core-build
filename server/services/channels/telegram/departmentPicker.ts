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
import { getServiceClient } from '../../../supabase.js';
import { recordConversationEvent } from '../../conversationEvents.js';
import {
  resolveWidgetVisibleDepartments,
  type VisibleDepartment,
} from '../../calls/departments.js';
import { normalizeLocale, type TelegramLocale } from './settings.js';
import { escapeHtml } from './menu.js';

type PickerStrings = {
  title: string;
  hint: string;
  confirmed: (name: string) => string;
  changed: string;
};

const STRINGS: Record<TelegramLocale, PickerStrings> = {
  en: {
    title: '🗂 Which team can help you?',
    hint: 'Pick the department that fits your request — we will connect you with the right teammate. You can keep writing in the meantime.',
    confirmed: (name) => `✅ Connected to <b>${escapeHtml(name)}</b>. A teammate from this department will reply here shortly.`,
    changed: 'Change department',
  },
  fa: {
    title: '🗂 کدام بخش می‌تواند کمکتان کند؟',
    hint: 'بخش مرتبط با درخواست خود را انتخاب کنید تا به همکار مناسب وصل شوید. در همین حین هم می‌توانید بنویسید.',
    confirmed: (name) => `✅ به بخش <b>${escapeHtml(name)}</b> وصل شدید. همکاران این بخش به‌زودی همین‌جا پاسخ می‌دهند.`,
    changed: 'تغییر بخش',
  },
  tr: {
    title: '🗂 Hangi ekip yardımcı olabilir?',
    hint: 'Talebinize uygun departmanı seçin; sizi doğru ekip arkadaşına bağlayalım. Bu sırada yazmaya devam edebilirsiniz.',
    confirmed: (name) => `✅ <b>${escapeHtml(name)}</b> departmanına bağlandınız. Bu departmandan bir temsilci kısa süre içinde yanıtlayacak.`,
    changed: 'Departmanı değiştir',
  },
};

function strings(locale?: string | null, fallback?: string | null): PickerStrings {
  return STRINGS[normalizeLocale(locale) || normalizeLocale(fallback) || 'en'];
}

export type TelegramScreen = { text: string; replyMarkup: Record<string, unknown> };

/** Inline keyboard listing the departments, one per row (readable labels). */
export function buildDepartmentPicker(
  departments: VisibleDepartment[],
  locale?: string | null,
  fallback?: string | null,
): TelegramScreen {
  const s = strings(locale, fallback);
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
  const sb = getServiceClient(config);
  const current = await readConversationMeta(config, conversationId);
  await sb
    .from('conversations')
    .update({ metadata: { ...current, ...patch } })
    .eq('id', conversationId);
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
    workspaceId: string;
    conversationId: string;
    locale?: string | null;
    fallbackLocale?: string | null;
    /** Re-offer the picker even when one was already shown (e.g. /human). */
    force?: boolean;
  },
): Promise<TelegramScreen | null> {
  try {
    const meta = await readConversationMeta(config, args.conversationId);
    if (meta.department_id) return null;
    if (!args.force && meta.department_pending === 'true') return null;

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
    return buildDepartmentPicker(visible, args.locale, args.fallbackLocale);
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
    workspaceId: string;
    conversationId: string | null;
    departmentId: string;
    locale?: string | null;
    fallbackLocale?: string | null;
  },
): Promise<TelegramScreen | null> {
  const s = strings(args.locale, args.fallbackLocale);
  const visible = await resolveWidgetVisibleDepartments(config, args.workspaceId, 'chat').catch(
    () => [] as VisibleDepartment[],
  );
  const chosen = visible.find((d) => d.id === args.departmentId);
  if (!chosen) {
    if (!visible.length) return null;
    return buildDepartmentPicker(visible, args.locale, args.fallbackLocale);
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
  args: { workspaceId: string; locale?: string | null; fallbackLocale?: string | null },
): Promise<TelegramScreen | null> {
  const visible = await resolveWidgetVisibleDepartments(config, args.workspaceId, 'chat').catch(
    () => [] as VisibleDepartment[],
  );
  if (visible.length < 2) return null;
  return buildDepartmentPicker(visible, args.locale, args.fallbackLocale);
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
