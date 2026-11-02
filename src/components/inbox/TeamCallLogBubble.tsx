/**
 * A colleague call's line in the team chat (docs/operations/TEAM_CALLS.md,
 * "The call in the chat"), as WhatsApp draws it: a call bubble on the
 * caller's side with the phone or video-camera icon, an arrow (out ↗ for the
 * caller, in ↙ for the callee; mirrored in RTL), the title for the member
 * looking at it, and the time with the duration for a completed call. Missed
 * (and cancelled, for the callee) is drawn in the danger colour.
 *
 * Clicking it calls back with the same channel when `callBack` is given (the
 * thread's own gate: the plan offers that kind of call with this colleague)
 * and is disabled while another call is on; without it the line is plain
 * text. It is never replied to, quoted or copied (no menu, no selection),
 * and its body (the older apps' fallback) is never drawn.
 *
 * Also the colleagues list's preview of such a line: its icon and title.
 */
import { ArrowDownLeft, ArrowUpRight, Phone, Video } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatTime } from '@/lib/date';
import { toPersianDigits } from '@/lib/persian-digits';
import { cn } from '@/lib/utils';
import type { TeamChatCall } from '@/lib/team-calls-api';
import { teamCallLogDuration, teamCallLogIsMissed, teamCallLogTitleKey } from '@/features/teamCalls/teamCallLog';

export function TeamCallLogBubble({
  call,
  createdAt,
  viewerIsCaller,
  callBack,
}: {
  call: TeamChatCall;
  /** The line's time: when the call rang. */
  createdAt: string;
  viewerIsCaller: boolean;
  /** Calling back with the call's channel, when the plan offers it with this colleague; null: plain text. */
  callBack: { disabled: boolean; onCallBack: () => void } | null;
}) {
  const { t, dir, locale } = useTranslation();
  const title = t(teamCallLogTitleKey(call, viewerIsCaller));
  const duration = teamCallLogDuration(call);
  const missed = teamCallLogIsMissed(call, viewerIsCaller);
  const time = formatTime(createdAt);
  const direction = t(viewerIsCaller ? 'teamCalls.log.outgoing' : 'teamCalls.log.incoming');
  const Icon = call.channel === 'video' ? Video : Phone;
  const Arrow = viewerIsCaller ? ArrowUpRight : ArrowDownLeft;
  // Read out in the panel's language: Persian with its own comma and digits
  // (the page's digit layer turns only the text drawn, not an attribute).
  const fa = locale === 'fa';
  const sep = fa ? '، ' : ', ';
  const spoken = duration && fa ? toPersianDigits(duration) : duration;
  const label = [spoken ? `${title}${sep}${spoken}` : title, direction, fa ? toPersianDigits(time) : time].join(sep);

  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
          missed ? 'bg-destructive/10 text-destructive' : 'bg-primary/15 text-primary',
        )}
      >
        <Icon className="w-[18px] h-[18px]" />
      </span>
      <span className="min-w-0 flex flex-col text-start">
        <span
          className={cn('text-[13px] font-semibold leading-snug truncate', missed ? 'text-destructive' : 'text-foreground')}
          data-team-call-log-title=""
        >
          {title}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-muted-foreground tabular-nums">
          <Arrow
            aria-hidden="true"
            data-team-call-log-arrow={viewerIsCaller ? 'out' : 'in'}
            className={cn('w-3 h-3 shrink-0', missed && 'text-destructive', dir === 'rtl' && '-scale-x-100')}
          />
          <span className="sr-only">{direction}</span>
          <bdi>{time}</bdi>
          {duration && (
            <>
              <span aria-hidden="true" className="opacity-50">·</span>
              <bdi data-team-call-log-duration="">{duration}</bdi>
            </>
          )}
        </span>
      </span>
    </>
  );

  const shell = cn(
    'select-none max-w-[75%] min-w-[11rem] flex items-center gap-2.5 rounded-2xl px-3 py-2 border shadow-sm',
    viewerIsCaller
      ? 'bg-primary/10 border-primary/20 rounded-ee-md'
      : 'bg-card border-border rounded-es-md',
  );
  const data = {
    'data-inbox': 'bubble',
    'data-from': viewerIsCaller ? 'agent' : 'contact',
    'data-team-call-log': call.outcome,
    'data-direction': viewerIsCaller ? 'outgoing' : 'incoming',
    'data-missed': missed ? '' : undefined,
  } as const;

  if (callBack) {
    return (
      <button
        type="button"
        {...data}
        aria-label={label}
        title={t('teamCalls.log.callBack')}
        disabled={callBack.disabled}
        onClick={callBack.onCallBack}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          shell,
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          viewerIsCaller ? 'enabled:hover:bg-primary/[0.14]' : 'enabled:hover:bg-secondary/60',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <div {...data} onContextMenu={(e) => e.preventDefault()} className={shell}>
      {body}
    </div>
  );
}

/** The colleagues list's preview of a call line: its icon and title (with a completed call's duration). */
export function TeamCallLogPreview({ call, viewerIsCaller }: { call: TeamChatCall; viewerIsCaller: boolean }) {
  const { t } = useTranslation();
  const title = t(teamCallLogTitleKey(call, viewerIsCaller));
  const duration = teamCallLogDuration(call);
  const missed = teamCallLogIsMissed(call, viewerIsCaller);
  const Icon = call.channel === 'video' ? Video : Phone;
  return (
    <span
      className={cn('flex items-center gap-1 min-w-0 text-[11.5px]', missed ? 'text-destructive' : 'text-muted-foreground')}
      data-team-call-preview={call.outcome}
    >
      <Icon aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{duration ? `${title} · ${duration}` : title}</span>
    </span>
  );
}
