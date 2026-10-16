/**
 * International phone number field: a searchable country picker (flag,
 * localized name, calling code) beside the national number.
 *
 * - Every country (src/lib/dialCountries.ts), names in the interface
 *   language from the browser's `Intl.DisplayNames`, flags from
 *   public/flags (loaded only when shown).
 * - Search by name (interface language or English), ISO code or calling
 *   code ("tur", "Türkiye", "ترکیه", "TR", "+90", "90").
 * - Opens on the detected country (src/lib/phoneCountryDefault.ts); the
 *   user's pick is remembered in this browser.
 * - Pasting a whole international number (+90… / 0090…) selects its country.
 * - The trunk 0 typed at home ("0530…") is dropped from the E.164 value.
 *
 * The parent owns `country` and `national`; the E.164 value is
 * `toE164(dialCountry(country), national)`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { PopoverContent } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  DIAL_COUNTRIES,
  countryOfInternationalNumber,
  dialCountry,
  flagUrl,
  nationalDigits,
} from '@/lib/dialCountries';
import { buildCountryEntries, filterCountryEntries, type CountryEntry as Entry } from '@/lib/countrySearch';
import { rememberPhoneCountry } from '@/lib/phoneCountryDefault';

export interface PhoneNumberFieldLabels {
  search: string;
  noResults: string;
  suggested: string;
  all: string;
  chooseCountry: string;
}

interface Props {
  country: string;
  national: string;
  onCountryChange: (code: string) => void;
  onNationalChange: (value: string) => void;
  onEnter?: () => void;
  /** Interface language: names and sorting follow it. */
  locale: string;
  labels: PhoneNumberFieldLabels;
  /** Shown first in the list (e.g. the detected country). */
  suggested?: readonly string[];
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}

function Flag({ code, className }: { code: string; className?: string }) {
  return (
    <img
      src={flagUrl(code)}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      width={20}
      height={14}
      className={cn('h-3.5 w-5 shrink-0 rounded-[2px] object-cover shadow-sm ring-1 ring-black/10', className)}
    />
  );
}

export function PhoneNumberField({
  country,
  national,
  onCountryChange,
  onNationalChange,
  onEnter,
  locale,
  labels,
  suggested = [],
  disabled,
  invalid,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const numberRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => buildCountryEntries(locale), [locale]);
  const selected = dialCountry(country) ?? DIAL_COUNTRIES[0];
  const selectedName = entries.find((e) => e.country.code === selected.code)?.name ?? selected.code;

  const visible = useMemo(() => filterCountryEntries(entries, query), [entries, query]);
  const suggestedEntries = useMemo(() => {
    if (query) return [];
    const codes = [...new Set([selected.code, ...suggested])];
    return codes.map((c) => entries.find((e) => e.country.code === c)).filter((e): e is Entry => Boolean(e));
  }, [entries, query, selected.code, suggested]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const choose = (code: string) => {
    onCountryChange(code);
    rememberPhoneCountry(code);
    setOpen(false);
    // Straight on to the number, like a native dialer.
    window.setTimeout(() => numberRef.current?.focus(), 0);
  };

  const handleNumber = (raw: string) => {
    const trimmed = raw.trim();
    // A whole international number pasted or typed: take its country.
    if (/^(\+|00)/.test(trimmed)) {
      const digits = nationalDigits(trimmed).replace(/^00/, '');
      const found = countryOfInternationalNumber(`+${digits}`, selected.code);
      if (found) {
        onCountryChange(found.code);
        onNationalChange(digits.slice(found.dial.length));
        return;
      }
    }
    onNationalChange(raw.replace(/[^\d\s\-()۰-۹٠-٩]/g, '').slice(0, 24));
  };

  const renderItem = (entry: Entry, keyPrefix: string) => (
    <CommandItem
      key={`${keyPrefix}-${entry.country.code}`}
      value={`${keyPrefix}-${entry.country.code}`}
      onSelect={() => choose(entry.country.code)}
      className="gap-2.5 py-2"
      data-testid={`phone-country-option-${entry.country.code}`}
    >
      <Flag code={entry.country.code} />
      <span className="flex-1 truncate">{entry.name}</span>
      <span className="font-mono text-xs text-muted-foreground" dir="ltr">+{entry.country.dial}</span>
      <Check className={cn('h-4 w-4 text-primary', entry.country.code === selected.code ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div
          dir="ltr"
          data-phone-field
          className={cn(
            'flex items-stretch overflow-hidden rounded-xl border bg-background shadow-sm transition-colors focus-within:ring-2',
            invalid
              ? 'border-destructive/60 focus-within:ring-destructive/20'
              : 'border-border focus-within:border-primary/60 focus-within:ring-primary/20',
          )}
        >
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={`${labels.chooseCountry}: ${selectedName} +${selected.dial}`}
              data-testid="phone-country-trigger"
              className="inline-flex items-center gap-2 border-r border-border bg-muted/50 px-3 text-sm transition-colors hover:bg-muted focus:outline-none focus-visible:bg-muted disabled:opacity-50"
            >
              <Flag code={selected.code} />
              <span className="font-mono text-muted-foreground">+{selected.dial}</span>
              <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </button>
          </PopoverPrimitive.Trigger>
          <Input
            ref={numberRef}
            id={id}
            value={national}
            onChange={(e) => handleNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
            placeholder={selected.example || undefined}
            inputMode="tel"
            autoComplete="tel-national"
            dir="ltr"
            aria-invalid={invalid || undefined}
            data-testid="phone-national-input"
            className="h-11 flex-1 border-0 bg-transparent font-mono tracking-wider shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            disabled={disabled}
          />
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="min-w-[18rem] max-w-[calc(100vw-2rem)] p-0"
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
              data-testid="phone-country-search"
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && visible.length > 0 && query) {
                  e.preventDefault();
                  choose(visible[0].country.code);
                }
              }}
            />
          </div>
          <CommandList className="max-h-72">
            <CommandEmpty>{labels.noResults}</CommandEmpty>
            {suggestedEntries.length > 0 && (
              <CommandGroup heading={labels.suggested}>
                {suggestedEntries.map((e) => renderItem(e, 's'))}
              </CommandGroup>
            )}
            {visible.length > 0 && (
              <CommandGroup heading={query ? undefined : labels.all}>
                {visible.map((e) => renderItem(e, 'a'))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
