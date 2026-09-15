// ============================================
// PROVIDER CONFIG FORM
// Renders structured forms from ProviderField schemas.
// Reusable for both admin and workspace provider pages.
// ============================================

import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Eye, EyeOff, ShieldCheck, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import type { ProviderVendor, ProviderField } from './schemas';

interface ProviderConfigFormProps {
  vendor: ProviderVendor;
  initialValues?: Record<string, string>;
  onSubmit: (values: Record<string, string>) => void;
  onCancel?: () => void;
  isPending?: boolean;
  submitLabel?: string;
  /** Lay fields out in a responsive two-column grid (admin panels). */
  dense?: boolean;
  /** Hide the vendor title row — use when the host panel already shows it. */
  hideVendorHeader?: boolean;
  /** Extra controls rendered on the opposite side of the footer actions. */
  extraActions?: React.ReactNode;
}

function FieldInput({
  field,
  value,
  onChange,
  invalid,
}: {
  field: ProviderField;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);

  if (field.type === 'select' && field.options) {
    return (
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className={cn(invalid && 'border-destructive')}>
          <SelectValue placeholder={field.placeholder ?? field.label} />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.type === 'toggle') {
    const on = value === 'true';
    return (
      <div className="flex h-10 items-center gap-2.5 rounded-md border border-border bg-muted/20 px-3">
        <Switch checked={on} onCheckedChange={(v) => onChange(v ? 'true' : 'false')} />
        <span className={cn('text-xs', on ? 'text-foreground' : 'text-muted-foreground')}>
          {on ? t('adminProviders.form.enabled') : t('adminProviders.form.disabled')}
        </span>
      </div>
    );
  }

  if (field.type === 'password') {
    return (
      <div className="relative">
        <Input
          type={revealed ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          placeholder={field.placeholder}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn('pe-9 font-mono text-xs', invalid && 'border-destructive')}
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? t('adminProviders.form.hide') : t('adminProviders.form.show')}
          className="absolute top-1/2 -translate-y-1/2 end-2 text-muted-foreground hover:text-foreground"
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    );
  }

  return (
    <Input
      type={field.type === 'number' ? 'number' : 'text'}
      dir={field.type === 'url' ? 'ltr' : undefined}
      placeholder={field.placeholder}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className={cn(invalid && 'border-destructive')}
    />
  );
}

export function ProviderConfigForm({
  vendor,
  initialValues = {},
  onSubmit,
  onCancel,
  isPending,
  submitLabel,
  dense,
  hideVendorHeader,
  extraActions,
}: ProviderConfigFormProps) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of vendor.fields) {
      init[f.key] = initialValues[f.key] ?? '';
    }
    return init;
  });

  const missingRequired = vendor.fields.filter(
    (f) => f.required && !values[f.key]?.trim()
  );

  // Credentials travel in HTTP headers: a masked placeholder ("••••") or any
  // non-ASCII char (RTL/zero-width paste artifacts) makes the gateway reject
  // the request with "invalid credentials" — block it at the source.
  const isCredentialField = (f: ProviderField) =>
    f.type === 'password' ||
    /token|key|secret|password|merchant/i.test(f.key);

  const invalidCredential = vendor.fields.filter((f) => {
    const v = values[f.key]?.trim();
    if (!v) return false;
    if (/[•●∙·*]{2,}/.test(v)) return true;
    return isCredentialField(f) && !/^[\x21-\x7E]+$/.test(v);
  });

  // Fields keep their declared order inside each group; groupless fields come first.
  const groups = useMemo(() => {
    const ordered: { name: string | null; fields: ProviderField[] }[] = [];
    for (const field of vendor.fields) {
      const name = field.group ?? null;
      const bucket = ordered.find((g) => g.name === name);
      if (bucket) bucket.fields.push(field);
      else ordered.push({ name, fields: [field] });
    }
    return ordered;
  }, [vendor.fields]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (invalidCredential.length > 0) return;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    onSubmit(cleaned);
  };

  const vendorHeader = hideVendorHeader ? null : (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm text-foreground">{vendor.label}</span>
        <Badge variant="outline" className="text-[10px] font-mono">{vendor.name}</Badge>
        {vendor.docsUrl && (
          <a
            href={vendor.docsUrl} target="_blank" rel="noopener noreferrer"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            {t('adminProviders.form.docs')} <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{vendor.description}</p>
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <div className="flex items-center gap-2">{extraActions}</div>
      <div className="flex items-center gap-2 ms-auto">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('adminProviders.form.cancel')}
          </Button>
        )}
        <Button
          type="submit"
          disabled={isPending || missingRequired.length > 0 || invalidCredential.length > 0}
        >
          {isPending ? t('adminProviders.form.saving') : (submitLabel ?? t('adminProviders.form.save'))}
        </Button>
      </div>
    </div>
  );

  if (vendor.fields.length === 0) {
    return (
      <form onSubmit={handleSubmit} className="space-y-4">
        {vendorHeader}
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('adminProviders.form.noFields')}
          </p>
        </div>
        {footer}
      </form>
    );
  }

  const hasSecrets = vendor.fields.some(isCredentialField);

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {vendorHeader}

      {groups.map((group) => (
        <div key={group.name ?? '_'} className="space-y-3">
          {group.name && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.name}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <div className={cn('grid gap-4', dense && 'sm:grid-cols-2')}>
            {group.fields.map((field) => {
              const invalid = invalidCredential.some((f) => f.key === field.key);
              const isWide = field.type === 'url' || /json|connection_string/.test(field.key);
              return (
                <div
                  key={field.key}
                  className={cn('space-y-1.5', dense && isWide && 'sm:col-span-2')}
                >
                  <Label className="flex items-center gap-1.5 text-xs">
                    {field.label}
                    {field.required ? (
                      <span className="text-destructive">*</span>
                    ) : (
                      <span className="text-[10px] font-normal text-muted-foreground/70">
                        {t('adminProviders.form.optional')}
                      </span>
                    )}
                  </Label>
                  <FieldInput
                    field={field}
                    value={values[field.key]}
                    onChange={(v) => setValues((p) => ({ ...p, [field.key]: v }))}
                    invalid={invalid}
                  />
                  {field.hint && !invalid && (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{field.hint}</p>
                  )}
                  {invalid && (
                    <p className="flex items-start gap-1 text-[11px] text-destructive">
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                      {t('adminProviders.form.maskedValue')}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {hasSecrets && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3 w-3 text-emerald-400" />
          {t('adminProviders.form.secretsNote')}
        </p>
      )}

      {missingRequired.length > 0 && (
        <p className="text-[11px] text-amber-400">
          {t('adminProviders.form.missingRequired', { count: missingRequired.length })}
        </p>
      )}

      {footer}
    </form>
  );
}
