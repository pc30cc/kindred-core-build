/**
 * The one-line explanatory note used across the macOS app tabs: an icon and
 * a sentence, tinted by what it is saying (context, or a warning that
 * changes what the setting does).
 */
import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export function MacosNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }) {
  const Icon = tone === 'warning' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-xl p-3 text-xs',
        tone === 'warning'
          ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200'
          : 'bg-primary/5 text-muted-foreground',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'warning' ? 'text-amber-600' : 'text-primary')} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
