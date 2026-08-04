// ============================================
// PROVIDER CONFIG FORM
// Renders structured forms from ProviderField schemas.
// Reusable for both admin and workspace provider pages.
// ============================================

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';
import type { ProviderVendor, ProviderField } from './schemas';

interface ProviderConfigFormProps {
  vendor: ProviderVendor;
  initialValues?: Record<string, string>;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  isPending?: boolean;
  submitLabel?: string;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ProviderField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.type === 'select' && field.options) {
    return (
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={`Select ${field.label}`} />
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
    return (
      <div className="flex items-center gap-2">
        <Switch checked={value === 'true'} onCheckedChange={(v) => onChange(v ? 'true' : 'false')} />
        <span className="text-sm text-muted-foreground">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
      </div>
    );
  }

  return (
    <Input
      type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
      placeholder={field.placeholder}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ProviderConfigForm({
  vendor,
  initialValues = {},
  onSubmit,
  onCancel,
  isPending,
  submitLabel = 'Save & Activate',
}: ProviderConfigFormProps) {
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (invalidCredential.length > 0) return;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    onSubmit(cleaned);
  };

  if (vendor.fields.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This provider requires no additional configuration.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onSubmit({})} disabled={isPending}>
            {isPending ? 'Saving...' : submitLabel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium text-sm text-foreground">{vendor.label}</span>
        <Badge variant="outline" className="text-[10px]">{vendor.name}</Badge>
        {vendor.docsUrl && (
          <a href={vendor.docsUrl} target="_blank" rel="noopener noreferrer"
            className="text-xs text-primary hover:underline flex items-center gap-1">
            Docs <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{vendor.description}</p>

      {vendor.fields.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            {field.label}
            {field.required && <span className="text-destructive">*</span>}
          </Label>
          <FieldInput
            field={field}
            value={values[field.key]}
            onChange={(v) => setValues((p) => ({ ...p, [field.key]: v }))}
          />
          {field.hint && (
            <p className="text-[11px] text-muted-foreground">{field.hint}</p>
          )}
          {invalidCredential.some((f) => f.key === field.key) && (
            <p className="text-[11px] text-destructive">
              مقدار واردشده ماسک‌شده یا دارای کاراکتر نامعتبر است — کلید/توکن کامل را از پنل درگاه کپی و اینجا وارد کنید.
            </p>
          )}
        </div>
      ))}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending || missingRequired.length > 0 || invalidCredential.length > 0}>
          {isPending ? 'Saving...' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
