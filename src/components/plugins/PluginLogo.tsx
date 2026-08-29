/**
 * Brand marks for the plugin catalogue.
 *
 * Each plugin renders its own simplified brand glyph on a tinted tile so the
 * marketplace reads like a real app store instead of a wall of identical
 * generic icons. Unknown plugins fall back to a neutral plug tile.
 */

import { Plug, Webhook, ShoppingBag, Users, MessageSquare, Mail, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';

type Mark = {
  /** Tailwind-safe inline gradient (brand colours are intentionally literal). */
  from: string;
  to: string;
  svg?: React.ReactNode;
  fallback?: typeof Plug;
};

const MARKS: Record<string, Mark> = {
  telegram: {
    from: '#2AABEE',
    to: '#229ED9',
    svg: (
      <path
        fill="currentColor"
        d="M21.9 4.3 18.7 19.4c-.24 1.07-.88 1.33-1.78.83l-4.92-3.63-2.37 2.28c-.26.26-.48.48-.99.48l.35-4.99 9.1-8.22c.4-.35-.08-.55-.61-.2L6.24 12.03 1.4 10.5c-1.05-.33-1.07-1.05.22-1.56L20.54 2.7c.87-.33 1.63.2 1.36 1.6Z"
      />
    ),
  },
  whatsapp: {
    from: '#25D366',
    to: '#128C7E',
    svg: (
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-8.6 15.06L2 22l5.07-1.33A10 10 0 1 0 12 2Zm5.5 14.1c-.24.67-1.4 1.3-1.93 1.34-.5.05-1.12.07-1.8-.11a15.9 15.9 0 0 1-4.1-2.05 12.3 12.3 0 0 1-3.4-4.18c-.36-.62-.6-1.36-.6-2.1 0-.75.4-1.4.86-1.86.2-.2.44-.3.66-.3h.48c.16 0 .37-.05.57.44l.8 1.94c.07.15.11.32.02.5-.09.19-.13.3-.27.46l-.4.47c-.13.13-.27.28-.12.55.16.26.7 1.15 1.5 1.86 1.03.92 1.9 1.2 2.17 1.34.27.13.42.11.58-.07l.83-.96c.19-.22.35-.16.58-.08l1.9.9c.24.11.4.17.46.27.06.1.06.6-.18 1.27Z"
      />
    ),
  },
  instagram: {
    from: '#F58529',
    to: '#C13584',
    svg: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
      </>
    ),
  },
  messenger: {
    from: '#0084FF',
    to: '#A033FF',
    svg: (
      <path
        fill="currentColor"
        d="M12 2C6.3 2 2 6.2 2 11.7c0 3.1 1.4 5.9 3.7 7.7v3.1l3.4-1.9c.9.25 1.9.4 2.9.4 5.7 0 10-4.2 10-9.3S17.7 2 12 2Zm1 12.1-2.6-2.7-4.9 2.7 5.4-5.7 2.6 2.7 4.8-2.7-5.3 5.7Z"
      />
    ),
  },
  slack: {
    from: '#36C5F0',
    to: '#E01E5A',
    svg: (
      <path
        fill="currentColor"
        d="M6 14.5A2 2 0 1 1 4 12.5h2v2Zm1 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5ZM9.5 6a2 2 0 1 1 2-2v2h-2Zm0 1a2 2 0 0 1 0 4h-5a2 2 0 1 1 0-4h5ZM18 9.5a2 2 0 1 1 2 2h-2v-2Zm-1 0a2 2 0 0 1-4 0v-5a2 2 0 1 1 4 0v5ZM14.5 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z"
      />
    ),
  },
  discord: {
    from: '#5865F2',
    to: '#404EED',
    svg: (
      <path
        fill="currentColor"
        d="M19.3 5.4A16 16 0 0 0 15.4 4l-.3.6a12 12 0 0 1 3.4 1.7 15 15 0 0 0-12.9 0A12 12 0 0 1 9 4.6L8.7 4a16 16 0 0 0-4 1.4C2.2 9.2 1.5 12.9 1.8 16.5a16 16 0 0 0 4.9 2.5l1-1.6a10 10 0 0 1-1.6-.8l.4-.3a11.4 11.4 0 0 0 9.8 0l.4.3c-.5.3-1 .6-1.6.8l1 1.6a16 16 0 0 0 5-2.5c.4-4.2-.7-7.9-2.8-11.1ZM8.7 14.3c-1 0-1.7-.9-1.7-2s.8-2 1.7-2 1.8.9 1.7 2c0 1.1-.8 2-1.7 2Zm6.6 0c-1 0-1.7-.9-1.7-2s.8-2 1.7-2 1.8.9 1.7 2c0 1.1-.7 2-1.7 2Z"
      />
    ),
  },
  email: { from: '#6366F1', to: '#4338CA', fallback: Mail },
  sms: { from: '#0EA5E9', to: '#0369A1', fallback: Smartphone },
  shopify: {
    from: '#95BF47',
    to: '#5E8E3E',
    fallback: ShoppingBag,
  },
  woocommerce: { from: '#9B5C8F', to: '#7F54B3', fallback: ShoppingBag },
  hubspot: { from: '#FF7A59', to: '#E8532F', fallback: Users },
  webhooks: { from: '#64748B', to: '#334155', fallback: Webhook },
  default: { from: '#94A3B8', to: '#475569', fallback: Plug },
};

export function PluginLogo({
  id,
  className,
  size = 'md',
}: {
  id: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const mark = MARKS[id] ?? MARKS.default;
  const Fallback = mark.fallback ?? MessageSquare;
  const box = size === 'lg' ? 'h-14 w-14 rounded-2xl' : size === 'sm' ? 'h-9 w-9 rounded-lg' : 'h-12 w-12 rounded-xl';
  const glyph = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-4.5 w-4.5' : 'h-6 w-6';

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center text-white shadow-sm ring-1 ring-black/5',
        box,
        className,
      )}
      style={{ backgroundImage: `linear-gradient(135deg, ${mark.from}, ${mark.to})` }}
      aria-hidden
    >
      {mark.svg ? (
        <svg viewBox="0 0 24 24" className={glyph}>
          {mark.svg}
        </svg>
      ) : (
        <Fallback className={glyph} />
      )}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-b from-white/25 to-transparent opacity-60" />
    </div>
  );
}
