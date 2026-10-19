/**
 * System rows written in the OPERATOR's language by the server, for the
 * readers that print a row's `body`: the native operator apps (iOS, Android,
 * macOS, Windows) for a kind their own table lacks — windows-native prints
 * `body` for every kind in its list — and the transcript email.
 *
 * The sentence is the dashboard's (`shared/systemMessageText.ts`, the same
 * code); the strings are a copy of the keys it reads from
 * `src/i18n/locales/{fa,en,tr}.ts`, which the server image does not carry.
 * `src/test/inbox/operatorSystemText.test.ts` holds every value equal to the
 * dashboard's and every key the localizer reads present here, so a change to
 * a locale file fails the test until it is copied.
 *
 * Stored rows are never rewritten: only the response carries the localized
 * `body`; `metadata` (and the list's `system_kind` / `system_meta`) keep the
 * stored values, apart from the English stand-ins once stored as a name
 * ('a colleague'), which are nulled so a client's own table takes its
 * generic sentence instead of printing them inside a Persian one.
 */
import { systemMessageText, type SystemMessageMeta } from '../../shared/systemMessageText.js';
import { isPlaceholderName } from '../../shared/systemMessages.js';
import { REQUESTER_KIND } from './platformSupport/requester.js';
import type { OperatorLocale } from './operatorLocale.js';

export const OPERATOR_SYSTEM_STRINGS: Record<OperatorLocale, Record<string, string>> = {
  fa: {
    'inbox.callEnded.summary.byOperator': 'تماس از طرف اپراتور پایان یافت · مدت مکالمه {duration}',
    'inbox.callEnded.summary.bySystem': 'تماس پایان یافت · مدت مکالمه {duration}',
    'inbox.callEnded.summary.byVisitor': 'تماس از طرف کاربر پایان یافت · مدت مکالمه {duration}',
    'inbox.callEnded.summary.notConnected': 'تماس برقرار نشد',
    'inbox.callInvite.statusCancelled': 'لغو شد',
    'inbox.callInvite.statusDeclined': 'رد شد',
    'inbox.callInvite.statusExpired': 'منقضی',
    'inbox.callInvite.statusJoined': 'پیوست',
    'inbox.callInvite.statusPending': 'در انتظار',
    'inbox.requester.title': 'مشخصات درخواست‌کننده',
    'inbox.system.agentJoined': '{name} به گفتگو پیوست',
    'inbox.system.agentJoinedGeneric': 'یکی از همکاران به گفتگو پیوست',
    'inbox.system.callInviteAudio': 'کاربر به تماس صوتی دعوت شد',
    'inbox.system.callInviteAudioFrom': '{op} کاربر را به تماس صوتی دعوت کرد',
    'inbox.system.callInviteVideo': 'کاربر به تماس تصویری دعوت شد',
    'inbox.system.callInviteVideoFrom': '{op} کاربر را به تماس تصویری دعوت کرد',
    'inbox.system.closed': 'گفتگو بسته شد',
    'inbox.system.closedBy': '{name} گفتگو را بست',
    'inbox.system.inQueue': 'کاربر در صف پشتیبانی منتظر است',
    'inbox.system.noAgentAvailable': 'همه همکاران در حال حاضر مشغول هستند. پیام شما ثبت شد و در اولین فرصت پاسخ می‌دهیم.',
    'inbox.system.supportRating': 'به این گفتگو {score} از ۵ امتیاز داد',
    'inbox.system.supportRatingComment': '{rating} — «{comment}»',
    'inbox.system.transferred': '{actor} این گفتگو را به {to} منتقل کرد',
    'inbox.system.transferredGeneric': 'این گفتگو منتقل شد',
    'inbox.system.transferredTo': 'این گفتگو به {to} منتقل شد',
    'inbox.system.unassigned': '{actor} این گفتگو را از حالت واگذارشده خارج کرد',
    'inbox.system.unassignedGeneric': 'این گفتگو از حالت واگذارشده خارج شد',
  },
  en: {
    'inbox.callEnded.summary.byOperator': 'Call ended by operator · Duration {duration}',
    'inbox.callEnded.summary.bySystem': 'Call ended · Duration {duration}',
    'inbox.callEnded.summary.byVisitor': 'Call ended by visitor · Duration {duration}',
    'inbox.callEnded.summary.notConnected': 'Call did not connect',
    'inbox.callInvite.statusCancelled': 'Cancelled',
    'inbox.callInvite.statusDeclined': 'Declined',
    'inbox.callInvite.statusExpired': 'Expired',
    'inbox.callInvite.statusJoined': 'Joined',
    'inbox.callInvite.statusPending': 'Pending',
    'inbox.requester.title': 'Who is asking',
    'inbox.system.agentJoined': '{name} joined the conversation',
    'inbox.system.agentJoinedGeneric': 'A colleague joined the conversation',
    'inbox.system.callInviteAudio': 'Visitor invited to an audio call',
    'inbox.system.callInviteAudioFrom': '{op} invited the visitor to an audio call',
    'inbox.system.callInviteVideo': 'Visitor invited to a video call',
    'inbox.system.callInviteVideoFrom': '{op} invited the visitor to a video call',
    'inbox.system.closed': 'The conversation was closed',
    'inbox.system.closedBy': '{name} closed the conversation',
    'inbox.system.inQueue': 'The visitor is waiting in the support queue',
    'inbox.system.noAgentAvailable': "All our colleagues are currently busy. Your message was recorded and we'll respond as soon as we can.",
    'inbox.system.supportRating': 'Rated the conversation {score}/5',
    'inbox.system.supportRatingComment': '{rating} — “{comment}”',
    'inbox.system.transferred': '{actor} transferred this conversation to {to}',
    'inbox.system.transferredGeneric': 'This conversation was transferred',
    'inbox.system.transferredTo': 'This conversation was transferred to {to}',
    'inbox.system.unassigned': '{actor} unassigned this conversation',
    'inbox.system.unassignedGeneric': 'This conversation was unassigned',
  },
  tr: {
    'inbox.callEnded.summary.byOperator': 'Görüşme operatör tarafından sonlandırıldı · Süre {duration}',
    'inbox.callEnded.summary.bySystem': 'Görüşme sona erdi · Süre {duration}',
    'inbox.callEnded.summary.byVisitor': 'Görüşme ziyaretçi tarafından sonlandırıldı · Süre {duration}',
    'inbox.callEnded.summary.notConnected': 'Görüşme bağlanamadı',
    'inbox.callInvite.statusCancelled': 'İptal edildi',
    'inbox.callInvite.statusDeclined': 'Reddedildi',
    'inbox.callInvite.statusExpired': 'Süresi doldu',
    'inbox.callInvite.statusJoined': 'Katıldı',
    'inbox.callInvite.statusPending': 'Bekliyor',
    'inbox.requester.title': 'Talep eden',
    'inbox.system.agentJoined': '{name} sohbete katıldı',
    'inbox.system.agentJoinedGeneric': 'Bir meslektaşımız sohbete katıldı',
    'inbox.system.callInviteAudio': 'Ziyaretçi sesli aramaya davet edildi',
    'inbox.system.callInviteAudioFrom': '{op} ziyaretçiyi sesli aramaya davet etti',
    'inbox.system.callInviteVideo': 'Ziyaretçi görüntülü aramaya davet edildi',
    'inbox.system.callInviteVideoFrom': '{op} ziyaretçiyi görüntülü aramaya davet etti',
    'inbox.system.closed': 'Sohbet kapatıldı',
    'inbox.system.closedBy': '{name} sohbeti kapattı',
    'inbox.system.inQueue': 'Ziyaretçi destek kuyruğunda bekliyor',
    'inbox.system.noAgentAvailable': 'Tüm ekibimiz şu anda meşgul. Mesajınız kaydedildi, en kısa sürede yanıtlayacağız.',
    'inbox.system.supportRating': 'Görüşmeye 5 üzerinden {score} puan verdi',
    'inbox.system.supportRatingComment': '{rating} — “{comment}”',
    'inbox.system.transferred': '{actor} bu görüşmeyi {to} kişisine aktardı',
    'inbox.system.transferredGeneric': 'Bu görüşme aktarıldı',
    'inbox.system.transferredTo': 'Bu görüşme {to} kişisine aktarıldı',
    'inbox.system.unassigned': '{actor} bu görüşmenin atamasını kaldırdı',
    'inbox.system.unassignedGeneric': 'Bu görüşmenin ataması kaldırıldı',
  },
};

/** The metadata keys that hold a person's name (the producers' own key names). */
const NAME_KEYS = ['agent_name', 'actor_name', 'to_name', 'from_name', 'operator_name'] as const;

function asMeta(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

/**
 * One system row's sentence in `locale`, or null when the localizer cannot
 * write it (no kind, an unknown kind, a rating without a score): the caller
 * keeps the stored body then.
 */
export function operatorSystemText(metadata: unknown, locale: OperatorLocale): string | null {
  const meta = asMeta(metadata);
  if (!meta || typeof meta.kind !== 'string' || !meta.kind) return null;
  const strings = OPERATOR_SYSTEM_STRINGS[locale] ?? OPERATOR_SYSTEM_STRINGS.en;
  return systemMessageText(meta as SystemMessageMeta, (key) => strings[key] ?? key);
}

/**
 * The metadata with the English stand-ins once stored as a name set to
 * null; the same object when there is none.
 */
export function withoutPlaceholderNames<T>(metadata: T): T {
  const meta = asMeta(metadata);
  if (!meta || !NAME_KEYS.some((key) => isPlaceholderName(meta[key]))) return metadata;
  const out: Record<string, unknown> = { ...meta };
  for (const key of NAME_KEYS) if (isPlaceholderName(out[key])) out[key] = null;
  return out as T;
}

/**
 * A message row as the operator API returns it: a system row's `body` in
 * the operator's language and its metadata without placeholder names. Any
 * other row, or a system row the localizer cannot write and whose metadata
 * holds no placeholder, comes back as the same object.
 */
export function withOperatorSystemBody<R extends { sender_type?: unknown; body?: unknown; metadata?: unknown }>(
  row: R,
  locale: OperatorLocale,
): R {
  if (!row || row.sender_type !== 'system') return row;
  // The requester card's body is the whole card (platformSupport/
  // requester.ts), which macOS and the Electron app print in the thread:
  // one line would lose its details. List previews write it as one line.
  const text = asMeta(row.metadata)?.kind === REQUESTER_KIND ? null : operatorSystemText(row.metadata, locale);
  const metadata = withoutPlaceholderNames(row.metadata);
  if (text === null && metadata === row.metadata) return row;
  return { ...row, ...(text !== null ? { body: text } : {}), metadata };
}
