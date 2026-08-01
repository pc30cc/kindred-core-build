import { useState, useDeferredValue } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { AdminPhoneVerificationCard } from '@/features/phone-verification/AdminPhoneVerificationCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  useAdminProfiles, useAdminProfileCount, useAdminUserDetail,
  useAdminUserRoles, useAssignRole, useRemoveRole,
} from '@/hooks/useAdmin';
import { useAdminPlans, useAssignPlan, useRevokePlan, useWorkspacePlan } from '@/hooks/usePlans';
import { supabase } from '@/lib/supabase';
import {
  adminSendResetLink, adminChangePassword, adminBlockUser, adminGetUserStatus, adminImpersonateUser,
} from '@/lib/api';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';
import {
  Users, Loader2, ArrowLeft, Mail, Calendar, MapPin,
  Globe, Bot, Building2, Copy, Search, Shield, Briefcase, Link2,
  KeyRound, Send, Ban, ScrollText, CheckCircle2, XCircle, Clock, LogIn, CreditCard,
} from 'lucide-react';

export default function AdminUsersPage() {
  const { t, dir } = useTranslation();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [limit, setLimit] = useState(30);
  const deferredSearch = useDeferredValue(search);

  const { data: profiles, isLoading } = useAdminProfiles(limit, page * limit, deferredSearch, sort);
  const { data: count } = useAdminProfileCount();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  if (selectedUserId) {
    return (
      <UserDetailView
        userId={selectedUserId}
        onBack={() => setSelectedUserId(null)}
      />
    );
  }

  return (
    <div className="space-y-6" dir={dir}>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-foreground">{t('admin.users.title')}</h1>
        <span className="text-sm text-muted-foreground">{t('admin.users.total', { count: String(count ?? 0) })}</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className={`absolute ${dir === 'rtl' ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
          <Input
            placeholder={t('admin.users.searchPlaceholder')}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className={dir === 'rtl' ? 'pr-9' : 'pl-9'}
          />
        </div>
        <Select value={sort} onValueChange={v => { setSort(v); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder={t('admin.users.sortBy')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t('admin.users.sortNewest')}</SelectItem>
            <SelectItem value="oldest">{t('admin.users.sortOldest')}</SelectItem>
            <SelectItem value="name_asc">{t('admin.users.sortNameAsc')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={v => { setLimit(Number(v)); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 20, 30, 50, 100].map(n => (
              <SelectItem key={n} value={String(n)}>{t('admin.users.perPage', { n: String(n) })}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.users.colUser')}</TableHead>
                <TableHead>{t('admin.users.colCompany')}</TableHead>
                <TableHead>{t('admin.users.colRoles')}</TableHead>
                <TableHead>{t('admin.users.colWorkspaces')}</TableHead>
                <TableHead>{t('admin.users.colPhone')}</TableHead>
                <TableHead>{t('admin.users.colJoined')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && (!profiles || profiles.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t('admin.users.noUsers')}</TableCell>
                </TableRow>
              )}
              {profiles?.map(p => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setSelectedUserId(p.id)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <span className="text-xs font-semibold text-primary">
                          {(p.full_name || p.email || '?').charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{p.full_name || '—'}</p>
                        <p className="text-xs text-muted-foreground truncate">{p.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.company_name || '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {(!p.roles || p.roles.length === 0) && <span className="text-xs text-muted-foreground">—</span>}
                      {p.roles?.map((r: string) => (
                        <Badge key={r} variant={r === 'admin' ? 'destructive' : 'secondary'} className="text-xs">{r}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{p.workspace_count}</Badge></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={(p as any).phone_verified ? 'default' : 'secondary'} className="text-xs">
                        {(p as any).phone_verified
                          ? t('phoneVerification.statusVerified')
                          : t('phoneVerification.statusUnverified')}
                      </Badge>
                      {(p as any).phone_masked && (
                        <span className="text-xs text-muted-foreground font-mono" dir="ltr">
                          {(p as any).phone_masked}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.created_at ? format(new Date(p.created_at), 'yyyy-MM-dd') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('admin.users.previous')}</Button>
        <span className="text-sm text-muted-foreground">{t('admin.users.page', { n: String(page + 1) })}</span>
        <Button variant="outline" size="sm" disabled={!profiles || profiles.length < limit} onClick={() => setPage(p => p + 1)}>{t('admin.users.next')}</Button>
      </div>
    </div>
  );
}

/* ─── User Detail View ─── */
function UserDetailView({ userId, onBack }: { userId: string; onBack: () => void }) {
  const { t, dir } = useTranslation();
  const { data: detail, isLoading, refetch } = useAdminUserDetail(userId);
  const { data: roles, refetch: refetchRoles } = useAdminUserRoles(userId);
  const assignRole = useAssignRole();
  const removeRole = useRemoveRole();

  const [roleDialog, setRoleDialog] = useState(false);
  const [selectedRole, setSelectedRole] = useState('');
  const [passwordDialog, setPasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [resetLinkLoading, setResetLinkLoading] = useState(false);
  const [blockLoading, setBlockLoading] = useState(false);
  const [loginLogsDialog, setLoginLogsDialog] = useState(false);
  const [impersonateLoading, setImpersonateLoading] = useState(false);

  // Get auth status (banned, etc.)
  const { data: authStatus, refetch: refetchStatus } = useQuery({
    queryKey: ['admin-user-auth-status', userId],
    queryFn: () => adminGetUserStatus(userId),
    enabled: !!userId,
    retry: false,
  });

  const isBanned = authStatus?.banned_until && new Date(authStatus.banned_until) > new Date();

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t('admin.users.copied'));
  };

  const handleSendResetLink = async () => {
    if (!detail?.profile?.email) return;
    setResetLinkLoading(true);
    try {
      await adminSendResetLink(detail.profile.email);
      toast.success(t('admin.users.resetLinkSent'));
    } catch (err: any) {
      toast.error(err.message || t('admin.users.resetLinkFailed'));
    } finally {
      setResetLinkLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      toast.error(t('admin.users.passwordMinError'));
      return;
    }
    setPasswordLoading(true);
    try {
      await adminChangePassword(userId, newPassword);
      toast.success(t('admin.users.passwordChanged'));
      setPasswordDialog(false);
      setNewPassword('');
    } catch (err: any) {
      toast.error(err.message || t('admin.users.passwordChangeFailed'));
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleToggleBlock = async () => {
    setBlockLoading(true);
    try {
      const result = await adminBlockUser(userId, !isBanned);
      toast.success(result.blocked ? t('admin.users.userBlocked') : t('admin.users.userUnblocked'));
      refetchStatus();
    } catch (err: any) {
      toast.error(err.message || t('admin.users.blockFailed'));
    } finally {
      setBlockLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-4" dir={dir}>
        <Button variant="ghost" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> {t('admin.users.backToList')}
        </Button>
        <p className="text-center text-muted-foreground py-12">{t('admin.users.userNotFound')}</p>
      </div>
    );
  }

  const p = detail.profile;
  const currentRoles = roles?.map(r => r.role) ?? detail.roles ?? [];

  return (
    <div className="space-y-6" dir={dir}>
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <span className="text-lg font-bold text-primary">
              {(p.full_name || p.email || '?').charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold truncate">{p.full_name || '—'}</h1>
              {isBanned && <Badge variant="destructive" className="shrink-0">{t('admin.users.blocked')}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground truncate">{p.email}</p>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="gap-2" onClick={handleSendResetLink} disabled={resetLinkLoading}>
          {resetLinkLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t('admin.users.sendResetLink')}
        </Button>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setPasswordDialog(true)}>
          <KeyRound className="h-4 w-4" />
          {t('admin.users.changePassword')}
        </Button>
        <Button
          variant={isBanned ? 'outline' : 'destructive'}
          size="sm"
          className="gap-2"
          onClick={handleToggleBlock}
          disabled={blockLoading}
        >
          {blockLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
          {isBanned ? t('admin.users.unblockUser') : t('admin.users.blockUser')}
        </Button>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setLoginLogsDialog(true)}>
          <ScrollText className="h-4 w-4" />
          {t('admin.users.loginLogs')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={impersonateLoading}
          onClick={async () => {
            try {
              setImpersonateLoading(true);
              const { url } = await adminImpersonateUser(userId);
              window.open(url, '_blank');
            } catch (err: any) {
              toast.error(err.message || t('admin.users.impersonateFailed'));
            } finally {
              setImpersonateLoading(false);
            }
          }}
        >
          {impersonateLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {t('admin.users.loginAsUser')}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={Briefcase} label={t('admin.users.statWorkspaces')} value={detail.workspaces?.length ?? 0} />
        <StatCard icon={Shield} label={t('admin.users.statRoles')} value={currentRoles.length} />
        <StatCard icon={Globe} label={t('admin.users.statLocale')} value={p.preferred_locale || 'en'} />
        <StatCard icon={Bot} label={t('admin.users.statAiMode')} value={p.ai_mode || '—'} />
      </div>

      {/* Auth Status */}
      {authStatus && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              {t('admin.users.authStatus')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">{t('admin.users.emailVerified')}</span>
                <span className="flex items-center gap-1.5">
                  {authStatus.email_confirmed_at
                    ? <><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> {t('admin.users.yes')}</>
                    : <><XCircle className="h-3.5 w-3.5 text-destructive" /> {t('admin.users.no')}</>}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">{t('admin.users.status')}</span>
                <Badge variant={isBanned ? 'destructive' : 'secondary'}>
                  {isBanned ? t('admin.users.blocked') : t('admin.users.active')}
                </Badge>
              </div>
              <DetailRow
                icon={Clock}
                label={t('admin.users.lastSignIn')}
                value={authStatus.last_sign_in_at ? format(new Date(authStatus.last_sign_in_at), 'yyyy-MM-dd HH:mm') : null}
              />
              <DetailRow
                icon={Calendar}
                label={t('admin.users.authCreated')}
                value={authStatus.created_at ? format(new Date(authStatus.created_at), 'yyyy-MM-dd HH:mm') : null}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform Roles Management */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                {t('admin.users.platformRoles')}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('admin.users.platformRolesHint')}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setRoleDialog(true)}>{t('admin.users.assignRole')}</Button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {currentRoles.length === 0 && <span className="text-sm text-muted-foreground">{t('admin.users.noPlatformRoles')}</span>}
            {currentRoles.map((role: string) => (
              <Badge
                key={role}
                variant={role === 'admin' ? 'destructive' : 'secondary'}
                className="cursor-pointer gap-1"
                onClick={() => removeRole.mutate({ userId, role: role as any })}
              >
                {role} ×
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Profile Info */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            {t('admin.users.profileInfo')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <DetailRow icon={Mail} label={t('admin.users.email')} value={p.email} onCopy={() => copyToClipboard(p.email)} />
            <DetailRow icon={Building2} label={t('admin.users.company')} value={p.company_name} />
            <DetailRow icon={Link2} label={t('admin.users.website')} value={p.website_domain} />
            <DetailRow icon={Globe} label={t('admin.users.preferredLocale')} value={p.preferred_locale} />
            <DetailRow icon={Globe} label={t('admin.users.signupLocale')} value={p.signup_locale} />
            <DetailRow icon={Bot} label={t('admin.users.aiMode')} value={p.ai_mode} />
            <DetailRow icon={MapPin} label={t('admin.users.signupIp')} value={p.signup_ip} />
            <DetailRow icon={Calendar} label={t('admin.users.joined')} value={p.created_at ? format(new Date(p.created_at), 'yyyy-MM-dd HH:mm') : null} />
          </div>
        </CardContent>
      </Card>

      {/* Workspace Plans & Subscriptions */}
      <AdminPhoneVerificationCard userId={userId} />

      {detail.workspaces && detail.workspaces.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                {t('admin.users.plansHeader')}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">{t('admin.users.plansHint')}</p>
            </div>
            <div className="space-y-2">
              {detail.workspaces.map((ws: any) => (
                <WorkspacePlanCard key={ws.id} workspace={ws} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Workspaces */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            {t('admin.users.workspaces')} ({detail.workspaces?.length ?? 0})
          </h3>
          <div className="space-y-2">
            {(!detail.workspaces || detail.workspaces.length === 0) && (
              <p className="text-sm text-muted-foreground">{t('admin.users.noWorkspaces')}</p>
            )}
            {detail.workspaces?.map((ws: any) => (
              <div key={ws.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{ws.name}</p>
                    <code className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">{ws.slug}</code>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={ws.role === 'owner' ? 'default' : 'secondary'}>{ws.role}</Badge>
                  <span className="text-[10px] text-muted-foreground">{t('admin.users.workspaceRole')}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Account info */}
      {detail.account && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-muted-foreground" />
              {t('admin.users.account')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <InfoRow label={t('admin.users.accountName')} value={detail.account.name} />
              <InfoRow label={t('admin.users.accountSlug')} value={detail.account.slug} />
              <InfoRow label={t('admin.users.accountRole')} value={detail.account.role} />
              <InfoRow label={t('admin.users.accountId')} value={detail.account.id} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* User ID */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            {t('admin.users.technicalDetails')}
          </h3>
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <span className="text-xs text-muted-foreground">{t('admin.users.userId')}</span>
            <button
              onClick={() => copyToClipboard(p.id)}
              className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className="truncate max-w-[250px]">{p.id}</span>
              <Copy className="h-3 w-3 shrink-0" />
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Change Password Dialog */}
      <Dialog open={passwordDialog} onOpenChange={setPasswordDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              {t('admin.users.changePassword')}
            </DialogTitle>
            <DialogDescription>
              {t('admin.users.changePasswordFor')} <strong>{p.email}</strong>
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            placeholder={t('admin.users.newPasswordPlaceholder')}
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPasswordDialog(false); setNewPassword(''); }}>{t('admin.users.cancel')}</Button>
            <Button onClick={handleChangePassword} disabled={passwordLoading || newPassword.length < 8}>
              {passwordLoading && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {t('admin.users.changePassword')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Platform Role Dialog */}
      <Dialog open={roleDialog} onOpenChange={setRoleDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.users.assignPlatformRole')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {[
              { value: 'admin', label: t('admin.users.roleAdminLabel'), desc: t('admin.users.roleAdminDesc') },
              { value: 'moderator', label: t('admin.users.roleModeratorLabel'), desc: t('admin.users.roleModeratorDesc') },
              { value: 'user', label: t('admin.users.roleUserLabel'), desc: t('admin.users.roleUserDesc') },
            ].map(r => {
              const alreadyAssigned = currentRoles.includes(r.value);
              return (
                <button
                  key={r.value}
                  disabled={alreadyAssigned}
                  onClick={() => setSelectedRole(r.value)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    selectedRole === r.value
                      ? 'border-primary bg-primary/5'
                      : alreadyAssigned
                        ? 'opacity-50 cursor-not-allowed border-border bg-muted/30'
                        : 'border-border hover:border-primary/40 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{r.label}</span>
                    {alreadyAssigned && <Badge variant="outline" className="text-[10px]">{t('admin.users.assigned')}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{r.desc}</p>
                </button>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialog(false)}>{t('admin.users.cancel')}</Button>
            <Button
              disabled={!selectedRole || currentRoles.includes(selectedRole)}
              onClick={() => {
                if (selectedRole) {
                  assignRole.mutate({ userId, role: selectedRole as any });
                  setSelectedRole('');
                  setRoleDialog(false);
                }
              }}
            >
              {t('admin.users.assign')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Login Logs Dialog */}
      <LoginLogsDialog
        open={loginLogsDialog}
        onClose={() => setLoginLogsDialog(false)}
        email={p.email}
      />
    </div>
  );
}

/* ─── Login Logs Dialog ─── */
function LoginLogsDialog({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  const { t } = useTranslation();
  const { data: logs, isLoading } = useQuery({
    queryKey: ['admin-login-logs', email],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_login_attempts', {
        _email: email,
        _limit: 50,
      });
      if (error) throw error;
      return data as Array<{
        id: string;
        email: string;
        ip_address: string;
        success: boolean;
        created_at: string;
      }>;
    },
    enabled: open && !!email,
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5" />
            {t('admin.users.loginLogs')}
          </DialogTitle>
          <DialogDescription>
            {t('admin.users.loginLogsFor')} <strong>{email}</strong>
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : !logs || logs.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">{t('admin.users.noLoginAttempts')}</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto space-y-2">
            {logs.map((log: any) => (
              <div
                key={log.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  {log.success
                    ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                  <div>
                    <p className="font-medium">{log.success ? t('admin.users.successful') : t('admin.users.failedAttempt')}</p>
                    <p className="text-xs text-muted-foreground">{t('admin.users.ip')}: {log.ip_address}</p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {format(new Date(log.created_at), 'yyyy-MM-dd HH:mm:ss')}
                </span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Workspace Plan Card ─── */
function WorkspacePlanCard({ workspace }: { workspace: { id: string; name: string; slug: string; role: string } }) {
  const { t } = useTranslation();
  const { data: planData, isLoading } = useWorkspacePlan(workspace.id);
  const { data: allPlans } = useAdminPlans();
  const assignPlan = useAssignPlan();
  const revokePlan = useRevokePlan();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const sub = planData?.subscription;
  const plan = planData?.plan;
  const hasActiveSub = !!sub && ['active', 'trialing'].includes(sub.status || '');

  const openDialog = () => {
    setSelectedPlanId(plan?.id || '');
    setExpiresAt(sub?.current_period_end ? new Date(sub.current_period_end).toISOString().slice(0, 10) : '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!selectedPlanId) return;
    try {
      await assignPlan.mutateAsync({
        workspaceId: workspace.id,
        planId: selectedPlanId,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      toast.success(t('admin.users.planAssigned'));
      setDialogOpen(false);
    } catch (err: any) {
      toast.error(err.message || t('admin.users.planAssignFailed'));
    }
  };

  const handleRevoke = async () => {
    if (!confirm(t('admin.users.revokeConfirm'))) return;
    try {
      await revokePlan.mutateAsync(workspace.id);
      toast.success(t('admin.users.planRevoked'));
    } catch (err: any) {
      toast.error(err.message || t('admin.users.planRevokeFailed'));
    }
  };

  const fmt = (s: string | null | undefined) => s ? format(new Date(s), 'yyyy-MM-dd HH:mm') : '—';

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-medium truncate">{workspace.name}</span>
          <code className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">{workspace.slug}</code>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={openDialog} disabled={isLoading}>
            {t('admin.users.changePlan')}
          </Button>
          {hasActiveSub && (
            <Button size="sm" variant="ghost" onClick={handleRevoke} disabled={revokePlan.isPending}>
              {t('admin.users.revokePlan')}
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
            <span className="text-muted-foreground">{t('admin.users.currentPlan')}</span>
            <Badge variant={hasActiveSub ? 'default' : 'secondary'}>
              {plan?.name || t('admin.users.noActiveSub')}
            </Badge>
          </div>
          <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
            <span className="text-muted-foreground">{t('admin.users.planStatus')}</span>
            <span className="font-medium">{sub?.status || '—'}</span>
          </div>
          {sub && (
            <>
              <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
                <span className="text-muted-foreground">{t('admin.users.provider')}</span>
                <span className="font-medium">{sub.provider_name || '—'}</span>
              </div>
              <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
                <span className="text-muted-foreground">{t('admin.users.periodStart')}</span>
                <span className="font-medium">{fmt(sub.current_period_start)}</span>
              </div>
              <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
                <span className="text-muted-foreground">{t('admin.users.periodEnd')}</span>
                <span className="font-medium">{fmt(sub.current_period_end)}</span>
              </div>
              {sub.trial_end && (
                <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
                  <span className="text-muted-foreground">{t('admin.users.trialEnd')}</span>
                  <span className="font-medium">{fmt(sub.trial_end)}</span>
                </div>
              )}
              {sub.cancel_at_period_end && (
                <div className="sm:col-span-2 text-amber-600 dark:text-amber-400 text-[11px]">
                  ⚠ {t('admin.users.cancelAtPeriodEnd')}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" /> {t('admin.users.assignPlan')}
            </DialogTitle>
            <DialogDescription>{workspace.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">{t('admin.users.selectPlan')}</label>
              <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                <SelectTrigger><SelectValue placeholder={t('admin.users.selectPlan')} /></SelectTrigger>
                <SelectContent>
                  {allPlans?.map((pl: any) => (
                    <SelectItem key={pl.id} value={pl.id}>{pl.name} ({pl.slug})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('admin.users.expiresAt')}</label>
              <Input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('admin.users.cancel')}</Button>
            <Button onClick={handleSave} disabled={!selectedPlanId || assignPlan.isPending}>
              {assignPlan.isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {t('admin.users.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate max-w-[180px]">{value || '—'}</span>
    </div>
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
