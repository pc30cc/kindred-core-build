/**
 * Phase 9 polish — InviteWaitDialog.
 *
 * Small accessible dialog the operator sees BEFORE an invitation is
 * created. They pick how long they're willing to wait for the visitor
 * to accept (2–10 minutes, default 5).
 *
 * The selected value is converted to seconds and forwarded to the
 * existing invitation API as `ttl_seconds`. The server clamps the value
 * to [60, 600], so the UI is safe even if a future option list changes.
 *
 * Reused for both audio and video — the channel only changes the
 * dialog's heading and the icon. No business logic lives here.
 */
import { useEffect, useState } from 'react';
import { Phone, Video, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { InvitationChannel } from '@/lib/call-invitations-api';

/** Allowed wait windows in minutes. Mirror the spec exactly. */
export const WAIT_OPTIONS_MINUTES: ReadonlyArray<number> = [2, 3, 4, 5, 6, 7, 8, 9, 10];
export const DEFAULT_WAIT_MINUTES = 5;

interface InviteWaitDialogProps {
  open: boolean;
  channel: InvitationChannel;
  /** True while the parent is creating the invitation after confirm. */
  submitting?: boolean;
  onCancel(): void;
  /** Receives wait time in seconds (= minutes * 60). */
  onConfirm(seconds: number): void;
}

export function InviteWaitDialog({
  open,
  channel,
  submitting = false,
  onCancel,
  onConfirm,
}: InviteWaitDialogProps) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState<number>(DEFAULT_WAIT_MINUTES);

  // Reset selection each time the dialog opens so it never carries over
  // a stale value across invitations.
  useEffect(() => {
    if (open) setMinutes(DEFAULT_WAIT_MINUTES);
  }, [open]);

  const Icon = channel === 'video' ? Video : Phone;
  const accent =
    channel === 'video'
      ? 'text-violet-600 dark:text-violet-400'
      : 'text-warning';
  const title =
    channel === 'video'
      ? t('callInvite.dialogTitleVideo') || 'Invite to video call'
      : t('callInvite.dialogTitleAudio') || 'Invite to audio call';
  const description =
    t('callInvite.dialogDescription') ||
    'How long should we wait for the visitor to join?';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn('h-4 w-4', accent)} aria-hidden="true" />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={String(minutes)}
          onValueChange={(v) => setMinutes(parseInt(v, 10))}
          className="grid grid-cols-3 gap-2"
          aria-label={t('callInvite.dialogRadioLabel') || 'Wait time in minutes'}
        >
          {WAIT_OPTIONS_MINUTES.map((m) => {
            const id = `wait-${m}`;
            const selected = m === minutes;
            return (
              <div key={m} className="relative">
                <RadioGroupItem id={id} value={String(m)} className="sr-only peer" />
                <Label
                  htmlFor={id}
                  className={cn(
                    'flex flex-col items-center justify-center rounded-md border bg-background px-3 py-2 text-sm cursor-pointer',
                    'transition-colors hover:bg-accent',
                    'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
                    selected && (channel === 'video'
                      ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                      : 'border-warning bg-warning/10 text-warning'),
                  )}
                >
                  <span className="text-base font-semibold tabular-nums">{m}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t('callInvite.minutesUnit') || 'min'}
                  </span>
                </Label>
              </div>
            );
          })}
        </RadioGroup>

        <p className="text-xs text-muted-foreground">
          {(t('callInvite.dialogHelp') ||
            'The invitation will expire automatically if the visitor does not join in time.')}
        </p>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            {t('common.cancel') || 'Cancel'}
          </Button>
          <Button
            onClick={() => onConfirm(minutes * 60)}
            disabled={submitting}
            className={cn(
              channel === 'video'
                ? 'bg-violet-600 text-white hover:bg-violet-700'
                : 'bg-warning text-warning-foreground hover:bg-warning/90',
            )}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {channel === 'video'
              ? t('callInvite.dialogConfirmVideo') || 'Send video invite'
              : t('callInvite.dialogConfirmAudio') || 'Send audio invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}