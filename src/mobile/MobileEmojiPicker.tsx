/**
 * Native (iOS) emoji sheet for the conversation composer.
 *
 * Deliberately dependency-free: a curated, categorised set rendered as a
 * scrollable grid inside a rounded sheet that follows the app theme tokens
 * (so it looks right in both light and dark mode).
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

export function MobileEmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(CATEGORIES[0].id);
  const category = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0];

  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
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
        <button
          type="button"
          onClick={onClose}
          className="ms-auto px-3 py-1.5 text-[14px] font-medium text-primary active:opacity-60"
        >
          ✕
        </button>
      </div>

      <div className="grid max-h-[210px] grid-cols-8 gap-1 overflow-y-auto overscroll-contain p-2">
        {category.emojis.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onPick(e)}
            className="flex h-9 items-center justify-center rounded-xl text-[22px] transition-transform active:scale-90 active:bg-muted"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
