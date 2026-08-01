/**
 * Super-admin view of a user's phone verification.
 * Never renders the full number (backend returns a masked value only) and
 * never exposes which SMS provider is active.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { Loader2, Send, ShieldCheck, Smartphone } from 'lucide-react';
import {
  adminGetUserPhoneVerification,
  adminManualVerifyUserPhone,
  adminResendUserPhoneVerification,
} from '@/lib/api';

export function AdminPhoneVerificationCard({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-phone-verification', userId],
    queryFn: () => adminGetUserPhoneVerification(userId),
    enabled: !!userId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-phone-verification', userId] });
    qc.invalidateQueries({ queryKey: ['admin-user-detail', userId] });
    qc.invalidateQueries({ queryKey: ['admin-profiles'] });
    qc.invalidateQueries({ queryKey: ['admin-workspaces'] });
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

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          {t('admin.users.phoneVerification')}
        </h3>

        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {data && (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-mono text-muted-foreground" dir="ltr">
                {data.phoneMasked || '—'}
              </span>
              <Badge variant={data.verified ? 'default' : 'secondary'} className="text-xs">
                {data.verified ? t('phoneVerification.statusVerified') : t('phoneVerification.statusUnverified')}
              </Badge>
            </div>

            {data.verified && data.verificationMethod === 'admin_manual' && (
              <p className="text-xs text-muted-foreground">{t('phoneVerification.verifiedByAdmin')}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={!data.phone || data.verified || resend.isPending}
                onClick={() => resend.mutate()}
              >
                {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                <span className="ms-2">{t('admin.users.phoneResend')}</span>
              </Button>
            </div>

            {!data.verified && (
              <div className="space-y-2 pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground">{t('admin.users.phoneManualHint')}</p>
                <div className="flex gap-2">
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t('admin.users.phoneManualReason')}
                    maxLength={200}
                  />
                  <Button
                    size="sm"
                    disabled={!data.phone || reason.trim().length < 3 || manual.isPending}
                    onClick={() => manual.mutate()}
                  >
                    {manual.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    <span className="ms-2">{t('admin.users.phoneManualVerify')}</span>
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}