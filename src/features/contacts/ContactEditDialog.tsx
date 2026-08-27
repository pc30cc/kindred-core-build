import { useEffect, useState } from 'react';
import { Building2, Loader2, Mail, Phone, Save, StickyNote, Tag, User as UserIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import type { Contact } from '@/types/models';

export type ContactEditValues = {
  name: string;
  company: string;
  email: string;
  phone: string;
  tags: string[];
  notes: string;
};

function FieldShell({
  icon: Icon, label, hint, children,
}: { icon: any; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ContactEditDialog({
  open, onOpenChange, contact, saving, onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact: Contact | null | undefined;
  saving?: boolean;
  onSave: (values: ContactEditValues) => void | Promise<void>;
}) {
  const { t, dir } = useI18n();
  const [values, setValues] = useState<ContactEditValues>({
    name: '', company: '', email: '', phone: '', tags: [], notes: '',
  });
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    if (!open || !contact) return;
    const meta = (contact.metadata ?? {}) as Record<string, unknown>;
    setValues({
      name: contact.name ?? '',
      company: String(meta.company ?? meta.org ?? meta.organization ?? ''),
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      tags: contact.tags ?? [],
      notes: (contact as any).notes ?? '',
    });
    setTagDraft('');
  }, [open, contact]);

  const set = <K extends keyof ContactEditValues>(k: K, v: ContactEditValues[K]) =>
    setValues((p) => ({ ...p, [k]: v }));

  const commitTags = (raw: string) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setValues((p) => ({ ...p, tags: Array.from(new Set([...p.tags, ...parts])).slice(0, 64) }));
    setTagDraft('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir={dir} className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border text-start">
          <DialogTitle className="text-start text-base">{t('contacts.editTitle')}</DialogTitle>
          <DialogDescription className="text-start">{t('contacts.editDesc')}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[65vh]" dir={dir}>
          <div className="px-6 py-5 space-y-6">
            <section className="space-y-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
                {t('contacts.editSectionIdentity')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FieldShell icon={UserIcon} label={t('contacts.name')}>
                  <Input value={values.name} onChange={(e) => set('name', e.target.value)} />
                </FieldShell>
                <FieldShell icon={Building2} label={t('contacts.company')}>
                  <Input
                    value={values.company}
                    onChange={(e) => set('company', e.target.value)}
                    placeholder={t('contacts.companyPlaceholder')}
                  />
                </FieldShell>
                <FieldShell icon={Mail} label={t('contacts.email')}>
                  <Input type="email" dir="ltr" value={values.email} onChange={(e) => set('email', e.target.value)} />
                </FieldShell>
                <FieldShell icon={Phone} label={t('contacts.phone')}>
                  <Input dir="ltr" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
                </FieldShell>
              </div>
            </section>

            <section className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
                {t('contacts.tags')}
              </p>
              <FieldShell icon={Tag} label={t('contacts.tags')} hint={t('contacts.tagsHint')}>
                <Input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      commitTags(tagDraft);
                    }
                  }}
                  onBlur={() => commitTags(tagDraft)}
                  placeholder={t('contacts.tagsPlaceholder')}
                />
              </FieldShell>
              {values.tags.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {values.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 text-[11px]">
                      {tag}
                      <button
                        type="button"
                        className="opacity-60 hover:opacity-100"
                        onClick={() => set('tags', values.tags.filter((x) => x !== tag))}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t('contacts.noTags')}</p>
              )}
            </section>

            <section className="space-y-3">
              <FieldShell icon={StickyNote} label={t('contacts.notes')}>
                <Textarea rows={6} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
              </FieldShell>
            </section>
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 border-t border-border gap-2 sm:justify-start">
          <Button
            onClick={() => onSave({ ...values, tags: values.tags })}
            disabled={saving}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {t('contacts.save')}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('contacts.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
