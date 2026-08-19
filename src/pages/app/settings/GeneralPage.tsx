import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useBranding, useUpdateBranding } from '@/hooks/useBranding';
import { API_BASE } from '@/lib/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ImagePlus, Mail, Phone, MessageCircle, Send, Twitter,
  MessageSquare, Instagram, CheckCircle2, Loader2, Trash2, HelpCircle,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import {
  uploadWorkspaceIcon,
  removeWorkspaceIcon,
} from '@/lib/account-api';
import { cn } from '@/lib/utils';

type ContactInfo = {
  phone?: string;
  messenger?: string;
  telegram?: string;
  twitter?: string;
  whatsapp?: string;
  instagram?: string;
};

/**
 * Workspace information — Crisp-style editor.
 *
 * Source of truth:
 *  - Icon, support email, contact channels  → `workspace_branding`
 *  - Workspace name                          → `workspaces.name`
 *  - Domain (display)                        → primary `workspace_domains.domain`
 *
 * All inline edits autosave on blur. The "Automatically Saved" badge
 * flashes whenever a save settles successfully.
 */
export default function SettingsGeneralPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const { data: branding } = useBranding(workspace?.id);
  const updateBranding = useUpdateBranding(workspace?.id);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [savedFlash, setSavedFlash] = useState(0);

  // Pull primary domain (display only — managed in Domains page).
  const { data: primaryDomain } = useQuery({
    queryKey: ['workspace-primary-domain', 'full', workspace?.id],
    enabled: !!workspace,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/workspaces/${workspace!.id}/primary-domain`, { credentials: 'include' });
      if (!res.ok) return null;
      return res.json() as Promise<{ domain: string | null; is_primary: boolean | null; verified: boolean | null }>;
    },
  });

  const updateName = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`${API_BASE}/api/workspaces/${workspace!.id}`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      flashSaved();
    },
    onError: (e: any) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const flashSaved = () => setSavedFlash(Date.now());

  const saveBranding = (patch: Record<string, unknown>) => {
    updateBranding.mutate(patch as any, {
      onSuccess: () => flashSaved(),
      onError: (e: any) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
    });
  };

  const contactInfo: ContactInfo = useMemo(() => {
    return ((branding as any)?.contact_info || {}) as ContactInfo;
  }, [branding]);

  const saveContact = (key: keyof ContactInfo, value: string) => {
    const next = { ...contactInfo, [key]: value || undefined };
    // Strip empties so the JSON stays compact
    Object.keys(next).forEach(k => {
      if (!next[k as keyof ContactInfo]) delete next[k as keyof ContactInfo];
    });
    saveBranding({ contact_info: next });
  };

  const handleIconUpload = async (file: File) => {
    if (!workspace) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid file', description: 'Please select an image.', variant: 'destructive' });
      return;
    }
    setUploading(true);
    try {
      const res = await uploadWorkspaceIcon(workspace.id, file);
      qc.invalidateQueries({ queryKey: ['branding', workspace.id] });
      qc.invalidateQueries({ queryKey: ['platform-branding'] });
      flashSaved();
      toast({ title: t('workspaceInfo.iconUpdated') });
      return res;
    } catch (e: any) {
      toast({ title: 'Upload failed', description: e.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const handleIconRemove = async () => {
    if (!workspace) return;
    setUploading(true);
    try {
      await removeWorkspaceIcon(workspace.id);
      qc.invalidateQueries({ queryKey: ['branding', workspace.id] });
      flashSaved();
    } catch (e: any) {
      toast({ title: 'Remove failed', description: e.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  if (!workspace) {
    return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;
  }

  const iconUrl = branding?.logo_url || null;
  const supportEmail = branding?.support_email || '';
  const showSavedFlash = Date.now() - savedFlash < 2000;

  return (
    <div className="space-y-10 animate-fade-in pb-12">
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-foreground">{t('workspaceInfo.title')}</h1>
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
        </div>
        <Badge
          variant="outline"
          className={cn(
            'gap-1.5 transition-opacity',
            showSavedFlash ? 'opacity-100 border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'opacity-60',
          )}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span className="text-xs">{t('workspaceInfo.autoSaved')}</span>
        </Badge>
      </header>
      <p className="-mt-6 text-sm text-muted-foreground max-w-2xl">
        {t('workspaceInfo.subtitle')}
      </p>

      {/* General information */}
      <section className="space-y-6">
        <h2 className="text-base font-semibold text-foreground">{t('workspaceInfo.general')}</h2>

        {/* Icon */}
        <div className="flex items-start gap-6">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className={cn(
              'group relative h-20 w-20 rounded-full overflow-hidden border-2 border-dashed border-border',
              'flex items-center justify-center bg-muted/30 hover:bg-muted/60 transition-colors',
              uploading && 'opacity-60 cursor-wait',
            )}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImagePlus className="h-6 w-6 text-muted-foreground" />
            )}
            {uploading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </button>
          <div className="flex-1 space-y-2">
            <div className="text-sm font-medium text-foreground">{t('workspaceInfo.icon')}</div>
            <div className="text-xs text-muted-foreground">{t('workspaceInfo.iconHint')}</div>
            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {t('workspaceInfo.uploadImage')}
              </Button>
              {iconUrl && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleIconRemove}
                  disabled={uploading}
                  className="text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5 me-1" />
                  {t('common.delete')}
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleIconUpload(file);
              }}
            />
          </div>
        </div>

        {/* Domain & Name */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground">
              {t('workspaceInfo.domain')} <span className="text-destructive">*</span>
            </Label>
            <Input
              key={`dom-${workspace.id}-${primaryDomain?.domain ?? ''}`}
              value={primaryDomain?.domain || ''}
              placeholder={primaryDomain?.domain || '—'}
              readOnly
              className="bg-muted/30 cursor-not-allowed"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground">
              {t('workspaceInfo.name')} <span className="text-destructive">*</span>
            </Label>
            <Input
              defaultValue={workspace.name}
              key={workspace.id + workspace.name}
              onBlur={e => {
                const v = e.target.value.trim();
                if (v && v !== workspace.name) updateName.mutate(v);
              }}
            />
          </div>
        </div>
      </section>

      <hr className="border-border/60" />

      {/* Contact information */}
      <section className="space-y-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('workspaceInfo.contact')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('workspaceInfo.contactSubtitle')}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <ContactField
            icon={<Mail className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.email')}
            placeholder="support@acme.com"
            defaultValue={supportEmail}
            onSave={v => saveBranding({ support_email: v || null })}
            type="email"
          />
          <ContactField
            icon={<Phone className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.phone')}
            placeholder="+1 (628) 123-4567"
            defaultValue={contactInfo.phone}
            onSave={v => saveContact('phone', v)}
            type="tel"
          />
          <ContactField
            icon={<MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.messenger')}
            placeholder={t('workspaceInfo.messengerPlaceholder')}
            defaultValue={contactInfo.messenger}
            onSave={v => saveContact('messenger', v)}
          />
          <ContactField
            icon={<Send className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.telegram')}
            placeholder={t('workspaceInfo.telegramPlaceholder')}
            defaultValue={contactInfo.telegram}
            onSave={v => saveContact('telegram', v)}
          />
          <ContactField
            icon={<Twitter className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.twitter')}
            placeholder={t('workspaceInfo.twitterPlaceholder')}
            defaultValue={contactInfo.twitter}
            onSave={v => saveContact('twitter', v)}
          />
          <ContactField
            icon={<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.whatsapp')}
            placeholder="+16281234567"
            defaultValue={contactInfo.whatsapp}
            onSave={v => saveContact('whatsapp', v)}
            type="tel"
          />
          <ContactField
            icon={<Instagram className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t('workspaceInfo.instagram')}
            placeholder={t('workspaceInfo.instagramPlaceholder')}
            defaultValue={contactInfo.instagram}
            onSave={v => saveContact('instagram', v)}
          />
        </div>
      </section>
    </div>
  );
}

/* ── Inline contact field with autosave on blur ─────────────── */
function ContactField({
  icon,
  label,
  defaultValue,
  placeholder,
  onSave,
  type = 'text',
}: {
  icon: React.ReactNode;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  onSave: (value: string) => void;
  type?: string;
}) {
  const [value, setValue] = useState(defaultValue || '');
  // Sync external changes (e.g., another tab) without clobbering edits.
  useEffect(() => {
    setValue(defaultValue || '');
  }, [defaultValue]);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-foreground">{label}</Label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center">
          {icon}
        </span>
        <Input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={e => setValue(e.target.value)}
          onBlur={() => {
            const v = value.trim();
            if (v !== (defaultValue || '').trim()) onSave(v);
          }}
          className="ps-9"
        />
      </div>
    </div>
  );
}
