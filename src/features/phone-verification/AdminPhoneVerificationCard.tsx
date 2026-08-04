/**
 * Super-admin view of a user's phone verification.
 * The full number is admin-only and appears nowhere else (lists, owner UI,
 * logs). The active SMS provider is never exposed.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { ExternalLink, Loader2, Pencil, Send, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import {
  adminGetUserPhoneVerification,
  adminManualVerifyUserPhone,
  adminResendUserPhoneVerification,
  adminRemoveUserPhone,
  adminSetUserPhone,
} from '@/lib/api';
import { PHONE_STATUS_CLASS, PHONE_STATUS_LABEL_KEY, resolvePhoneStatus } from './status';
import { PHONE_COUNTRIES, countryFromE164, defaultPhoneCountry, phoneCountryLabel } from '@/lib/phone-countries';

const REASON_MIN = 5;
const REASON_MAX = 500;

function formatMoment(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export interface AdminPhoneVerificationCardProps {
  userId: string;
  /** Workspace detail renders the current owner's status read-only. */
  readOnly?: boolean;
  title?: string;
  note?: string;
  /** Deep link target for "Open owner in Users". */
  ownerLink?: boolean;
}

export function AdminPhoneVerificationCard({
  userId,
  readOnly = false,
  title,
  note,
  ownerLink = false,
}: AdminPhoneVerificationCardProps) {
  const { t, locale: uiLocale } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<'resend' | 'manual' | null>(null);
  const [editing, setEditing] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [countryDraft, setCountryDraft] = useState(defaultPhoneCountry(uiLocale));

  const { data, isLoading } = useQuery({
    queryKey: ['admin-phone-verification', userId],
    queryFn: () => adminGetUserPhoneVerification(userId),
    enabled: !!userId,
  });

  const invalidate = () => {
    for (const key of [
      ['admin-phone-verification', userId],
      ['admin-user-detail', userId],
      ['admin-profiles'],
      ['admin-profile-count'],
      ['admin-workspaces'],
      ['admin-workspace-count'],
      ['admin-workspace-detail'],
      ['admin-audit-logs'],
      ['phone-verification-status'],
    ]) {
      qc.invalidateQueries({ queryKey: key });
    }
  };

  const resend = useMutation({
    mutationFn: () => adminResendUserPhoneVerification(userId),
    onSuccess: () => { toast({ title: t('phoneVerification.codeSent') }); invalidate(); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const manual = useMutation({
    mutationFn: () => adminManualVerifyUserPhone(userId, reason.trim()),
    onSuccess: () => { toast({ title: t('phoneVerification.verifiedTitle') }); setReason(''); invalidate(); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const savePhone = useMutation({
    mutationFn: () => adminSetUserPhone(userId, phoneDraft.trim(), countryDraft),
    onSuccess: () => { toast({ title: t('admin.users.phoneSaved') }); setEditing(false); invalidate(); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const removePhone = useMutation({
    mutationFn: () => adminRemoveUserPhone(userId),
    onSuccess: () => { toast({ title: t('admin.users.phoneRemoved') }); invalidate(); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const reasonLength = reason.trim().length;
  const reasonValid = reasonLength >= REASON_MIN && reasonLength <= REASON_MAX;
  const status = data ? resolvePhoneStatus({ phoneMasked: data.phoneMasked, verified: data.verified }) : null;
  const locale = uiLocale === 'fa' ? 'fa-IR' : uiLocale === 'tr' ? 'tr-TR' : 'en-US';
  const verifiedAt = formatMoment(data?.verifiedAt, locale);
  const lastSentAt = formatMoment(data?.lastSentAt, locale);

  const rows: Array<{ label: string; value: string }> = [];
  // Admin-only: the full number is shown here and nowhere else.
  if (data?.phone) rows.push({ label: t('admin.users.phoneFull'), value: data.phone });
  if (data?.country) rows.push({ label: t('admin.users.phoneCountry'), value: data.country });
  if (data?.verified) {
    if (verifiedAt) rows.push({ label: t('admin.users.phoneVerifiedAt'), value: verifiedAt });
    rows.push({
      label: t('admin.users.phoneMethod'),
      value:
        data.verificationMethod === 'admin_manual'
          ? t('admin.users.phoneMethodManual')
          : t('admin.users.phoneMethodSms'),
    });
    if (data.verifiedByAdminEmail) {
      rows.push({ label: t('admin.users.phoneVerifiedBy'), value: data.verifiedByAdminEmail });
    }
    if (data.verifiedByAdminId) {
      rows.push({ label: t('admin.users.phoneVerifiedById'), value: data.verifiedByAdminId });
    }
    if (data.manualVerificationReason) {
      rows.push({
        label: t('admin.users.phoneManualReasonLabel'),
        value: data.manualVerificationReason,
      });
    }
  } else if (lastSentAt) {
    rows.push({ label: t('admin.users.phoneLastSent'), value: lastSentAt });
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          {title ?? t('admin.users.phoneVerification')}
        </h3>

        {note && <p className="text-xs text-muted-foreground">{note}</p>}

        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {data && (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-mono text-muted-foreground" dir="ltr">
                {data.phoneMasked || '—'}
              </span>
              {status && (
                <Badge variant="outline" className={`text-xs ${PHONE_STATUS_CLASS[status]}`}>
                  {t(PHONE_STATUS_LABEL_KEY[status] as never)}
                </Badge>
              )}
            </div>

            {data.verified && data.verificationMethod === 'admin_manual' && (
              <p className="text-xs text-muted-foreground">{t('phoneVerification.verifiedByAdmin')}</p>
            )}

            {!data.phone && <p className="text-xs text-muted-foreground">{t('admin.users.phoneNoRecord')}</p>}

            {rows.length > 0 && (
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                {rows.map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="break-words">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {!data.verified && !data.hasActiveChallenge && (
              <p className="text-xs text-muted-foreground">{t('admin.users.phoneNoActiveChallenge')}</p>
            )}

            {!data.verified && data.hasActiveChallenge && (
              <p className="text-xs text-warning">
                {t('admin.users.phoneActiveChallenge').replace(
                  '{{seconds}}',
                  String(data.challengeExpiresInSeconds ?? 0),
                )}
                {typeof data.remainingAttempts === 'number' && (
                  <span className="ms-2 text-muted-foreground">
                    {t('admin.users.phoneAttemptsLeft').replace('{{count}}', String(data.remainingAttempts))}
                  </span>
                )}
              </p>
            )}

            {ownerLink && (
              <Button asChild size="sm" variant="outline">
                <Link to={`/admin/users?user=${userId}`}>
                  <ExternalLink className="h-4 w-4" />
                  <span className="ms-2">{t('admin.users.openOwnerInUsers')}</span>
                </Link>
              </Button>
            )}

            {!readOnly && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={!data.phone || data.verified || resend.isPending}
                onClick={() => setConfirming('resend')}
              >
                {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                <span className="ms-2">{t('admin.users.phoneResend')}</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPhoneDraft(data.phone || '');
                  setCountryDraft(countryFromE164(data.phone) ?? data.country ?? defaultPhoneCountry(uiLocale));
                  setEditing((v) => !v);
                }}
              >
                <Pencil className="h-4 w-4" />
                <span className="ms-2">{data.phone ? t('admin.users.phoneEdit') : t('admin.users.phoneAdd')}</span>
              </Button>
              {data.phone && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={removePhone.isPending}
                  onClick={() => removePhone.mutate()}
                >
                  {removePhone.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  <span className="ms-2">{t('admin.users.phoneRemove')}</span>
                </Button>
              )}
            </div>
            )}

            {!readOnly && editing && (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">{t('admin.users.phoneEditHint')}</p>
                <div className="flex flex-wrap gap-2">
                  <Select value={countryDraft} onValueChange={setCountryDraft}>
                    <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PHONE_COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>{phoneCountryLabel(c.code, uiLocale)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={phoneDraft}
                    onChange={(e) => setPhoneDraft(e.target.value)}
                    placeholder={countryDraft === 'IR' ? '09121234567' : '5xxxxxxxxx'}
                    dir="ltr"
                    className="font-mono flex-1 min-w-[160px]"
                  />
                  <Button size="sm" disabled={phoneDraft.trim().length < 6 || savePhone.isPending} onClick={() => savePhone.mutate()}>
                    {savePhone.isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
                    {t('admin.users.phoneSave')}
                  </Button>
                </div>
              </div>
            )}

            {!readOnly && !data.verified && (
              <div className="space-y-2 pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground">{t('admin.users.phoneManualHint')}</p>
                <div className="flex gap-2">
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t('admin.users.phoneManualReason')}
                    maxLength={REASON_MAX}
                  />
                  <Button
                    size="sm"
                    disabled={!data.phone || !reasonValid || manual.isPending}
                    onClick={() => setConfirming('manual')}
                  >
                    {manual.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    <span className="ms-2">{t('admin.users.phoneManualVerify')}</span>
                  </Button>
                </div>
                {reasonLength > 0 && !reasonValid && (
                  <p className="text-xs text-destructive">{t('admin.users.phoneReasonTooShort')}</p>
                )}
              </div>
            )}
          </>
        )}

        <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirming === 'manual'
                  ? t('admin.users.phoneManualConfirmTitle')
                  : t('admin.users.phoneResendConfirmTitle')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirming === 'manual'
                  ? t('admin.users.phoneManualConfirmBody')
                  : t('admin.users.phoneResendConfirmBody')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('admin.users.phoneCancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const action = confirming;
                  setConfirming(null);
                  if (action === 'manual' && reasonValid) manual.mutate();
                  if (action === 'resend') resend.mutate();
                }}
              >
                {t('admin.users.phoneConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}