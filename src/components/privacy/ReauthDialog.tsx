/**
 * Re-auth prompt for high-impact privacy actions.
 * Calls /api/privacy/reauth and returns the issued token to the parent.
 */
import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldAlert } from 'lucide-react';
import { reauthWithPassword } from '@/lib/privacy-api';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirmed: (token: string) => void;
  description?: string;
}

export function ReauthDialog({ open, onOpenChange, onConfirmed, description }: Props) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    try {
      const { token } = await reauthWithPassword(password);
      onConfirmed(token);
      setPassword('');
      onOpenChange(false);
    } catch (e: any) {
      toast({
        title: t('privacy.reauth.failedTitle'),
        description: e?.message || t('privacy.reauth.failedDescription'),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-warning" />
            {t('privacy.reauth.title')}
          </DialogTitle>
          <DialogDescription>{description || t('privacy.reauth.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reauth-password">{t('auth.password')}</Label>
          <Input
            id="reauth-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy || !password}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('privacy.reauth.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
