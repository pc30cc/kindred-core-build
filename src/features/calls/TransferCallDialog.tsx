/**
 * Call Center — operator call transfer.
 *
 * Hands a live call to another operator or to a department, using the
 * existing `POST /calls/:id/transfer` route. Gated on the platform
 * `call_transfer_enabled` flag: when the platform admin has turned transfer
 * off, the button is not rendered at all rather than failing at submit.
 *
 * The operator picking the target sees who can actually take the call —
 * presence status and current call count come from the same presence read
 * the wallboard uses, so a busy or offline agent is visibly marked.
 */
import { useMemo, useState } from 'react';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import {
  useCallCenterAgentPresence, useCallCenterDepartments, useTransferCall,
} from '@/hooks/useCallCenter';
import { useAuth } from '@/features/auth/AuthContext';
import type { CallCenterAgentPresence, CallCenterPresenceStatus } from '@/lib/call-center-api';
import { TONE_DOT, type Tone } from '@/features/calls/callCenterUi';

/** Presence → the module's shared status vocabulary. */
const PRESENCE_TONE: Record<CallCenterPresenceStatus | string, Tone> = {
  available: 'success',
  busy: 'primary',
  away: 'warning',
  offline: 'neutral',
};

function agentLabel(p: CallCenterAgentPresence): string {
  return p.full_name?.trim() || p.email?.trim() || p.user_id.slice(0, 8);
}

export function TransferCallDialog({
  workspaceId,
  callId,
  /** Platform-level `call_transfer_enabled`. Renders nothing when false. */
  enabled,
  variant = 'default',
  className,
}: {
  workspaceId: string | undefined;
  callId: string;
  enabled: boolean;
  variant?: 'default' | 'console';
  className?: string;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'agent' | 'department'>('agent');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data: presenceData } = useCallCenterAgentPresence(open ? workspaceId : undefined);
  const { data: departmentsData } = useCallCenterDepartments(open ? workspaceId : undefined);
  const transfer = useTransferCall(workspaceId);

  // Never offer the call back to the operator who is already handling it.
  const agents = useMemo(() => {
    const rows = (presenceData?.presence || []) as CallCenterAgentPresence[];
    return rows
      .filter((p) => p.user_id !== user?.id)
      .sort((a, b) => {
        const rank = (s: string) => (s === 'available' ? 0 : s === 'busy' ? 1 : s === 'away' ? 2 : 3);
        const d = rank(a.status) - rank(b.status);
        return d !== 0 ? d : agentLabel(a).localeCompare(agentLabel(b));
      });
  }, [presenceData, user?.id]);

  const departments = useMemo(
    () => (departmentsData?.departments || []).filter((d) => d.enabled),
    [departmentsData],
  );

  if (!enabled) return null;

  const target = tab === 'agent' ? agentId : departmentId;

  async function submit() {
    if (!workspaceId || !target) return;
    try {
      await transfer.mutateAsync({
        callId,
        payload: tab === 'agent'
          ? { to_agent_id: agentId, reason: reason.trim() || null }
          : { to_department_id: departmentId, reason: reason.trim() || null },
      });
      toast({
        title: t('callCenter.transfer.success'),
        description: t('callCenter.transfer.successDesc'),
      });
      setOpen(false);
      setAgentId(null);
      setDepartmentId(null);
      setReason('');
    } catch (e: unknown) {
      toast({
        title: t('callCenter.transfer.failed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={cn(
            // Inside the media console the button sits on the dark call
            // stage, so it borrows those tokens rather than the page's.
            variant === 'console'
              && 'bg-call-stage-muted text-call-stage-foreground hover:bg-call-stage-muted/80',
            className,
          )}
          title={t('callCenter.transfer.title')}
        >
          <ArrowRightLeft className="h-4 w-4" />
          <span className="ms-1.5">{t('callCenter.transfer.button')}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('callCenter.transfer.title')}</DialogTitle>
          <DialogDescription>{t('callCenter.transfer.description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'agent' | 'department')}>
          <TabsList className="grid grid-cols-2">
            <TabsTrigger value="agent">{t('callCenter.transfer.targetAgent')}</TabsTrigger>
            <TabsTrigger value="department">{t('callCenter.transfer.targetDepartment')}</TabsTrigger>
          </TabsList>

          <TabsContent value="agent" className="mt-3">
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {t('callCenter.transfer.noAgents')}
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto space-y-1 pe-1">
                {agents.map((a) => (
                  <button
                    key={a.user_id}
                    type="button"
                    onClick={() => setAgentId(a.user_id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 rounded-md border px-3 py-2 text-start transition-colors',
                      agentId === a.user_id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[PRESENCE_TONE[a.status] || 'neutral'])} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{agentLabel(a)}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {t(`callCenter.overview.presence.${a.status === 'busy' ? 'onCallBusy' : a.status}` as never)}
                        {a.active_call_count > 0 && ` · ${a.active_call_count}`}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="department" className="mt-3">
            {departments.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {t('callCenter.transfer.noDepartments')}
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto space-y-1 pe-1">
                {departments.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDepartmentId(d.id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 rounded-md border px-3 py-2 text-start transition-colors',
                      departmentId === d.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-sm shrink-0"
                      style={{ background: d.color || 'hsl(var(--primary))' }}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{d.name}</span>
                      {d.description && (
                        <span className="block text-[11px] text-muted-foreground truncate">{d.description}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <div className="space-y-1.5">
          <Label htmlFor="transfer-reason" className="text-xs">{t('callCenter.transfer.reason')}</Label>
          <Input
            id="transfer-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={t('callCenter.transfer.reasonPlaceholder')}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('callCenter.common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!target || transfer.isPending}>
            {transfer.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />}
            {transfer.isPending ? t('callCenter.transfer.transferring') : t('callCenter.transfer.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TransferCallDialog;
