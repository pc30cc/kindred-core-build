/**
 * Message reactions in the inbox thread (issue #340 g2).
 *
 *   - MessageReactionChips: the reactions under a bubble, one chip per emoji
 *     with its count. On a visitor's message an operator may react to
 *     (`can_react`), each chip sets or takes back their own; elsewhere (the
 *     visitor's ❤️ on a team message) they only show.
 *   - ReactionPickerButton: the side action of a visitor's message that
 *     offers the six reactions (shared/messageReactions.ts).
 *
 * The server offers reacting (`can_react`) only on widget conversations of a
 * workspace whose template shows reactions to the visitor, so an operator
 * never reacts where nobody sees it. Each chip's label says who reacted
 * (the visitor, you, teammates) — never a teammate's name.
 */
import { SmilePlus } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { MessageReaction } from '@/hooks/useConversations';
import { MESSAGE_REACTION_EMOJIS } from '../../../shared/messageReactions';

/** "❤️ 2 — Visitor, you" style label of one chip (screen readers, tooltip). */
function reactionChipLabel(
  r: MessageReaction,
  t: (key: 'inbox.visitor' | 'inbox.reactionYou' | 'inbox.reactionTeamOne' | 'inbox.reactionTeam', params?: Record<string, string | number>) => string,
  locale: string,
): string {
  const who: string[] = [];
  if (r.visitor) who.push(t('inbox.visitor'));
  if (r.mine) who.push(t('inbox.reactionYou'));
  const others = r.count - (r.visitor ? 1 : 0) - (r.mine ? 1 : 0);
  if (others === 1) who.push(t('inbox.reactionTeamOne'));
  else if (others > 1) who.push(t('inbox.reactionTeam', { count: others.toLocaleString(locale) }));
  return `${r.emoji} ${r.count.toLocaleString(locale)} — ${who.join(locale === 'fa' ? '، ' : ', ')}`;
}

export function MessageReactionChips({
  reactions,
  canToggle,
  onToggle,
  align,
}: {
  reactions: MessageReaction[];
  /** The reader may set / take back their own reaction from a chip. */
  canToggle: boolean;
  onToggle?: (emoji: string, on: boolean) => void;
  /** Which side of the thread the bubble sits on (the row's layout is LTR). */
  align: 'start' | 'end';
}) {
  const { t, locale, dir } = useTranslation();
  if (!reactions.length) return null;
  return (
    <div
      data-inbox="reactions"
      role="group"
      aria-label={t('inbox.reactions')}
      className={cn('flex flex-wrap gap-1 mt-1', align === 'end' ? 'justify-end' : 'justify-start')}
    >
      {reactions.map((r) => {
        const label = reactionChipLabel(r, t, locale);
        const body = (
          <>
            <span aria-hidden className="text-[13px] leading-none">{r.emoji}</span>
            <bdi dir={dir} aria-hidden className="tabular-nums">{r.count.toLocaleString(locale)}</bdi>
          </>
        );
        const look = cn(
          'h-6 px-2 rounded-full border text-[12px] inline-flex items-center gap-1 transition-colors',
          r.mine ? 'bg-primary/10 border-primary/40 text-primary' : 'bg-background border-border text-muted-foreground',
        );
        return canToggle && onToggle ? (
          <button
            key={r.emoji}
            type="button"
            data-reaction={r.emoji}
            aria-pressed={r.mine}
            aria-label={label}
            title={label}
            onClick={() => onToggle(r.emoji, !r.mine)}
            className={cn(look, 'hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
          >
            {body}
          </button>
        ) : (
          <span key={r.emoji} data-reaction={r.emoji} role="img" aria-label={label} title={label} className={look}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

export function ReactionPickerButton({
  reactions,
  onToggle,
}: {
  reactions: MessageReaction[] | undefined;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t('inbox.react');
  const mine = new Set((reactions || []).filter((r) => r.mine).map((r) => r.emoji));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-inbox="react"
          className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60"
          aria-label={label}
          title={label}
        >
          <SmilePlus className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="top" className="w-auto p-1" dir="ltr">
        <div role="group" aria-label={label} className="flex items-center gap-0.5">
          {MESSAGE_REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-reaction-pick={emoji}
              aria-pressed={mine.has(emoji)}
              aria-label={emoji}
              onClick={() => {
                onToggle(emoji, !mine.has(emoji));
                setOpen(false);
              }}
              className={cn(
                'h-8 w-8 rounded-md text-lg leading-none flex items-center justify-center transition-colors',
                'hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mine.has(emoji) && 'bg-primary/10',
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
