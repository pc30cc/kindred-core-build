/**
 * A system row in the inbox thread (`sender_type = 'system'`): always a
 * centred notice, never an operator bubble with reply and copy.
 *
 * The server stores these bodies in English (chatRouting.ts, the
 * conversations PATCH, calls/*, conversationClosedNotice.ts,
 * platformSupport/service.ts), so each is drawn from its `metadata` in the
 * operator's language (`systemMessageText`). A kind this thread does not
 * know — one added on the server before the dashboard — still reads as a
 * notice, with the stored body as its text. `routing_in_queue` used to fall
 * through to the bubble and print "Your message is in the support queue."
 * in English, as if the operator had sent it.
 *
 * Each notice also says who else reads it (I-12): the team only
 * (`metadata.internal`, which the widget never receives — an unassign, a
 * support rating), or the visitor too. For a transfer the visitor reads
 * something else than the team («Y به گفتگو پیوست», not «X گفتگو را به Y
 * منتقل کرد»); its marker says what.
 */
import { Eye, Lock, Phone, PhoneOff, Star, Video } from 'lucide-react';
import {
  systemMessageText, invitationStatusText, type SystemMessageMeta, type Translate,
} from '@/lib/systemMessageText';
import { SupportRequesterCard } from './SupportRequesterCard';
import { isVisitorVisibleNotice, visitorVersionOf } from './systemNoticeVisibility';
import { REQUESTER_KIND, type RequesterCardMeta } from './requesterMeta';

interface SystemNoticeRowProps {
  body: string | null | undefined;
  meta: Record<string, unknown>;
  t: Translate;
}

const PILL = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/60 text-muted-foreground text-[11px] border border-border/60';

function word(t: Translate, key: string, fallback: string): string {
  const text = t(key);
  return text && text !== key ? text : fallback;
}

/** The "team only" / "the visitor sees this too" marker inside a notice. */
function VisibilityMark({ meta, t }: { meta: Record<string, unknown>; t: Translate }) {
  if (!isVisitorVisibleNotice(meta)) {
    const label = word(t, 'inbox.internalOnly', 'Internal only');
    return (
      <span data-inbox="notice-visibility" data-visibility="internal" className="inline-flex shrink-0 items-center gap-0.5 opacity-80" title={word(t, 'inbox.systemInternalHint', 'Only your team sees this; the visitor does not.')}>
        <Lock className="w-3 h-3" aria-hidden />
        <span>{label}</span>
      </span>
    );
  }
  const visitorText = visitorVersionOf(meta, t);
  const hint = visitorText
    ? word(t, 'inbox.systemVisitorSees', 'The visitor sees: {{text}}').replace('{{text}}', () => `«${visitorText}»`)
    : word(t, 'inbox.systemVisibleHint', 'The visitor sees this too');
  return (
    <span data-inbox="notice-visibility" data-visibility="visitor" role="img" aria-label={hint} className="inline-flex shrink-0 items-center opacity-70" title={hint}>
      <Eye className="w-3 h-3" aria-hidden />
    </span>
  );
}

export function SystemNoticeRow({ body, meta, t }: SystemNoticeRowProps) {
  const kind = typeof meta.kind === 'string' ? meta.kind : '';
  // Who is asking: the site user's account, workspaces, plans and usage, at
  // the top of a platform-support conversation.
  if (kind === REQUESTER_KIND) {
    return <SupportRequesterCard meta={meta as RequesterCardMeta} />;
  }
  const localized = systemMessageText(meta as SystemMessageMeta, t);
  const text = localized ?? String(body ?? '');

  // The invitation card mutates in place as the visitor acts on it
  // (server/services/calls/invitations.ts); the visitor widget draws it from
  // metadata the same way.
  if (kind === 'call_invitation') {
    const isVideo = meta.channel === 'video';
    // The shared localizer appends the live status; the thread shows it as
    // its own chip, so take the sentence alone.
    const status = String(meta.status || 'pending');
    const statusText = invitationStatusText(t, status);
    const sentence = text.endsWith(` · ${statusText}`) ? text.slice(0, -(statusText.length + 3)) : text;
    return (
      <div data-inbox="system-notice" data-kind={kind} className="flex justify-center my-1">
        <div className={PILL}>
          {isVideo ? <Video className="w-3 h-3" /> : <Phone className="w-3 h-3" />}
          <span>{sentence}</span>
          <span className="opacity-70">· {statusText}</span>
          <VisibilityMark meta={meta} t={t} />
        </div>
      </div>
    );
  }
  // A site user's rating of a platform-support conversation
  // (docs/PLATFORM_SUPPORT.md). Internal: only the team sees it.
  // A kind the localizer does not know keeps its stored body, which may run
  // to several lines.
  if (kind === 'support_rating' || localized === null) {
    return (
      <div data-inbox="system-notice" data-kind={kind || undefined} className="flex justify-center my-1">
        <div className="inline-flex max-w-[85%] items-start gap-1.5 px-3 py-1 rounded-2xl bg-muted/60 text-muted-foreground text-[11px] border border-border/60">
          {kind === 'support_rating' ? <Star className="w-3 h-3 mt-0.5 shrink-0 text-warning" /> : null}
          <span className="whitespace-pre-wrap break-words">{text}</span>
          <span className="mt-0.5"><VisibilityMark meta={meta} t={t} /></span>
        </div>
      </div>
    );
  }
  // Joins, transfers, unassigns, the «X closed the conversation» line the
  // visitor also sees (under which they are asked to rate the chat), the
  // queue and no-agent notices, a call's summary.
  return (
    <div data-inbox="system-notice" data-kind={kind} className="flex justify-center my-1">
      <div className={PILL}>
        {kind === 'call_ended' ? <PhoneOff className="w-3 h-3" /> : null}
        <span>{text}</span>
        <VisibilityMark meta={meta} t={t} />
      </div>
    </div>
  );
}
