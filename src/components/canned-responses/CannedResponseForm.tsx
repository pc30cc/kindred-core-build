/**
 * Phase 6 — Create / edit form for a canned response.
 *
 * Rendered inside a Dialog. Server validates again; this is just UX.
 * Live preview uses sample interpolation data only (see SAMPLE_CONTEXT).
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  CANNED_VARIABLES,
  type CannedLocale,
  type CannedResponse,
} from '@/lib/canned-responses-api';
import { interpolate, SAMPLE_CONTEXT } from './interpolation';
import { cn } from '@/lib/utils';

const LOCALES: { value: CannedLocale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fa', label: 'فارسی' },
  { value: 'tr', label: 'Türkçe' },
];

const SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export interface CannedFormValues {
  locale: CannedLocale;
  shortcut: string;
  title: string;
  body: string;
  is_active: boolean;
}

interface Props {
  initial?: CannedResponse;
  defaultLocale: CannedLocale;
  submitLabel: string;
  submitting?: boolean;
  serverError?: string | null;
  onSubmit: (values: CannedFormValues) => void;
  onCancel: () => void;
}

export function CannedResponseForm({
  initial,
  defaultLocale,
  submitLabel,
  submitting,
  serverError,
  onSubmit,
  onCancel,
}: Props) {
  const [locale, setLocale] = useState<CannedLocale>(initial?.locale ?? defaultLocale);
  const [shortcut, setShortcut] = useState(initial?.shortcut ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setLocale(initial.locale);
    setShortcut(initial.shortcut);
    setTitle(initial.title);
    setBody(initial.body);
    setIsActive(initial.is_active);
  }, [initial]);

  const errors = useMemo(() => {
    const e: Partial<Record<keyof CannedFormValues, string>> = {};
    if (!SHORTCUT_RE.test(shortcut)) {
      e.shortcut = 'Lowercase letters, digits, _ or -. Must start with a letter or digit (max 41 chars).';
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1 || trimmedTitle.length > 120) e.title = 'Title is 1–120 chars.';
    const trimmedBody = body.trim();
    if (trimmedBody.length < 1 || trimmedBody.length > 4000) e.body = 'Body is 1–4000 chars.';
    return e;
  }, [shortcut, title, body]);

  const isValid = Object.keys(errors).length === 0;

  const preview = useMemo(() => interpolate(body, SAMPLE_CONTEXT), [body]);

  const insertVariable = (v: string) => {
    setBody((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}{{${v}}}`);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!isValid) return;
        onSubmit({ locale, shortcut: shortcut.trim(), title: title.trim(), body: body.trim(), is_active: isActive });
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cr-locale">Locale</Label>
          <Select value={locale} onValueChange={(v) => setLocale(v as CannedLocale)}>
            <SelectTrigger id="cr-locale"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LOCALES.map((l) => (
                <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cr-shortcut">Shortcut</Label>
          <Input
            id="cr-shortcut"
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value.toLowerCase())}
            placeholder="greeting"
            autoComplete="off"
          />
          {touched && errors.shortcut && (
            <p className="text-xs text-destructive">{errors.shortcut}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cr-title">Title</Label>
        <Input
          id="cr-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Initial greeting"
        />
        {touched && errors.title && (
          <p className="text-xs text-destructive">{errors.title}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="cr-body">Body</Label>
          <span className="text-xs text-muted-foreground">{body.length}/4000</span>
        </div>
        <Textarea
          id="cr-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Hi {{contact.name}}, welcome to {{workspace.name}}!"
          className="font-mono text-sm"
        />
        {touched && errors.body && (
          <p className="text-xs text-destructive">{errors.body}</p>
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {CANNED_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insertVariable(v)}
              className="text-[11px] px-2 py-0.5 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors font-mono"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">Preview (sample data)</Label>
        <div className={cn(
          'rounded-md border border-border/60 bg-muted/30 p-3 text-sm whitespace-pre-wrap min-h-[60px]',
          locale === 'fa' && 'text-end',
        )}
        dir={locale === 'fa' ? 'rtl' : 'ltr'}
        >
          {preview || <span className="text-muted-foreground italic">Preview appears here…</span>}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-border/40">
        <div className="flex items-center gap-2">
          <Switch id="cr-active" checked={isActive} onCheckedChange={setIsActive} />
          <Label htmlFor="cr-active" className="text-sm">Active</Label>
          {!isActive && <Badge variant="outline" className="text-[10px]">Hidden from picker</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitLabel}</Button>
        </div>
      </div>

      {serverError && (
        <p className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded p-2">
          {serverError}
        </p>
      )}
    </form>
  );
}
