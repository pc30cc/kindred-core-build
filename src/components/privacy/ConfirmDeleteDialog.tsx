/**
 * Typed-confirmation dialog used for all privacy delete actions.
 * Caller passes the keyword (default: DELETE) and a callback.
 */
import { useState, useEffect } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/i18n';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: React.ReactNode;
  keyword?: string;
  busy?: boolean;
  onConfirm: () => void;
}

export function ConfirmDeleteDialog({
  open, onOpenChange, title, description, keyword = 'DELETE', busy, onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!open) setTyped(''); }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground space-y-3">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="confirm-keyword" className="text-xs">
            {t('privacy.confirm.typeToConfirm', { keyword })}
          </Label>
          <Input
            id="confirm-keyword"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={keyword}
            autoComplete="off"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={busy || typed !== keyword}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('privacy.confirm.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
