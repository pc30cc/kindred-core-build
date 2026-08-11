import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AiAccent = 'indigo' | 'violet' | 'emerald' | 'cyan' | 'amber' | 'sky' | 'rose';

export const AI_ACCENT: Record<AiAccent, { grad: string; chip: string; glow: string; ring: string; soft: string }> = {
  indigo: {
    grad: 'from-indigo-500 to-violet-500',
    chip: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-indigo-500/20',
    glow: 'bg-indigo-500/25',
    ring: 'ring-indigo-500/20',
    soft: 'from-indigo-500/12 via-violet-500/8',
  },
  violet: {
    grad: 'from-violet-500 to-fuchsia-500',
    chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-300 ring-violet-500/20',
    glow: 'bg-violet-500/25',
    ring: 'ring-violet-500/20',
    soft: 'from-violet-500/12 via-fuchsia-500/8',
  },
  emerald: {
    grad: 'from-emerald-500 to-teal-500',
    chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-emerald-500/20',
    glow: 'bg-emerald-500/25',
    ring: 'ring-emerald-500/20',
    soft: 'from-emerald-500/12 via-teal-500/8',
  },
  cyan: {
    grad: 'from-cyan-500 to-sky-500',
    chip: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 ring-cyan-500/20',
    glow: 'bg-cyan-500/25',
    ring: 'ring-cyan-500/20',
    soft: 'from-cyan-500/12 via-sky-500/8',
  },
  amber: {
    grad: 'from-amber-500 to-orange-500',
    chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 ring-amber-500/20',
    glow: 'bg-amber-500/25',
    ring: 'ring-amber-500/20',
    soft: 'from-amber-500/12 via-orange-500/8',
  },
  sky: {
    grad: 'from-sky-500 to-blue-500',
    chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-300 ring-sky-500/20',
    glow: 'bg-sky-500/25',
    ring: 'ring-sky-500/20',
    soft: 'from-sky-500/12 via-blue-500/8',
  },
  rose: {
    grad: 'from-rose-500 to-pink-500',
    chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-rose-500/20',
    glow: 'bg-rose-500/25',
    ring: 'ring-rose-500/20',
    soft: 'from-rose-500/12 via-pink-500/8',
  },
};

interface Props {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  accent?: AiAccent;
  /** Right-hand actions / status controls. */
  actions?: ReactNode;
  /** Extra row rendered under the subtitle (badges, hints). */
  meta?: ReactNode;
}

/**
 * Shared colorful hero header for every AI Agent page. Keeps the module
 * visually consistent while giving each page its own accent identity.
 */
export function AiPageHeader({ icon: Icon, title, subtitle, accent = 'indigo', actions, meta }: Props) {
  const a = AI_ACCENT[accent];
  return (
    <div className={cn(
      'relative overflow-hidden rounded-2xl border border-border/60 p-6 sm:p-7 bg-gradient-to-br to-transparent',
      a.soft,
    )}>
      <div className={cn('pointer-events-none absolute -top-20 -end-16 h-56 w-56 rounded-full blur-3xl', a.glow)} />
      <div className={cn('pointer-events-none absolute -bottom-24 -start-12 h-52 w-52 rounded-full blur-3xl opacity-60', a.glow)} />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className={cn(
            'h-12 w-12 shrink-0 rounded-2xl bg-gradient-to-br shadow-lg flex items-center justify-center text-white',
            a.grad,
          )}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight leading-tight">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">{subtitle}</p>}
            {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">{actions}</div>}
      </div>
    </div>
  );
}

export default AiPageHeader;