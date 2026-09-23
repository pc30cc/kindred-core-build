/**
 * Shared field primitives for the Super Admin settings surfaces.
 *
 * Every visible string is passed IN by the caller (already translated), so
 * these files contain no copy of their own and the localization tests stay
 * meaningful. The shapes are deliberately small: a label, an optional hint,
 * and the control — the same rhythm as the rest of Super Admin.
 */
import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function SettingsSection({
  icon: Icon,
  heading,
  caption,
  action,
  children,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  heading: string;
  caption?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            {Icon && <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
            <div>
              <CardTitle className="text-base">{heading}</CardTitle>
              {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
            </div>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return (
    <div
      className={cn(
        'grid gap-5',
        cols === 1 ? 'grid-cols-1' : cols === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
      )}
    >
      {children}
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  invalid,
  type = 'text',
  disabled,
  dir,
  maxLength,
  onBlur,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  type?: string;
  disabled?: boolean;
  dir?: 'ltr' | 'rtl';
  maxLength?: number;
  onBlur?: () => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        dir={dir}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
        className={cn(invalid && 'border-destructive focus-visible:ring-destructive')}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  value,
  onChange,
  rows = 3,
  placeholder,
  counter,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  /** Live "n / max" counter — Apple truncates long purpose strings. */
  counter?: number;
  maxLength?: number;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {counter !== undefined && (
          <span
            className={cn(
              'text-[11px] tabular-nums',
              value.length > counter ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
          >
            {value.length} / {counter}
          </span>
        )}
      </div>
      <Textarea rows={rows} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border/70 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function SelectField({
  label,
  hint,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A short, copyable technical value (bundle id, command, generated JSON). */
export function CodeBlock({ value, label }: { value: string; label?: string }) {
  return (
    <div className="grid gap-1.5">
      {label && <Label>{label}</Label>}
      <pre
        dir="ltr"
        className="max-h-80 overflow-auto rounded-xl bg-muted/60 p-3 text-start text-[11.5px] leading-relaxed text-foreground"
      >
        <code>{value}</code>
      </pre>
    </div>
  );
}

/** A multi-value editor for string arrays (associated domains, SDK names). */
export function ListField({
  label,
  hint,
  values,
  onChange,
  placeholder,
  addLabel,
  removeLabel,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel: string;
  removeLabel: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="space-y-2">
        {values.map((entry, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              dir="ltr"
              value={entry}
              placeholder={placeholder}
              onChange={(e) => {
                const next = [...values];
                next[index] = e.target.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              aria-label={removeLabel}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
              className="shrink-0 rounded-lg border border-border/70 px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...values, ''])}
          className="rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          {addLabel}
        </button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
