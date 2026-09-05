/**
 * Native (iOS) emoji panel for the conversation composer.
 *
 * Rendered INLINE below the composer — it takes the place of the system
 * keyboard (a panel that rises from the page itself) instead of floating as a
 * detached card. Picking an emoji inserts it into the draft and closes.
 *
 * Deliberately dependency-free: a curated, categorised set rendered as a
 * scrollable grid that follows the app theme tokens (light and dark mode).
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';

const CATEGORIES: { id: string; icon: string; emojis: string[] }[] = [
  {
    id: 'smileys',
    icon: '😊',
    emojis: [
      '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
      '😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤗','🤭','🤔','🤐','😐','😑','😶',
      '😏','😒','🙄','😬','😮','😯','😴','🥱','😔','😕','🙁','😢','😭','😤','😠','😡',
      '🥳','😎','🤓','🧐','😳','🥺','😱','😨','😰','🤯','🤒','🤕','🤢','🤧','😷','🤠',
    ],
  },
  {
    id: 'gestures',
    icon: '👍',
    emojis: [
      '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️',
      '🖖','👋','🤝','🙏','👏','🙌','💪','🦾','✍️','💅','👀','🫶','❤️','🧡','💛','💚',
      '💙','💜','🖤','🤍','💔','💯','🔥','✨','⭐','🌟','💫','🎉','🎊','🎁','🏆','🥇',
    ],
  },
  {
    id: 'objects',
    icon: '💼',
    emojis: [
      '💼','📁','📄','📝','📌','📎','🔒','🔑','💡','🔔','📣','📞','📱','💻','⌨️','🖥️',
      '🖨️','🕒','📅','📊','📈','📉','💳','💰','🧾','🛒','📦','🚀','⚙️','🔧','🛠️','✅',
      '❌','⚠️','❓','❗','➕','➖','🔁','🔗','📍','🌍','☀️','🌙','☕','🍕','🎯','🧠',
    ],
  },
];

export function MobileEmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [active, setActive] = useState(CATEGORIES[0].id);
  const category = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0];

  return (
    <div className="flex h-[292px] flex-col bg-card">
      <div className="flex shrink-0 items-center gap-1 px-3 py-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActive(c.id)}
            className={cn(
              'h-9 w-9 rounded-full text-[19px] transition-colors active:scale-90',
              active === c.id ? 'bg-primary/12' : 'opacity-60',
            )}
            aria-label={c.id}
          >
            {c.icon}
          </button>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-8 gap-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {category.emojis.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onPick(e)}
            className="flex h-10 items-center justify-center rounded-xl text-[24px] transition-transform active:scale-90 active:bg-muted"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
