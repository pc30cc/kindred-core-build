/**
 * Lightweight emoji picker for operator composers (Inbox + Colleagues).
 * No dependency, no network: a curated grid inside a popover. Emits the
 * raw character so the caller can insert it at the caret.
 */
import { Smile } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

const EMOJIS: string[] = [
  '😀','😃','😄','😁','😆','😅','😂','🤣','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
  '😘','😗','😚','😙','😋','😛','😜','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😞',
  '😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯',
  '😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑',
  '😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿',
  '👍','👎','👌','✌️','🤞','🤟','🤙','👋','🙏','👏','🙌','💪','🤝','✍️','💅','👀',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💯','🔥','✨','⭐','🎉','🎊','🎁',
  '✅','❌','⚠️','❗','❓','⏰','📌','📎','📞','📧','💬','📝','📷','🎧','🎤','🚀',
];

export function EmojiPicker({
  onPick,
  disabled,
  className,
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t('inbox.emoji') || 'Emoji';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={label}
          aria-label={label}
          className={cn(
            'h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground',
            'hover:text-foreground hover:bg-secondary transition-colors shrink-0 self-center',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            className,
          )}
        >
          <Smile className="w-[18px] h-[18px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-2" dir="ltr">
        <ScrollArea className="h-[196px] pe-1">
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                className="h-8 w-8 rounded-md text-[18px] leading-none hover:bg-secondary transition-colors"
              >
                {e}
              </button>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

export default EmojiPicker;
