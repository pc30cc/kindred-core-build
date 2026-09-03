/**
 * Account information settings — Crisp-inspired layout, modern Lovable polish.
 *
 * Architecture:
 *   - Reads the merged auth+profile via GET /api/account/me (self-hosted)
 *   - Writes via PATCH /api/account/me (full_name / first/last / preferred_locale / phone)
 *   - Avatar upload routes through POST /api/account/avatar which uses the
 *     active storage provider for the user's primary workspace; the file is
 *     persisted under `avatars/<userId>/...` on whichever provider is active
 *     (BunnyCDN, S3, Cloudflare R2, MinIO, local, etc.). No vendor lock-in.
 *   - Password change uses POST /api/account/change-password which re-verifies
 *     the current password before updating via the admin API.
 *   - Email verification banner reuses the existing self-hosted
 *     /api/auth-email/resend-verification flow.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchAccountMe,
  updateAccount,
  uploadAccountAvatar,
  removeAccountAvatar,
  changeAccountPassword,
} from '@/lib/account-api';
import { resendMyVerificationEmail, ResendVerificationError } from '@/lib/api';
import { AccountPhoneField } from '@/features/phone-verification/AccountPhoneField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Trash2,
  UserRound,
} from 'lucide-react';

function splitName(full: string | null | undefined): { first: string; last: string } {
  if (!full) return { first: '', last: '' };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function getInitials(name: string | null | undefined, email: string | null | undefined): string {
  const source = (name || email || '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SUPPORTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export default function SettingsProfilePage() {
  const { t } = useTranslation();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const { platformName } = useBrandingContext();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: me, isLoading } = useQuery({
    queryKey: ['account', 'me'],
    queryFn: fetchAccountMe,
  });

  // Local form state — initialized from server, autosaved on blur/change.
  const initial = useMemo(() => {
    const split = splitName(me?.profile?.full_name ?? null);
    return {
      first_name: split.first,
      last_name: split.last,
      phone: me?.phone ?? '',
      preferred_locale: me?.profile?.preferred_locale ?? 'en',
    };
  }, [me]);

  const [firstName, setFirstName] = useState(initial.first_name);
  const [lastName, setLastName] = useState(initial.last_name);
  const [phone, setPhone] = useState(initial.phone);
  const [locale, setLocale] = useState(initial.preferred_locale);

  useEffect(() => {
    setFirstName(initial.first_name);
    setLastName(initial.last_name);
    setPhone(initial.phone);
    setLocale(initial.preferred_locale);
  }, [initial.first_name, initial.last_name, initial.phone, initial.preferred_locale]);

  const update = useMutation({
    mutationFn: updateAccount,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account', 'me'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (err: any) => {
      toast({ title: t('account.saveError'), description: err?.message, variant: 'destructive' });
    },
  });

  // Avatar upload
  const uploadAvatar = useMutation({
    mutationFn: uploadAccountAvatar,
    onSuccess: (res) => {
      // Optimistic, immediate UI update — patch the cached account so the new
      // avatar shows in this page AND in the sidebar instantly, before the
      // background refetch settles. Append a cache-busting query so the
      // browser does not serve the stale CDN response.
      const bustedUrl = res?.url ? `${res.url}${res.url.includes('?') ? '&' : '?'}v=${Date.now()}` : null;
      qc.setQueryData<typeof me>(['account', 'me'], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          profile: prev.profile
            ? { ...prev.profile, avatar_url: bustedUrl ?? prev.profile.avatar_url }
            : prev.profile,
        };
      });
      qc.setQueriesData<any>({ queryKey: ['profile'] }, (prev: any) => {
        if (!prev) return prev;
        return { ...prev, avatar_url: bustedUrl ?? prev.avatar_url };
      });
      qc.invalidateQueries({ queryKey: ['account', 'me'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      toast({ title: t('account.avatarUpdated') });
    },
    onError: (err: any) => {
      toast({ title: t('account.uploadFailed'), description: err?.message, variant: 'destructive' });
    },
  });

  const removeAvatar = useMutation({
    mutationFn: removeAccountAvatar,
    onSuccess: () => {
      qc.setQueryData<typeof me>(['account', 'me'], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          profile: prev.profile ? { ...prev.profile, avatar_url: null } : prev.profile,
        };
      });
      qc.setQueriesData<any>({ queryKey: ['profile'] }, (prev: any) => {
        if (!prev) return prev;
        return { ...prev, avatar_url: null };
      });
      qc.invalidateQueries({ queryKey: ['account', 'me'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      toast({ title: t('account.avatarRemoved') });
    },
  });

  const onPickAvatar = () => fileInputRef.current?.click();

  const onAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!SUPPORTED_AVATAR_TYPES.includes(file.type)) {
      toast({ title: t('account.invalidImageType'), variant: 'destructive' });
      return;
    }
    uploadAvatar.mutate(file);
  };

  // Save handlers
  const saveName = () => {
    if (firstName === initial.first_name && lastName === initial.last_name) return;
    update.mutate({ first_name: firstName, last_name: lastName });
  };
  const savePhone = () => {
    if (phone === initial.phone) return;
    update.mutate({ phone: phone || null });
  };
  const onLocaleChange = (v: string) => {
    setLocale(v);
    update.mutate({ preferred_locale: v });
  };

  // Email verification
  const [verifySending, setVerifySending] = useState(false);
  const onResendVerification = async () => {
    if (!me?.email) return;
    setVerifySending(true);
    try {
      const result = await resendMyVerificationEmail(locale || 'en');
      if (result.already_verified) {
        toast({ title: t('auth.emailAlreadyVerified') });
      } else {
        toast({
          title: t('account.verificationSent'),
          description: t('auth.resendCheckInbox').replace('{email}', result.email || me.email),
        });
      }
    } catch (err: any) {
      const description =
        err instanceof ResendVerificationError && err.code === 'too_many_requests'
          ? t('auth.resendCooldownSeconds').replace('{seconds}', String(err.retryAfterSeconds || 60))
          : t('auth.resendFailed');
      toast({ title: t('account.uploadFailed'), description, variant: 'destructive' });
    } finally {
      setVerifySending(false);
    }
  };

  const [pwOpen, setPwOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-border/60 bg-card p-5">
          <div className="flex items-center gap-4">
            <SkeletonAvatar size={72} />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
        </div>
        <SkeletonForm fields={4} />
        <SkeletonCard lines={3} />
      </div>
    );
  }

  const fullName = me?.profile?.full_name ?? '';
  const avatarUrl = me?.profile?.avatar_url || '';
  const isVerified = !!me?.email_confirmed_at;
  const saving = update.isPending || uploadAvatar.isPending || removeAvatar.isPending;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('account.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('account.subtitle', { brand: platformName })}
          </p>
        </div>
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
            saving
              ? 'border-border bg-muted text-muted-foreground'
              : 'border-border bg-card text-foreground'
          )}
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('account.saving')}
            </>
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('account.autoSaved')}
            </>
          )}
        </div>
      </div>

      {/* Verification banner */}
      {!isVerified && me?.email && (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/50 p-4 text-sm text-foreground shadow-sm">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="flex-1">
            <span>{t('account.unverifiedBanner')} </span>
            <button
              type="button"
              onClick={onResendVerification}
              disabled={verifySending}
              className="font-semibold text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-60"
            >
              {verifySending ? t('account.saving') : t('account.sendEmailNow')}
            </button>
          </div>
        </div>
      )}

      {/* Avatar */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('account.avatar')}</h2>
        </div>
        <div className="grid gap-6 p-6 md:grid-cols-[auto_1fr]">
          <div className="relative">
            <Avatar className="h-24 w-24 ring-1 ring-border/60">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={fullName || me?.email || ''} /> : null}
              <AvatarFallback className="bg-gradient-to-br from-primary/15 to-primary/5 text-lg font-semibold text-primary">
                {getInitials(fullName, me?.email)}
              </AvatarFallback>
            </Avatar>
            <button
              type="button"
              onClick={onPickAvatar}
              disabled={uploadAvatar.isPending}
              className="absolute -bottom-1 -end-1 inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background shadow-md ring-2 ring-background transition-colors hover:bg-accent disabled:opacity-50"
              aria-label={t('account.uploadImage')}
            >
              {uploadAvatar.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Camera className="h-4 w-4" />
              )}
            </button>
          </div>

          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm text-foreground">{t('account.avatarHelper')}</p>
              <p className="text-xs text-muted-foreground">{t('account.avatarVisible')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onPickAvatar} disabled={uploadAvatar.isPending} size="sm">
                {uploadAvatar.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {avatarUrl ? t('account.replaceImage') : t('account.uploadImage')}
              </Button>
              {avatarUrl && (
                <Button
                  onClick={() => removeAvatar.mutate()}
                  disabled={removeAvatar.isPending}
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('account.removeImage')}
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={SUPPORTED_AVATAR_TYPES.join(',')}
              className="hidden"
              onChange={onAvatarChange}
            />
          </div>
        </div>
      </Card>

      {/* Personal details */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('account.personalDetails')}</h2>
        </div>
        <div className="grid gap-6 p-6 md:grid-cols-2">
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="firstName" className="text-xs font-medium text-muted-foreground">
              {t('account.firstName')} *
            </Label>
            <Input
              id="firstName"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              onBlur={saveName}
            />
            <p className="text-xs text-muted-foreground">{t('account.firstNameHelper')}</p>
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="lastName" className="text-xs font-medium text-muted-foreground">
              {t('account.lastName')} *
            </Label>
            <Input
              id="lastName"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              onBlur={saveName}
            />
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">
              {t('account.email')} *
            </Label>
            <Input id="email" value={me?.email ?? ''} disabled />
            <p className="text-xs text-muted-foreground">{t('account.emailHelper')}</p>
          </div>
          <div className="md:col-span-1">
            <AccountPhoneField
              fallback={
                <div className="space-y-2">
                  <Label htmlFor="phone" className="text-xs font-medium text-muted-foreground">
                    {t('account.phone')}
                  </Label>
                  <Input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onBlur={savePhone}
                    placeholder={t('account.phonePlaceholder')}
                  />
                  <p className="text-xs text-muted-foreground">{t('account.phoneHelper')}</p>
                </div>
              }
            />
          </div>
        </div>
      </Card>

      {/* Security */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('account.security')}</h2>
        </div>
        <div className="divide-y divide-border/60">
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('account.password')}</p>
            </div>
            <Button onClick={() => setPwOpen(true)} size="sm">
              {t('account.changePassword')}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4 px-6 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('account.twoStep')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {phone ? t('account.twoStepComingSoon') : t('account.twoStepRequiresPhone')}
              </p>
            </div>
            <Button disabled variant="secondary" size="sm" className="opacity-70">
              <ShieldAlert className="me-2 h-4 w-4" />
              {t('account.enable2fa')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Preferences — hidden entirely on a single-language platform, where
          there is nothing to pick between (see Settings → Interface, which
          governs this same preferred_locale field and applies the same
          canSwitchLanguage gate). */}
      {canSwitchLanguage && (
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('account.preferences')}</h2>
        </div>
        <div className="grid gap-6 p-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              {t('account.preferredLanguage')}
            </Label>
            <Select value={locale ?? 'en'} onValueChange={onLocaleChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowedLocales.map((loc) => (
                  <SelectItem key={loc} value={loc}>
                    {loc === 'fa' ? 'فارسی' : loc === 'tr' ? 'Türkçe' : 'English'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('account.preferredLanguageHelper')}</p>
          </div>
        </div>
      </Card>
      )}

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  );
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  };

  const m = useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      changeAccountPassword(current, next),
    onSuccess: () => {
      toast({ title: t('account.passwordChanged') });
      reset();
      onOpenChange(false);
    },
    onError: (err: any) => {
      const msg = err?.message || '';
      if (msg.toLowerCase().includes('current password')) {
        setError(t('account.passwordCurrentWrong'));
      } else {
        setError(msg || t('account.saveError'));
      }
    },
  });

  const submit = () => {
    setError(null);
    if (next.length < 8) return setError(t('account.passwordMinError'));
    if (next !== confirm) return setError(t('account.passwordMismatch'));
    m.mutate({ current, next });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('account.changePassword')}</DialogTitle>
          <DialogDescription>{t('account.passwordMinError')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('account.currentPassword')}</Label>
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('account.newPassword')}</Label>
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('account.confirmPassword')}</Label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={m.isPending}>
            {t('account.cancel')}
          </Button>
          <Button onClick={submit} disabled={m.isPending || !current || !next || !confirm}>
            {m.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('account.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}