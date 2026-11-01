import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { Zap } from 'lucide-react';
import { COUNT_RANGES, parseCount, type CountKey } from './personaForm';
import type { PersonaForm } from './usePersonaForm';

/** A section of the page: an icon chip, a title, one plain sentence. */
export function SectionCard({
  id, icon: Icon, tone, title, desc, children,
}: {
  id: string;
  icon: React.ElementType;
  /** The icon chip's colours (the AI pages' palette). */
  tone: string;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <Card data-persona-section={id} aria-labelledby={`persona-${id}-title`} role="region" className="overflow-hidden border-border/60">
      <CardHeader className="pb-4">
        <CardTitle id={`persona-${id}-title`} className="text-base flex items-center gap-2.5">
          <span className={cn('h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ring-1', tone)}>
            <Icon className="h-4 w-4" />
          </span>
          {title}
        </CardTitle>
        {desc && <CardDescription className="ps-[42px]">{desc}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}

/** A labelled block inside a section: title, the control, a short hint and an error. */
export function Field({
  label, htmlFor, hint, error, aside, children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  /** Beside the label, at the end (a counter, a helper button). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <p className="text-sm font-medium leading-none">{label}</p>}
        {aside}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  title: string;
  hint?: string;
}

/**
 * A short list of choices as cards. The radio's name is the title only (the
 * hint describes it), so a choice reads the same to a screen reader and a
 * test.
 */
export function ChoiceList<T extends string>({
  id, label, value, onChange, options, columns = 1, disabled,
}: {
  id: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Choice<T>[];
  columns?: 1 | 2 | 3;
  disabled?: boolean;
}) {
  const { dir } = useTranslation();
  return (
    <RadioGroup
      dir={dir}
      aria-label={label}
      value={value}
      onValueChange={(v) => onChange(v as T)}
      disabled={disabled}
      className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-3')}
    >
      {options.map((o) => {
        const itemId = `${id}-${o.value}`;
        return (
          <label
            key={o.value}
            htmlFor={itemId}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border border-border/50 px-3 py-2.5 transition-colors',
              'hover:border-primary/40 hover:bg-accent/30',
              'has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-primary/5',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <RadioGroupItem
              value={o.value}
              id={itemId}
              className="mt-0.5 shrink-0"
              aria-labelledby={`${itemId}-title`}
              aria-describedby={o.hint ? `${itemId}-hint` : undefined}
            />
            <span className="min-w-0">
              <span id={`${itemId}-title`} className="block text-sm font-medium leading-snug">{o.title}</span>
              {o.hint && <span id={`${itemId}-hint`} className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>}
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
}

/** A switch with its label (its accessible name) and an optional hint. */
export function SwitchRow({
  id, label, hint, checked, onChange, disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border/40 p-3 transition-colors hover:border-primary/30">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium leading-snug">{label}</Label>
        {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5"
      />
    </div>
  );
}

/**
 * A count field of the form. It keeps what is typed; leaving it puts a
 * number in range back (or the saved value when it is not a number).
 */
export function CountField({
  form, field, id, label, hint, disabled,
}: {
  form: PersonaForm;
  field: CountKey;
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [min, max] = COUNT_RANGES[field];
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className="w-28"
        value={form.values[field]}
        disabled={disabled}
        onChange={(e) => form.set(field, e.target.value)}
        onBlur={(e) => {
          const n = parseCount(e.target.value, field);
          if (n === null) form.reset(field);
          else if (String(n) !== e.target.value) form.set(field, String(n));
        }}
      />
    </Field>
  );
}

/** "Saved right away": for the few controls that do not wait for Save. */
export function InstantNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
