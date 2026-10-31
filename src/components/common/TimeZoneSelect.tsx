/**
 * A searchable IANA time zone picker: every zone the browser knows, each by
 * its name in the reader's language and its offset (src/lib/timeZones.ts),
 * the common ones first. The phone field's country picker
 * (src/components/phone/PhoneNumberField.tsx) is the same shape.
 */
import { useMemo, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, Globe2, Search } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { SUGGESTED_TIME_ZONES, filterTimeZones, timeZoneEntries, type TimeZoneEntry } from '@/lib/timeZones';

export interface TimeZoneSelectLabels {
  search: string;
  noResults: string;
  suggested: string;
  all: string;
}

export interface TimeZoneSelectProps {
  value: string;
  onChange: (zone: string) => void;
  /** The language zone names are shown in. */
  locale: string;
  labels: TimeZoneSelectLabels;
  disabled?: boolean;
  id?: string;
}

export function TimeZoneSelect({ value, onChange, locale, labels, disabled, id }: TimeZoneSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const entries = useMemo(() => timeZoneEntries(locale), [locale]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  // A stored zone the browser does not list (an old alias) is still shown.
  const selected = byId.get(value) ?? timeZoneEntries(locale, [value || 'UTC'])[0];
  const visible = useMemo(() => filterTimeZones(entries, query), [entries, query]);
  const suggested = useMemo(
    () => (query ? [] : SUGGESTED_TIME_ZONES.map((z) => byId.get(z)).filter((e): e is TimeZoneEntry => Boolean(e))),
    [byId, query],
  );

  const choose = (zone: string) => {
    onChange(zone);
    setOpen(false);
    setQuery('');
  };

  const renderItem = (entry: TimeZoneEntry, keyPrefix: string) => (
    <CommandItem
      key={`${keyPrefix}-${entry.id}`}
      value={`${keyPrefix}-${entry.id}`}
      onSelect={() => choose(entry.id)}
      className="gap-2.5 py-2"
      data-testid={`timezone-option-${entry.id}`}
    >
      <span className="flex-1 truncate">
        {entry.name}
        {entry.name !== entry.id && <span className="ms-1.5 text-xs text-muted-foreground" dir="ltr">{entry.id}</span>}
      </span>
      <span className="font-mono text-xs text-muted-foreground" dir="ltr">{entry.offset}</span>
      <Check className={cn('h-4 w-4 text-primary', entry.id === selected.id ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          data-testid="timezone-trigger"
          className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-start">{selected.name}</span>
          <span className="font-mono text-xs text-muted-foreground" dir="ltr">{selected.offset}</span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="min-w-[20rem] max-w-[calc(100vw-2rem)] p-0"
        style={{ width: 'var(--radix-popper-anchor-width)' }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false} className="rounded-xl">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={labels.search}
              data-testid="timezone-search"
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && visible.length > 0 && query) {
                  e.preventDefault();
                  choose(visible[0].id);
                }
              }}
            />
          </div>
          <CommandList className="max-h-72">
            <CommandEmpty>{labels.noResults}</CommandEmpty>
            {suggested.length > 0 && (
              <CommandGroup heading={labels.suggested}>{suggested.map((e) => renderItem(e, 's'))}</CommandGroup>
            )}
            {visible.length > 0 && (
              <CommandGroup heading={query ? undefined : labels.all}>{visible.map((e) => renderItem(e, 'a'))}</CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
