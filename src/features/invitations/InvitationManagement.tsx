/**
 * WORKSPACE INVITATIONS v5.1 — the ONE shared invitation-management surface.
 *
 * Reused by:
 *   • Staff Access            → mode="staff"            (no departments)
 *   • Team & Departments      → mode="customer_facing"  (departments required)
 *
 * There is intentionally no third invitation UI: `/app/w/:slug/team` only
 * redirects to the canonical surfaces.
 *
 * Guarantees:
 *   • owner/admin only (enforced here AND by the API)
 *   • every string comes from the existing i18n namespaces (en / fa / tr)
 *   • API errors are language-neutral codes mapped to localized text
 *   • token hashes, OTP digests, proofs and credentials are never rendered
 *   • the raw manual link is shown exactly once, right after create/rotate
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Mail, MessageSquare, MoreHorizontal, RefreshCw, Link2, Ban,
  Trash2, Pencil, UserPlus, Copy, ChevronDown, ChevronUp, ShieldAlert,
} from 'lucide-react';

import { useTranslation, type TranslationKey } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { toast } from '@/lib/toast';
import { API_BASE } from '@/lib/apiBase';
import { useRequestIdBook } from '@/features/invitations/requestIds';
import { invitationErrorKey } from '@/features/invitations/errors';
import { listDepartments } from '@/lib/workspace-departments-api';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/* ─────────────────────────── types & constants ─────────────────────────── */

export type InvitationMode = 'staff' | 'customer_facing';

export const STAFF_INVITE_ROLES = [
  'admin', 'marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer',
] as const;

export const CUSTOMER_FACING_INVITE_ROLES = ['agent', 'team_lead'] as const;

/** `owner` is never invitable — ownership transfer is a separate flow. */
export const NON_INVITABLE_ROLES = ['owner'] as const;

interface InvitationRow {
  id: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired' | string;
  role: string;
  member_type: string;
  first_name: string | null;
  last_name: string | null;
  invited_email_normalized: string | null;
  invited_phone_e164: string | null;
  job_title: string | null;
  staff_code: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_reason: string | null;
  archived_at: string | null;
  notification_generation: number | null;
}

interface DeliveryRow {
  id: string;
  channel: 'email' | 'sms' | string;
  status: string;
  attempt_number: number | null;
  provider_name: string | null;
  error_code: string | null;
  safe_error_message: string | null;
  created_at: string;
}

/* ─────────────────────────────── helpers ───────────────────────────────── */

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String((body as any)?.error || 'INTERNAL_ERROR')) as Error & { fields?: string[] };
    const fields = (body as any)?.fields;
    if (Array.isArray(fields) && fields.length) err.fields = fields.map(String);
    throw err;
  }

  return body as T;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  return `${phone.slice(0, 4)}${'•'.repeat(Math.max(3, phone.length - 7))}${phone.slice(-3)}`;
}

/** Clipboard write with a REAL success check — never a blind optimistic toast. */
export async function copyWithVerification(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    if (typeof clipboard.readText === 'function') {
      const roundTrip = await clipboard.readText().catch(() => null);
      // A blocked read returns null: treat only a *mismatching* read as failure.
      if (typeof roundTrip === 'string' && roundTrip !== text) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ──────────────────────────── main component ───────────────────────────── */

export function InvitationManagement({
  workspaceId, mode,
}: {
  workspaceId: string;
  mode: InvitationMode;
}) {
  const { t, locale } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const requestIds = useRequestIdBook();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<InvitationRow | null>(null);
  const [revoking, setRevoking] = useState<InvitationRow | null>(null);
  const [archiving, setArchiving] = useState<InvitationRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);

  const { data: members = [] } = useQuery({
    queryKey: ['ws-members', workspaceId],
    queryFn: async () => {
      const { members: rows } = await api<{ members: any[] }>(`/api/workspace-members?workspaceId=${workspaceId}`);
      return rows;
    },
    enabled: !!workspaceId,
  });

  const myRole = useMemo(
    () => members.find((m: any) => m.user_id === user?.id)?.role as string | undefined,
    [members, user?.id],
  );
  const canManage = myRole === 'owner' || myRole === 'admin';

  const { data: invitations = [], isLoading, isError } = useQuery({
    queryKey: ['ws-invitations', workspaceId],
    queryFn: async () => {
      const { invitations: rows } = await api<{ invitations: InvitationRow[] }>(
        `/api/workspace-invitations?workspaceId=${workspaceId}`,
      );
      return rows;
    },
    enabled: !!workspaceId && canManage,
  });

  const scoped = useMemo(
    () => invitations.filter((inv) => inv.member_type === mode),
    [invitations, mode],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ws-invitations', workspaceId] });
  const fail = (e: unknown) => toast.error(t(invitationErrorKey(e)));

  const resend = useMutation({
    mutationFn: async (inv: InvitationRow) => {
      const key = `resend:${inv.id}:${inv.notification_generation ?? 0}`;
      await api(`/api/workspace-invitations/${inv.id}/resend`, {
        method: 'POST',
        body: JSON.stringify({ requestId: requestIds.get(key) }),
      });
      requestIds.reset(key);
    },
    onSuccess: () => { toast.success(t('invitations.toastResent')); invalidate(); },
    onError: fail,
  });

  const rotate = useMutation({
    mutationFn: async (inv: InvitationRow) => {
      const key = `rotate:${inv.id}`;
      const out = await api<{ manualLink: string }>(`/api/workspace-invitations/${inv.id}/rotate-link`, {
        method: 'POST',
        body: JSON.stringify({ requestId: requestIds.get(key) }),
      });
      requestIds.reset(key);
      return out.manualLink;
    },
    onSuccess: async (manualLink) => {
      setOneTimeLink(manualLink);
      toast.success(t('invitations.toastRotated'));
      invalidate();
    },
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: async ({ inv, reason }: { inv: InvitationRow; reason: string }) => {
      const key = `revoke:${inv.id}`;
      await api(`/api/workspace-invitations/${inv.id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason, requestId: requestIds.get(key) }),
      });
      requestIds.reset(key);
    },
    onSuccess: () => { toast.success(t('invitations.toastRevoked')); setRevoking(null); invalidate(); },
    onError: fail,
  });

  // Permanent deletion: archiving used to leave tokens/jobs/OTPs behind, which
  // then collided with a fresh invitation to the same person.
  const archive = useMutation({
    mutationFn: async (inv: InvitationRow) => {
      const key = `delete:${inv.id}`;
      await api(`/api/workspace-invitations/${inv.id}`, { method: 'DELETE' });
      requestIds.reset(key);
    },
    onSuccess: () => { toast.success(t('invitations.toastDeleted')); setArchiving(null); invalidate(); },
    onError: fail,
  });


  const copyLink = async (link: string) => {
    const ok = await copyWithVerification(link);
    if (ok) toast.success(t('invitations.toastLinkCopied'));
    else toast.error(t('invitations.toastCopyFailed'));
  };

  if (!canManage) {
    return (
      <Card className="border-border/60 p-6" data-testid="invitations-forbidden">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">{t('invitations.forbiddenTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('invitations.forbiddenBody')}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden border-border/60" data-testid="invitation-management">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('invitations.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {mode === 'staff' ? t('invitations.subtitleStaff') : t('invitations.subtitleCustomer')}
          </p>
        </div>
        <Button
          size="sm"
          data-testid="invitation-create-button"
          onClick={() => { setEditing(null); setShowForm(true); }}
        >
          <UserPlus className="me-2 h-4 w-4" />
          {mode === 'staff' ? t('invitations.createStaff') : t('invitations.createCustomer')}
        </Button>
      </div>

      {isLoading ? (
        <div className="p-8 text-center" role="status" aria-label={t('invitations.loading')}>
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <p className="p-8 text-center text-sm text-destructive">{t('invitations.errors.INTERNAL_ERROR')}</p>
      ) : scoped.length === 0 ? (
        <div className="py-12 text-center" data-testid="invitations-empty">
          <Mail className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">{t('invitations.emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{t('invitations.emptyHint')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60" data-testid="invitation-list">
          {scoped.map((inv) => (
            <li key={inv.id} className="px-4 py-3" data-testid="invitation-row" data-status={inv.status}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {[inv.first_name, inv.last_name].filter(Boolean).join(' ') || '—'}
                    </span>
                    <StatusBadge status={inv.status} archived={!!inv.archived_at} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground" dir="ltr">
                    {maskEmail(inv.invited_email_normalized)} · {maskPhone(inv.invited_phone_e164)}
                  </p>
                </div>

                <div className="hidden text-end text-xs text-muted-foreground sm:block">
                  <Badge variant="outline" className="text-[10px]">
                    {t(`invitations.roles.${inv.role}` as TranslationKey)}
                  </Badge>
                  <div className="mt-1">
                    {t(inv.member_type === 'staff'
                      ? 'invitations.memberTypeStaff'
                      : 'invitations.memberTypeCustomer')}
                  </div>
                </div>

                <div className="hidden text-xs text-muted-foreground md:block">
                  {inv.expires_at
                    ? `${t('invitations.expiresAt')}: ${new Date(inv.expires_at).toLocaleDateString(locale)}`
                    : t('invitations.noExpiry')}
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t('invitations.a11yToggleDetails')}
                  data-testid="invitation-details-toggle"
                  onClick={() => setExpanded(expanded === inv.id ? null : inv.id)}
                >
                  {expanded === inv.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      data-testid="invitation-actions"
                      aria-label={t('invitations.a11yActions')}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={inv.status !== 'pending'}
                      onClick={() => { setEditing(inv); setShowForm(true); }}
                    >
                      <Pencil className="me-2 h-3.5 w-3.5" />{t('invitations.actionEdit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={inv.status !== 'pending' || resend.isPending}
                      data-testid="invitation-resend"
                      onClick={() => resend.mutate(inv)}
                    >
                      <RefreshCw className="me-2 h-3.5 w-3.5" />{t('invitations.actionResend')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={inv.status !== 'pending' || rotate.isPending}
                      data-testid="invitation-rotate"
                      onClick={() => rotate.mutate(inv)}
                    >
                      <Link2 className="me-2 h-3.5 w-3.5" />{t('invitations.actionRotate')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={inv.status !== 'pending'}
                      data-testid="invitation-revoke"
                      onClick={() => setRevoking(inv)}
                    >
                      <Ban className="me-2 h-3.5 w-3.5" />{t('invitations.actionRevoke')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      data-testid="invitation-archive"
                      onClick={() => setArchiving(inv)}
                    >
                      <Trash2 className="me-2 h-3.5 w-3.5" />{t('invitations.actionDelete')}
                    </DropdownMenuItem>

                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {expanded === inv.id && (
                <InvitationDetail invitationId={inv.id} invitation={inv} />
              )}
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <InvitationFormDialog
          workspaceId={workspaceId}
          mode={mode}
          invitation={editing}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onCreated={(link) => { setOneTimeLink(link); invalidate(); }}
          onEdited={() => invalidate()}
        />
      )}

      {revoking && (
        <RevokeDialog
          invitation={revoking}
          pending={revoke.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={(reason) => revoke.mutate({ inv: revoking, reason })}
        />
      )}

      {archiving && (
        <Dialog open onOpenChange={(o) => !o && setArchiving(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('invitations.deleteTitle')}</DialogTitle>
              <DialogDescription>{t('invitations.deleteBody')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setArchiving(null)}>{t('invitations.cancel')}</Button>
              <Button
                variant="destructive"
                data-testid="invitation-archive-confirm"
                disabled={archive.isPending}
                onClick={() => archive.mutate(archiving)}
              >
                {archive.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('invitations.deleteConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {oneTimeLink && (
        <Dialog open onOpenChange={(o) => !o && setOneTimeLink(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('invitations.linkTitle')}</DialogTitle>
              <DialogDescription>{t('invitations.linkBody')}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input readOnly value={oneTimeLink} dir="ltr" className="text-xs" data-testid="invitation-manual-link" />
              <Button
                size="icon"
                variant="outline"
                aria-label={t('invitations.actionCopyLink')}
                data-testid="invitation-copy-link"
                onClick={() => copyLink(oneTimeLink)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => setOneTimeLink(null)}>{t('invitations.close')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

/* ────────────────────────────── sub-views ──────────────────────────────── */

function StatusBadge({ status, archived }: { status: string; archived: boolean }) {
  const { t } = useTranslation();
  const key = archived ? 'archived' : status;
  const tone: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    accepted: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    revoked: 'bg-destructive/10 text-destructive border-destructive/20',
    expired: 'bg-muted text-muted-foreground border-border',
    archived: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <Badge className={`border text-[10px] ${tone[key] || tone.expired}`} data-testid="invitation-status">
      {t(`invitations.status.${key}` as TranslationKey)}
    </Badge>
  );
}

function InvitationDetail({ invitationId, invitation }: { invitationId: string; invitation: InvitationRow }) {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['ws-invitation-detail', invitationId],
    queryFn: () => api<{ invitation: any; deliveries: DeliveryRow[]; departmentIds: string[] }>(
      `/api/workspace-invitations/${invitationId}`,
    ),
  });

  if (isLoading) {
    return (
      <div className="mt-3 rounded-md border border-border/60 p-3 text-xs text-muted-foreground">
        {t('invitations.loading')}
      </div>
    );
  }

  const deliveries = data?.deliveries ?? [];
  const latest = (channel: string) => deliveries.find((d) => d.channel === channel);
  const email = latest('email');
  const sms = latest('sms');
  const failures = deliveries.filter((d) => d.status === 'failed');

  return (
    <div className="mt-3 grid gap-3 rounded-md border border-border/60 bg-muted/20 p-3 text-xs sm:grid-cols-2"
         data-testid="invitation-detail">
      <DetailRow label={t('invitations.fieldEmail')} value={maskEmail(invitation.invited_email_normalized)} ltr />
      <DetailRow label={t('invitations.fieldPhone')} value={maskPhone(invitation.invited_phone_e164)} ltr />
      <DetailRow
        label={t('invitations.fieldRole')}
        value={t(`invitations.roles.${invitation.role}` as TranslationKey)}
      />
      <DetailRow
        label={t('invitations.fieldMemberType')}
        value={t(invitation.member_type === 'staff'
          ? 'invitations.memberTypeStaff'
          : 'invitations.memberTypeCustomer')}
      />
      <DetailRow
        label={t('invitations.fieldDepartments')}
        value={(data?.departmentIds?.length ?? 0) > 0
          ? t('invitations.departmentCount', { count: String(data?.departmentIds.length ?? 0) })
          : t('invitations.noDepartments')}
      />
      <DetailRow
        label={t('invitations.fieldExpiry')}
        value={invitation.expires_at
          ? new Date(invitation.expires_at).toLocaleString(locale)
          : t('invitations.noExpiry')}
      />
      <DetailRow
        label={t('invitations.fieldEmailStatus')}
        icon={<Mail className="h-3 w-3" />}
        value={t(`invitations.delivery.${email?.status || 'none'}` as TranslationKey)}
      />
      <DetailRow
        label={t('invitations.fieldSmsStatus')}
        icon={<MessageSquare className="h-3 w-3" />}
        value={t(`invitations.delivery.${sms?.status || 'none'}` as TranslationKey)}
      />
      {invitation.job_title ? (
        <DetailRow label={t('invitations.fieldJobTitle')} value={invitation.job_title} />
      ) : null}
      {invitation.staff_code ? (
        <DetailRow label={t('invitations.fieldStaffCode')} value={invitation.staff_code} />
      ) : null}
      {invitation.revoked_reason ? (
        <DetailRow label={t('invitations.fieldRevokeReason')} value={invitation.revoked_reason} />
      ) : null}
      {failures.length > 0 && (
        <div className="sm:col-span-2" data-testid="invitation-delivery-failures">
          <p className="font-medium text-destructive">{t('invitations.deliveryFailures')}</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {failures.map((f) => (
              <li key={f.id}>
                {t(`invitations.channel.${f.channel}` as TranslationKey)} ·{' '}
                {t(`invitations.deliveryError.${f.error_code || 'UNKNOWN'}` as TranslationKey)}
                {f.attempt_number ? ` · ${t('invitations.attempt', { n: String(f.attempt_number) })}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">{t('invitations.deliveryFailureHint')}</p>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, icon, ltr }: {
  label: string; value: string; icon?: React.ReactNode; ltr?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-muted-foreground">{icon}{label}</span>
      <span className="truncate text-foreground" dir={ltr ? 'ltr' : undefined}>{value}</span>
    </div>
  );
}

function RevokeDialog({ invitation, pending, onCancel, onConfirm }: {
  invitation: InvitationRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const invalid = reason.trim().length < 3;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('invitations.revokeTitle')}</DialogTitle>
          <DialogDescription>
            {t('invitations.revokeBody', {
              name: [invitation.first_name, invitation.last_name].filter(Boolean).join(' ') || '—',
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="revoke-reason" className="text-xs">{t('invitations.revokeReasonLabel')}</Label>
          <Textarea
            id="revoke-reason"
            data-testid="invitation-revoke-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('invitations.revokeReasonPlaceholder')}
          />
          {invalid && reason.length > 0 && (
            <p className="text-xs text-destructive">{t('invitations.validationRevokeReason')}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{t('invitations.cancel')}</Button>
          <Button
            variant="destructive"
            data-testid="invitation-revoke-confirm"
            disabled={invalid || pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('invitations.revokeConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────── create / edit form ────────────────────────── */

export function InvitationFormDialog({
  workspaceId, mode, invitation, onClose, onCreated, onEdited,
}: {
  workspaceId: string;
  mode: InvitationMode;
  invitation: InvitationRow | null;
  onClose: () => void;
  onCreated: (manualLink: string) => void;
  onEdited: () => void;
}) {
  const { t, locale } = useTranslation();
  const requestIds = useRequestIdBook();
  const isEdit = !!invitation;

  const roles = mode === 'staff' ? STAFF_INVITE_ROLES : CUSTOMER_FACING_INVITE_ROLES;

  const [firstName, setFirstName] = useState(invitation?.first_name ?? '');
  const [lastName, setLastName] = useState(invitation?.last_name ?? '');
  const [email, setEmail] = useState(invitation?.invited_email_normalized ?? '');
  const [phone, setPhone] = useState(invitation?.invited_phone_e164 ?? '');
  const [role, setRole] = useState<string>(invitation?.role ?? roles[0]);
  const [jobTitle, setJobTitle] = useState(invitation?.job_title ?? '');
  const [staffCode, setStaffCode] = useState(invitation?.staff_code ?? '');
  // '0' = no expiry: valid until the workspace owner revokes or deletes it.
  const [expiresInDays, setExpiresInDays] = useState('0');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const { data: departments = [] } = useQuery({
    queryKey: ['ws-departments-list', workspaceId],
    queryFn: () => listDepartments(workspaceId),
    enabled: mode === 'customer_facing',
  });

  const errors = {
    firstName: firstName.trim() ? '' : 'invitations.validationFirstName',
    lastName: lastName.trim() ? '' : 'invitations.validationLastName',
    email: EMAIL.test(email.trim()) ? '' : 'invitations.validationEmail',
    phone: E164.test(phone.trim()) ? '' : 'invitations.validationPhone',
    role: role ? '' : 'invitations.validationRole',
    departments: mode === 'customer_facing' && departmentIds.length === 0
      ? 'invitations.validationDepartments'
      : '',
  } as const;
  const hasErrors = Object.values(errors).some(Boolean);

  const submit = useMutation({
    mutationFn: async () => {
      const payload = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        memberType: mode,
        role,
        departmentIds: mode === 'customer_facing' ? [...departmentIds].sort() : [],
        jobTitle: jobTitle.trim() || null,
        staffCode: staffCode.trim() || null,
        expiresInDays: Number(expiresInDays),
      };
      const intent = JSON.stringify(payload);
      const key = isEdit ? `edit_invitation:${invitation!.id}` : 'create_invitation';
      const requestId = requestIds.get(key, intent);

      if (isEdit) {
        await api(`/api/workspace-invitations/${invitation!.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...payload, requestId }),
        });
        return null;
      }
      const out = await api<{ manualLink: string }>('/api/workspace-invitations', {
        method: 'POST',
        // Locale snapshot for the invitation's emails/SMS: the currently
        // effective site language, resolved by the existing i18n mechanism.
        body: JSON.stringify({ workspaceId, ...payload, locale, requestId }),
      });
      return out.manualLink;
    },
    onSuccess: (manualLink) => {
      if (isEdit) { toast.success(t('invitations.toastUpdated')); onEdited(); }
      else { toast.success(t('invitations.toastCreated')); onCreated(String(manualLink)); }
      onClose();
    },
    onError: (e: unknown) => {
      const fields = (e as { fields?: string[] })?.fields;
      toast.error(t(invitationErrorKey(e)), {
        description: fields?.length ? fields.join(', ') : undefined,
      });
    },

  });

  const err = (field: keyof typeof errors) =>
    touched && errors[field]
      ? <p className="text-xs text-destructive" data-testid={`invitation-error-${field}`}>
          {t(errors[field] as TranslationKey)}
        </p>
      : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="invitation-form">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('invitations.editTitle')
              : mode === 'staff' ? t('invitations.createStaff') : t('invitations.createCustomer')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'staff' ? t('invitations.formHintStaff') : t('invitations.formHintCustomer')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="inv-first" className="text-xs">{t('invitations.fieldFirstName')}</Label>
              <Input
                id="inv-first" data-testid="invitation-first-name"
                value={firstName} autoComplete="given-name"
                placeholder={t('invitations.placeholderFirstName')}
                onChange={(e) => setFirstName(e.target.value)}
              />
              {err('firstName')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-last" className="text-xs">{t('invitations.fieldLastName')}</Label>
              <Input
                id="inv-last" data-testid="invitation-last-name"
                value={lastName} autoComplete="family-name"
                placeholder={t('invitations.placeholderLastName')}
                onChange={(e) => setLastName(e.target.value)}
              />
              {err('lastName')}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="inv-email" className="text-xs">{t('invitations.fieldEmail')}</Label>
            <Input
              id="inv-email" data-testid="invitation-email" type="email" dir="ltr"
              className="text-start text-xs" value={email}
              placeholder={t('invitations.placeholderEmail')}
              onChange={(e) => setEmail(e.target.value)}
            />
            {err('email')}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="inv-phone" className="text-xs">{t('invitations.fieldPhone')}</Label>
            <Input
              id="inv-phone" data-testid="invitation-phone" type="tel" dir="ltr"
              className="text-start text-xs" value={phone}
              placeholder={t('invitations.placeholderPhone')}
              onChange={(e) => setPhone(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t('invitations.phoneHint')}</p>
            {err('phone')}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('invitations.fieldRole')}</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger data-testid="invitation-role">
                <SelectValue placeholder={t('invitations.placeholderRole')} />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>{t(`invitations.roles.${r}` as TranslationKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {err('role')}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('invitations.fieldMemberType')}</Label>
            <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
               data-testid="invitation-member-type">
              {mode === 'staff' ? t('invitations.memberTypeStaff') : t('invitations.memberTypeCustomer')}
            </p>
          </div>

          {mode === 'customer_facing' && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('invitations.fieldDepartments')}</Label>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2"
                   data-testid="invitation-departments">
                {departments.length === 0 ? (
                  <p className="p-2 text-xs text-muted-foreground">{t('invitations.noDepartmentsHint')}</p>
                ) : departments.map((d: any) => (
                  <label key={d.id} className="flex items-center gap-2 rounded p-1.5 text-xs hover:bg-muted/40">
                    <Checkbox
                      checked={departmentIds.includes(d.id)}
                      aria-label={d.name}
                      onCheckedChange={(checked) => setDepartmentIds((cur) =>
                        checked ? [...cur, d.id] : cur.filter((id) => id !== d.id))}
                    />
                    <span>{d.name}</span>
                  </label>
                ))}
              </div>
              {err('departments')}
            </div>
          )}

          {mode === 'staff' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="inv-job" className="text-xs">{t('invitations.fieldJobTitle')}</Label>
                <Input
                  id="inv-job" data-testid="invitation-job-title" value={jobTitle}
                  placeholder={t('invitations.placeholderJobTitle')}
                  onChange={(e) => setJobTitle(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-code" className="text-xs">{t('invitations.fieldStaffCode')}</Label>
                <Input
                  id="inv-code" data-testid="invitation-staff-code" value={staffCode}
                  placeholder={t('invitations.placeholderStaffCode')}
                  onChange={(e) => setStaffCode(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">{t('invitations.fieldExpiry')}</Label>
            <Select value={expiresInDays} onValueChange={setExpiresInDays}>
              <SelectTrigger data-testid="invitation-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t('invitations.expiryUnlimited')}</SelectItem>
                {['1', '3', '7', '14', '30'].map((d) => (
                  <SelectItem key={d} value={d}>{t('invitations.expiryDays', { days: d })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('invitations.cancel')}</Button>
          <Button
            data-testid="invitation-submit"
            disabled={submit.isPending}
            onClick={() => {
              setTouched(true);
              if (hasErrors) return;
              submit.mutate();
            }}
          >
            {submit.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {isEdit ? t('invitations.save') : t('invitations.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default InvitationManagement;
