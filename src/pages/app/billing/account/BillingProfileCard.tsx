/**
 * The buyer's details printed on receipts. Iran asks for the economic code
 * and national id (official invoices); everywhere else for a VAT id and a
 * postal address.
 */
import { useState } from 'react';
import { Pencil, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { accountBillingApi } from '@/lib/accountBillingApi';
import type { BillingProfile, BillingProfileKey } from '../../../../../shared/simpleBilling';
import type { Edition } from '../../../../../shared/edition';
import { accountErrorText } from './accountUi';

const FIELDS: Record<Edition, readonly BillingProfileKey[]> = {
  iran: ['company', 'economic_code', 'national_id', 'address', 'postal_code', 'phone', 'invoice_email'],
  international: ['company', 'vat_id', 'address', 'city', 'postal_code', 'country', 'invoice_email'],
};

export default function BillingProfileCard({
  workspaceId,
  edition,
  profile,
  canManage,
  onSaved,
}: {
  workspaceId: string;
  edition: Edition;
  profile: BillingProfile;
  canManage: boolean;
  onSaved: (profile: BillingProfile) => void;
}) {
  const { t, dir } = useTranslation();
  const fields = FIELDS[edition];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BillingProfile>(profile);
  const [saving, setSaving] = useState(false);
  const label = (key: BillingProfileKey) => t(`billing.account.profile.fields.${key}` as TranslationKey);
  const filled = fields.filter((key) => profile[key]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await accountBillingApi.saveProfile(workspaceId, draft);
      onSaved(res.billing_profile);
      toast.success(t('billing.account.profile.saved'));
      setOpen(false);
    } catch (e) {
      toast.error(accountErrorText(e, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t('billing.account.profile.title')}</CardTitle>
          <CardDescription>{t('billing.account.profile.description')}</CardDescription>
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(profile);
              setOpen(true);
            }}
          >
            <Pencil className="me-2 h-4 w-4" aria-hidden />
            {t('billing.account.profile.edit')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {filled.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('billing.account.profile.empty')}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {filled.map((key) => (
              <div key={key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label(key)}</dt>
                <dd className="break-words">{profile[key]}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <DialogContent dir={dir} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('billing.account.profile.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((key) => (
              <div key={key} className={key === 'address' ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
                <Label htmlFor={`bp-${key}`}>{label(key)}</Label>
                <Input
                  id={`bp-${key}`}
                  value={draft[key] ?? ''}
                  maxLength={300}
                  dir={['economic_code', 'national_id', 'vat_id', 'postal_code', 'phone', 'invoice_email'].includes(key) ? 'ltr' : undefined}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  disabled={saving}
                />
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t('billing.account.profile.cancel')}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
              {t('billing.account.profile.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
