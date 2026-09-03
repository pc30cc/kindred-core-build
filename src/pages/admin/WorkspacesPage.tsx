import { useState, useDeferredValue } from 'react';
import { useTranslation } from '@/i18n';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  useAdminWorkspaces, useAdminWorkspaceCount,
  useAdminWorkspaceDetail, useAdminDeleteWorkspace, useAdminUserDetail,
} from '@/hooks/useAdmin';

import type { AdminPhoneStatusFilter } from '@/hooks/useAdmin';
import { PhoneStatusCell } from '@/features/phone-verification/PhoneStatusCell';
import { AdminPhoneVerificationCard } from '@/features/phone-verification/AdminPhoneVerificationCard';
import { toast } from '@/lib/toast';
import {
  Building2, Users, MessageSquare, BookUser, Trash2,
  Globe, Palette, Bot, Loader2, Shield, ArrowLeft,
  Mail, Calendar, MapPin, MonitorSmartphone, Copy, Search,
} from 'lucide-react';

function formatDate(value: string | Date, locale: string, includeTime = false) {
  const dateLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(dateLocale, includeTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export default function AdminWorkspacesPage() {
  const { t, locale } = useTranslation();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [phoneFilter, setPhoneFilter] = useState<AdminPhoneStatusFilter>('all');
  const deferredSearch = useDeferredValue(search);
  const [limit, setLimit] = useState(30);
  // Server-side filtering — filtering after pagination would silently drop rows.
  const { data: workspaces, isLoading } = useAdminWorkspaces(
    limit, page * limit, deferredSearch, sort, phoneFilter,
  );
  const { data: count } = useAdminWorkspaceCount(deferredSearch, phoneFilter);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const { data: detail, isLoading: detailLoading } = useAdminWorkspaceDetail(selectedId);
  const deleteMutation = useAdminDeleteWorkspace();

  const deleteWs = workspaces?.find(w => w.id === deleteId);

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteMutation.mutateAsync(deleteId);
      toast.success(t('admin.workspacesPage.deleted' as any));
      setDeleteId(null);
      setDeleteConfirm('');
      if (selectedId === deleteId) setSelectedId(null);
    } catch (err: any) {
      toast.error(err?.message || t('admin.workspacesPage.deleteFailed' as any));
    }
  };

  // Detail view (inline, not dialog)
  if (selectedId) {
    return (
      <WorkspaceDetailView
        detail={detail}
        loading={detailLoading}
        onBack={() => setSelectedId(null)}
        onDelete={(id) => setDeleteId(id)}
      />
    );
  }

  // List view
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-foreground">{t('admin.workspacesPage.title' as any)}</h1>
        <span className="text-sm text-muted-foreground">{t('admin.workspacesPage.total' as any, { count: count ?? 0 })}</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('admin.workspacesPage.search' as any)}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="ps-9"
          />
        </div>
        <Select value={phoneFilter} onValueChange={v => { setPhoneFilter(v as AdminPhoneStatusFilter); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.users.phoneFilterAll')}</SelectItem>
            <SelectItem value="verified">{t('admin.users.phoneFilterVerified')}</SelectItem>
            <SelectItem value="unverified">{t('admin.users.phoneFilterUnverified')}</SelectItem>
            <SelectItem value="no_phone">{t('admin.users.phoneFilterNoPhone')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={v => { setSort(v); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue placeholder={t('admin.workspacesPage.sort.label' as any)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t('admin.workspacesPage.sort.newest' as any)}</SelectItem>
            <SelectItem value="oldest">{t('admin.workspacesPage.sort.oldest' as any)}</SelectItem>
            <SelectItem value="most_members">{t('admin.workspacesPage.sort.mostMembers' as any)}</SelectItem>
            <SelectItem value="most_active">{t('admin.workspacesPage.sort.mostActive' as any)}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={v => { setLimit(Number(v)); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 20, 30, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{t('admin.workspacesPage.perPage' as any, { count: size })}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.workspacesPage.columns.name' as any)}</TableHead>
                <TableHead>{t('admin.workspacesPage.columns.slug' as any)}</TableHead>
                <TableHead>{t('admin.workspacesPage.columns.owner' as any)}</TableHead>
                <TableHead>{t('admin.users.colOwnerPhone')}</TableHead>
                <TableHead>{t('admin.workspacesPage.columns.members' as any)}</TableHead>
                <TableHead>{t('admin.workspacesPage.columns.created' as any)}</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && (!workspaces || workspaces.length === 0) && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">{t('admin.workspacesPage.empty' as any)}</TableCell>
                </TableRow>
              )}
              {workspaces?.map(w => (
                <TableRow
                  key={w.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setSelectedId(w.id)}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Building2 className="h-4 w-4 text-primary" />
                      </div>
                      <span>{w.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{w.slug}</code>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{w.owner_email}</TableCell>
                  <TableCell>
                    <PhoneStatusCell
                      masked={w.owner_phone_masked}
                      verified={w.owner_phone_verified}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{w.member_count}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(w.created_at, locale)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost" size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setDeleteId(w.id); }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination — driven by the server-side total, not the page length. */}
      <div className="flex justify-between items-center">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('admin.workspacesPage.previous' as any)}</Button>
        <span className="text-sm text-muted-foreground">
          {t('admin.workspacesPage.page' as any, { current: page + 1, total: typeof count === 'number' ? Math.max(1, Math.ceil(count / limit)) : '—' })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={typeof count === 'number' ? (page + 1) * limit >= count : !workspaces || workspaces.length < limit}
          onClick={() => setPage(p => p + 1)}
        >
          {t('admin.workspacesPage.next' as any)}
        </Button>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteDialog
        deleteWs={deleteWs}
        deleteId={deleteId}
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        onClose={() => { setDeleteId(null); setDeleteConfirm(''); }}
        onDelete={handleDelete}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

/* ─── Workspace Detail (inline view) ─── */
function WorkspaceDetailView({
  detail, loading, onBack, onDelete,
}: {
  detail: any;
  loading: boolean;
  onBack: () => void;
  onDelete: (id: string) => void;
}) {
  const { t, locale } = useTranslation();
  const [selectedMember, setSelectedMember] = useState<any>(null);
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('admin.workspacesPage.back' as any)}
        </Button>
        <p className="text-center text-muted-foreground py-12">{t('admin.workspacesPage.notFound' as any)}</p>
      </div>
    );
  }

  const ws = detail.workspace;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </Button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{ws?.name}</h1>
            <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{ws?.slug}</code>
          </div>
        </div>
        <Button
          variant="destructive" size="sm"
          onClick={() => onDelete(ws?.id)}
          className="gap-2 shrink-0"
        >
          <Trash2 className="h-4 w-4" />
          {t('admin.workspacesPage.delete' as any)}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={Users} label={t('admin.workspacesPage.stats.members' as any)} value={detail.members?.length ?? 0} />
        <StatCard icon={BookUser} label={t('admin.workspacesPage.stats.contacts' as any)} value={detail.contact_count} />
        <StatCard icon={MessageSquare} label={t('admin.workspacesPage.stats.conversations' as any)} value={detail.conversation_count} />
        <StatCard icon={Globe} label={t('admin.workspacesPage.stats.locale' as any)} value={ws?.default_locale || 'en'} />
      </div>

      {/* Owner phone verification — the workspace has no own phone state. */}
      {ws?.owner_id && (
        <AdminPhoneVerificationCard
          userId={ws.owner_id}
          readOnly
          ownerLink
          title={t('admin.users.ownerPhoneVerification')}
          note={t('admin.users.ownerPhoneNote')}
        />
      )}

      {/* Members */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            {t('admin.workspacesPage.membersTitle' as any, { count: detail.members?.length ?? 0 })}
          </h3>
          <div className="space-y-2">
            {detail.members?.map((m: any) => (
              <button
                key={m.id}
                onClick={() => setSelectedMember(m)}
                className="flex items-center justify-between rounded-lg border px-3 py-2 w-full text-start hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-xs font-semibold text-primary">
                      {(m.full_name || m.email || '?').charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">{m.full_name || '—'}</p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </div>
                </div>
                <Badge variant={m.role === 'owner' ? 'default' : 'secondary'}>{['owner', 'admin', 'member'].includes(m.role) ? t(`admin.workspacesPage.roles.${m.role}` as any) : m.role}</Badge>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Member Detail Dialog */}
      <MemberDetailDialog member={selectedMember} onClose={() => setSelectedMember(null)} />

      {/* Branding & Widget side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {detail.branding && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Palette className="h-4 w-4 text-muted-foreground" />
                {t('admin.workspacesPage.branding.title' as any)}
              </h3>
              <div className="space-y-2 text-sm">
                <InfoRow label={t('admin.workspacesPage.branding.platformName' as any)} value={detail.branding.platform_name} />
                <InfoRow label={t('admin.workspacesPage.branding.primaryColor' as any)} value={detail.branding.primary_color} color />
                <InfoRow label={t('admin.workspacesPage.branding.accentColor' as any)} value={detail.branding.accent_color} color />
                <InfoRow label={t('admin.workspacesPage.branding.supportEmail' as any)} value={detail.branding.support_email} />
                <InfoRow label={t('admin.workspacesPage.branding.legalName' as any)} value={detail.branding.legal_name} />
              </div>
            </CardContent>
          </Card>
        )}

        {detail.widget_settings && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                {t('admin.workspacesPage.widget.title' as any)}
              </h3>
              <div className="space-y-2 text-sm">
                <InfoRow label={t('admin.workspacesPage.widget.enabled' as any)} value={detail.widget_settings.enabled ? t('admin.common.yes') : t('admin.common.no')} />
                <InfoRow label={t('admin.workspacesPage.widget.chat' as any)} value={detail.widget_settings.chat_enabled ? t('admin.common.yes') : t('admin.common.no')} />
                <InfoRow label={t('admin.workspacesPage.widget.knowledgeBase' as any)} value={detail.widget_settings.kb_enabled ? t('admin.common.yes') : t('admin.common.no')} />
                <InfoRow label={t('admin.workspacesPage.widget.position' as any)} value={detail.widget_settings.position} />
                <InfoRow label={t('admin.workspacesPage.widget.tracking' as any)} value={detail.widget_settings.visitor_tracking_enabled ? t('admin.common.yes') : t('admin.common.no')} />
                <InfoRow label={t('admin.workspacesPage.widget.color' as any)} value={detail.widget_settings.primary_color} color />
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Meta info */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            {t('admin.workspacesPage.technical.title' as any)}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <InfoRow label={t('admin.workspacesPage.technical.workspaceId' as any)} value={ws?.id} />
            <InfoRow label={t('admin.workspacesPage.technical.ownerId' as any)} value={ws?.owner_id} />
            <InfoRow label={t('admin.workspacesPage.technical.accountId' as any)} value={ws?.account_id} />
            <InfoRow label={t('admin.workspacesPage.columns.created' as any)} value={ws?.created_at ? formatDate(ws.created_at, locale, true) : '—'} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Delete Confirmation Dialog ─── */
function DeleteDialog({
  deleteWs, deleteId, deleteConfirm, setDeleteConfirm, onClose, onDelete, isPending,
}: {
  deleteWs: any;
  deleteId: string | null;
  deleteConfirm: string;
  setDeleteConfirm: (v: string) => void;
  onClose: () => void;
  onDelete: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            {t('admin.workspacesPage.deleteDialog.title' as any)}
          </DialogTitle>
          <DialogDescription>
            {t('admin.workspacesPage.deleteDialog.description' as any, { name: deleteWs?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            {t('admin.workspacesPage.deleteDialog.typeBefore' as any)} <code className="bg-muted px-1.5 py-0.5 rounded font-semibold text-destructive">{deleteWs?.slug}</code> {t('admin.workspacesPage.deleteDialog.typeAfter' as any)}
          </p>
          <input
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={deleteWs?.slug}
            value={deleteConfirm}
            onChange={e => setDeleteConfirm(e.target.value)}
            autoFocus
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>{t('admin.workspacesPage.deleteDialog.cancel' as any)}</Button>
          <Button
            variant="destructive"
            disabled={deleteConfirm !== deleteWs?.slug || isPending}
            onClick={onDelete}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
            {t('admin.workspacesPage.deleteDialog.confirm' as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Small helpers ─── */
function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <Icon className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
      <p className="text-lg font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function InfoRow({ label, value, color }: { label: string; value: string | null | undefined; color?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium flex items-center gap-1.5">
        {color && value && (
          <span className="w-3 h-3 rounded-full border" style={{ backgroundColor: value }} />
        )}
        <span className="truncate max-w-[180px]">{value || '—'}</span>
      </span>
    </div>
  );
}

/* ─── Member Detail Dialog ─── */
function MemberDetailDialog({ member, onClose }: { member: any; onClose: () => void }) {
  // Admin profile reads go through the backend admin API (service-role only).
  // The admin_* RPCs are no longer callable from the browser.
  const { data: detail } = useAdminUserDetail(member?.user_id ?? null);
  const { t, locale } = useTranslation();
  const p = detail?.profile;


  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t('admin.workspacesPage.member.copied' as any));
  };

  return (
    <Dialog open={!!member} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            {t('admin.workspacesPage.member.title' as any)}
          </DialogTitle>
        </DialogHeader>

        {!p ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Avatar & name header */}
            <div className="flex items-center gap-4 pb-2">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-xl font-bold text-primary">
                  {(p.full_name || p.email || '?').charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold truncate">{p.full_name || '—'}</p>
                <p className="text-sm text-muted-foreground truncate">{p.email}</p>
                <Badge variant={member?.role === 'owner' ? 'default' : 'secondary'} className="mt-1">
                  {['owner', 'admin', 'member'].includes(member?.role) ? t(`admin.workspacesPage.roles.${member.role}` as any) : member?.role}
                </Badge>
              </div>
            </div>

            <Separator />

            {/* Info rows */}
            <div className="space-y-2 text-sm">
              <DetailRow
                icon={Mail}
                label={t('admin.workspacesPage.member.email' as any)}
                value={p.email}
                onCopy={() => copyToClipboard(p.email)}
              />
              <DetailRow icon={Building2} label={t('admin.workspacesPage.member.company' as any)} value={p.company_name} />
              <DetailRow icon={Globe} label={t('admin.workspacesPage.member.website' as any)} value={p.website_domain} />
              <DetailRow icon={Globe} label={t('admin.workspacesPage.member.preferredLocale' as any)} value={p.preferred_locale} />
              <DetailRow icon={Globe} label={t('admin.workspacesPage.member.signupLocale' as any)} value={p.signup_locale} />
              <DetailRow icon={Bot} label={t('admin.workspacesPage.member.aiMode' as any)} value={p.ai_mode} />
              <DetailRow icon={MapPin} label={t('admin.workspacesPage.member.signupIp' as any)} value={p.signup_ip} />
              <DetailRow
                icon={Calendar}
                label={t('admin.workspacesPage.member.joined' as any)}
                value={p.created_at ? formatDate(p.created_at, locale, true) : null}
              />
              <DetailRow
                icon={Calendar}
                label={t('admin.workspacesPage.member.memberSince' as any)}
                value={member?.created_at ? formatDate(member.created_at, locale, true) : null}
              />
            </div>

            <Separator />

            {/* User ID */}
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-xs text-muted-foreground">{t('admin.workspacesPage.member.userId' as any)}</span>
              <button
                onClick={() => copyToClipboard(p.id)}
                className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                <span className="truncate max-w-[200px]">{p.id}</span>
                <Copy className="h-3 w-3 shrink-0" />
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ icon: Icon, label, value, onCopy }: { icon: any; label: string; value: string | null | undefined; onCopy?: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="font-medium flex items-center gap-1.5">
        <span className="truncate max-w-[200px]">{value || '—'}</span>
        {onCopy && value && (
          <button onClick={onCopy} className="text-muted-foreground hover:text-foreground transition-colors">
            <Copy className="h-3 w-3" />
          </button>
        )}
      </span>
    </div>
  );
}
