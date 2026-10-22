/**
 * The Inbox list's department filter (`?department=<id>` or `none`): a
 * presentation-only narrowing of the list in view, like the channel inboxes.
 * Drawn only when the workspace has departments.
 */
import { Building2, Check } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { NO_DEPARTMENT, type DepartmentOption } from '@/lib/inboxDepartments';

export function DepartmentFilter({ options, value, onChange, compact = false, t, dir }: {
  options: DepartmentOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** A narrow list column: the icon alone (the name is in its title). */
  compact?: boolean;
  t: (key: string) => string;
  dir: 'ltr' | 'rtl';
}) {
  if (!options.length) return null;
  const current = value === NO_DEPARTMENT
    ? t('inbox.departmentNone')
    : options.find((o) => o.id === value)?.name ?? null;
  const item = (key: string, label: string, selected: boolean, next: string | null) => (
    <DropdownMenuItem
      key={key}
      data-department-option={key}
      onSelect={() => onChange(next)}
      className="gap-2 text-[12px]"
    >
      <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100 text-primary' : 'opacity-0')} />
      <span className="truncate">{label}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu dir={dir}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-inbox="department-filter"
          data-active={!!value}
          title={current ? `${t('inbox.departmentFilter')}: ${current}` : t('inbox.departmentFilter')}
          aria-label={t('inbox.departmentFilter')}
          className={cn(
            'inline-flex max-w-[9rem] items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors',
            value
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          {!compact && <span className="truncate">{current ?? t('inbox.departmentAll')}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={dir === 'rtl' ? 'start' : 'end'} className="w-56">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">{t('inbox.departmentFilter')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {item('all', t('inbox.departmentAll'), !value, null)}
        {options.map((o) => item(o.id, o.name, value === o.id, o.id))}
        {item(NO_DEPARTMENT, t('inbox.departmentNone'), value === NO_DEPARTMENT, NO_DEPARTMENT)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
