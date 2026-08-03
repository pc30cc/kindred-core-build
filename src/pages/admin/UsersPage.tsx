import { useState, useDeferredValue, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { AdminPhoneVerificationCard } from '@/features/phone-verification/AdminPhoneVerificationCard';
import { PhoneStatusCell } from '@/features/phone-verification/PhoneStatusCell';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useAdminProfiles, useAdminProfileCount, useAdminUserDetail,
  useAdminUserRoles, useAssignRole, useRemoveRole,
} from '@/hooks/useAdmin';
import type { AdminPhoneStatusFilter } from '@/hooks/useAdmin';
import { useAdminPlans, useAssignPlan, useRevokePlan, useWorkspacePlan } from '@/hooks/usePlans';
import { supabase } from '@/lib/supabase';
import {
  adminSendResetLink, adminChangePassword, adminBlockUser, adminGetUserStatus, adminImpersonateUser,
  adminDeleteUserAvatar, adminGetUserMessages, adminGetUserBilling,
} from '@/lib/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPattern as format } from '@/lib/date';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';
import {
  Users, Loader2, ArrowLeft, Mail, Calendar, MapPin,
  Globe, Bot, Building2, Copy, Search, Shield, Briefcase, Link2,
  KeyRound, Send, Ban, ScrollText, CheckCircle2, XCircle, Clock, LogIn, CreditCard,
  MessageSquare, Trash2,
} from 'lucide-react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AdminUsersPage() {
  const { t, dir } = useTranslation();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [limit, setLimit] = useState(30);
  const [phoneStatus, setPhoneStatus] = useState<AdminPhoneStatusFilter>('all');
  const deferredSearch = useDeferredValue(search);
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep link: /admin/users?user=<uuid>. An invalid value is ignored and
  // never triggers a fetch.
  const rawUserParam = searchParams.get('user');
  const selectedUserId = rawUserParam && UUID_RE.test(rawUserParam) ? rawUserParam : null;

  const openUser = useCallback((id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('user', id);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const closeUser = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('user');
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  // Filtering happens server-side so the count and pagination stay truthful.
  const { data: profiles, isLoading } = useAdminProfiles(limit, page * limit, deferredSearch, sort, phoneStatus);
  const { data: count } = useAdminProfileCount(deferredSearch, phoneStatus);
  const total = count ?? 0;
  const hasNextPage = (page + 1) * limit < total;

  if (selectedUserId) {
    return (
      <UserDetailView
        userId={selectedUserId}
        onBack={closeUser}
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
        <Select value={phoneStatus} onValueChange={v => { setPhoneStatus(v as AdminPhoneStatusFilter); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder={t('admin.users.phoneFilter')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.users.phoneFilterAll')}</SelectItem>
            <SelectItem value="verified">{t('admin.users.phoneFilterVerified')}</SelectItem>
            <SelectItem value="unverified">{t('admin.users.phoneFilterUnverified')}</SelectItem>
            <SelectItem value="no_phone">{t('admin.users.phoneFilterNoPhone')}</SelectItem>
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
                  onClick={() => openUser(p.id)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="w-8 h-8 shrink-0">
                        {p.avatar_url ? <AvatarImage src={p.avatar_url} alt={p.full_name || p.email || ''} /> : null}
                        <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                          {(p.full_name || p.email || '?').charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
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
                    <PhoneStatusCell masked={p.phone_masked} verified={p.phone_verified} />
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
        <Button variant="outline" size="sm" disabled={!hasNextPage} onClick={() => setPage(p => p + 1)}>{t('admin.users.next')}</Button>
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
  const [resetConfirm, setResetConfirm] = useState(false);
  const [blockConfirm, setBlockConfirm] = useState(false);
  const [avatarConfirm, setAvatarConfirm] = useState(false);
  const [avatarLoading, setAvatarLoading] = useState(false);

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
    setResetConfirm(false);
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
    setBlockConfirm(false);
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

  const handleRemoveAvatar = async () => {
    setAvatarConfirm(false);
    setAvatarLoading(true);
    try {
      await adminDeleteUserAvatar(userId);
      toast.success(t('admin.users.avatarRemoved'));
      refetch();
    } catch (err: any) {
      toast.error(err.message || t('admin.users.avatarRemoveFailed'));
    } finally {
      setAvatarLoading(false);
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
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 -ms-2">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('admin.users.backToList')}
      </Button>

      <Card className="overflow-hidden border-primary/10">
        <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="relative shrink-0">
              <Avatar className="w-16 h-16 ring-2 ring-background shadow-sm">
                {p.avatar_url ? <AvatarImage src={p.avatar_url} alt={p.full_name || p.email || ''} /> : null}
                <AvatarFallback className="bg-primary/15 text-xl font-bold text-primary">
                  {(p.full_name || p.email || '?').charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {p.avatar_url && (
                <button
                  type="button"
                  title={t('admin.users.removeAvatar')}
                  aria-label={t('admin.users.removeAvatar')}
                  disabled={avatarLoading}
                  onClick={() => setAvatarConfirm(true)}
                  className="absolute -top-1 -end-1 h-6 w-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow hover:opacity-90 disabled:opacity-50"
                >
                  {avatarLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold truncate">{p.full_name || '—'}</h1>
                {isBanned
                  ? <Badge variant="destructive">{t('admin.users.blocked')}</Badge>
                  : <Badge variant="secondary">{t('admin.users.active')}</Badge>}
                {currentRoles.map((role: string) => (
                  <Badge key={role} variant={role === 'admin' ? 'destructive' : 'outline'}>{role}</Badge>
                ))}
              </div>
              <button
                onClick={() => copyToClipboard(p.email)}
                className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <Mail className="h-3.5 w-3.5" />
                <span className="truncate">{p.email}</span>
                <Copy className="h-3 w-3 shrink-0" />
              </button>
            </div>
          </div>
        </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2 border-t bg-card/60 p-4">
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setResetConfirm(true)} disabled={resetLinkLoading}>
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
          onClick={() => setBlockConfirm(true)}
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
      </Card>

      <AlertDialog open={resetConfirm} onOpenChange={setResetConfirm}>
        <AlertDialogContent dir={dir} className={dir === 'rtl' ? 'text-right' : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.users.resetLinkConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.users.resetLinkConfirmDesc').replace('{email}', p.email || '')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={dir === 'rtl' ? 'sm:flex-row-reverse sm:justify-start' : undefined}>
            <AlertDialogCancel>{t('admin.users.cancelAction')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSendResetLink}>{t('admin.users.confirmAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={blockConfirm} onOpenChange={setBlockConfirm}>
        <AlertDialogContent dir={dir} className={dir === 'rtl' ? 'text-right' : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isBanned ? t('admin.users.unblockConfirmTitle') : t('admin.users.blockConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isBanned ? t('admin.users.unblockConfirmDesc') : t('admin.users.blockConfirmDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={dir === 'rtl' ? 'sm:flex-row-reverse sm:justify-start' : undefined}>
            <AlertDialogCancel>{t('admin.users.cancelAction')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleToggleBlock}>{t('admin.users.confirmAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={avatarConfirm} onOpenChange={setAvatarConfirm}>
        <AlertDialogContent dir={dir} className={dir === 'rtl' ? 'text-right' : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.users.removeAvatarConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.users.removeAvatarConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={dir === 'rtl' ? 'sm:flex-row-reverse sm:justify-start' : undefined}>
            <AlertDialogCancel>{t('admin.users.cancelAction')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveAvatar}>{t('admin.users.confirmAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Tabs defaultValue="overview" dir={dir} className="space-y-4">
        <TabsList className="w-full flex-wrap justify-start h-auto">
          <TabsTrigger value="overview">{t('admin.users.tabOverview')}</TabsTrigger>
          <TabsTrigger value="access">{t('admin.users.tabAccess')}</TabsTrigger>
          <TabsTrigger value="workspaces">{t('admin.users.tabWorkspaces')}</TabsTrigger>
          <TabsTrigger value="messages">{t('admin.users.tabMessages')}</TabsTrigger>
          <TabsTrigger value="finance">{t('admin.users.tabFinance')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-0">
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

        </TabsContent>

        <TabsContent value="access" className="space-y-4 mt-0">
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

      <AdminPhoneVerificationCard userId={userId} />
        </TabsContent>

        <TabsContent value="workspaces" className="space-y-4 mt-0">
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
        </TabsContent>

        <TabsContent value="messages" className="mt-0">
          <UserMessagesCard userId={userId} />
        </TabsContent>

        <TabsContent value="finance" className="mt-0">
          <UserFinanceCard userId={userId} />
        </TabsContent>
      </Tabs>

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


/* ─── Sent messages (emails + SMS) ─── */
function UserMessagesCard({ userId }: { userId: string }) {
  const { t, dir } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-user-messages', userId],
    queryFn: () => adminGetUserMessages(userId, 100),
    enabled: !!userId,
    retry: false,
  });

  const fmt = (v: string | null) => (v ? format(new Date(v), 'yyyy-MM-dd HH:mm') : '—');
  const statusVariant = (s: string | null) =>
    s === 'sent' || s === 'delivered' ? 'secondary' : s === 'failed' || s === 'error' ? 'destructive' : 'outline';

  return (
    <Card>
      <CardContent className="p-4 space-y-3" dir={dir}>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          {t('admin.users.messagesTitle')}
        </h3>

        {isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        {isError && <p className="text-sm text-destructive">{t('admin.users.messagesLoadFailed')}</p>}

        {data && (
          <Tabs defaultValue="emails" dir={dir}>
            <TabsList>
              <TabsTrigger value="emails">
                {t('admin.users.messagesEmails')} ({data.emails.length})
              </TabsTrigger>
              <TabsTrigger value="sms">
                {t('admin.users.messagesSms')} ({data.sms.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="emails" className="mt-3">
              {data.emails.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">{t('admin.users.messagesNoEmails')}</p>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('admin.users.colSubject')}</TableHead>
                        <TableHead>{t('admin.users.colTemplate')}</TableHead>
                        <TableHead>{t('admin.users.colStatus')}</TableHead>
                        <TableHead>{t('admin.users.colProvider')}</TableHead>
                        <TableHead>{t('admin.users.colSentAt')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.emails.map(m => (
                        <TableRow key={m.id}>
                          <TableCell className="text-sm max-w-[260px] truncate">{m.subject || '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.template_slug || '—'}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(m.status) as any} className="text-xs">{m.status || '—'}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.provider_name || '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmt(m.sent_at || m.created_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="sms" className="mt-3">
              {data.sms.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">{t('admin.users.messagesNoSms')}</p>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('admin.users.colRecipient')}</TableHead>
                        <TableHead>{t('admin.users.colPurpose')}</TableHead>
                        <TableHead>{t('admin.users.colStatus')}</TableHead>
                        <TableHead>{t('admin.users.colProvider')}</TableHead>
                        <TableHead>{t('admin.users.colSentAt')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.sms.map(m => (
                        <TableRow key={m.id}>
                          <TableCell className="text-sm whitespace-nowrap" dir="ltr">{m.phone_masked || '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.purpose || '—'}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(m.delivery_status) as any} className="text-xs">{m.delivery_status || '—'}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.provider_name || '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmt(m.sent_at || m.created_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Financial overview (payments, events, subscriptions, plan changes) ─── */
function DetailDialog({
  open, onClose, title, rows, json,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  rows: { label: string; value: string | null | undefined }[];
  json?: unknown;
}) {
  const { t, dir } = useTranslation();
  const hasJson = json != null && !(typeof json === 'object' && Object.keys(json as object).length === 0);
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto" dir={dir}>
        <DialogHeader className={dir === 'rtl' ? 'text-right sm:text-right' : ''}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {rows.filter(r => r.value).map(r => (
            <div key={r.label} className="flex items-start justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground shrink-0">{r.label}</span>
              <span className="font-medium break-all text-end">{r.value}</span>
            </div>
          ))}
          <div>
            <p className="text-xs text-muted-foreground mb-1">{t('admin.users.detailRaw')}</p>
            {hasJson ? (
              <pre dir="ltr" className="max-h-[40vh] overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                {JSON.stringify(json, null, 2)}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">{t('admin.users.detailNoRaw')}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('admin.users.detailClose')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FinPager({
  total, page, pageSize, onPage, onPageSize,
}: { total: number; page: number; pageSize: number; onPage: (p: number) => void; onPageSize: (n: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{t('admin.users.finShowing', { from: String(from), to: String(to), total: String(total) })}</span>
        <span>·</span>
        <span>{t('admin.users.finPerPage')}</span>
        <select
          className="h-7 rounded-md border bg-background px-1 text-xs"
          value={pageSize}
          onChange={e => { onPageSize(Number(e.target.value)); onPage(1); }}
        >
          {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t('admin.users.finPrev')}
        </Button>
        <span className="text-xs text-muted-foreground">{page} / {pages}</span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t('admin.users.finNext')}
        </Button>
      </div>
    </div>
  );
}

function UserFinanceCard({ userId }: { userId: string }) {
  const { t, dir, locale } = useTranslation();
  const [payPage, setPayPage] = useState(1);
  const [paySize, setPaySize] = useState(20);
  const [evtPage, setEvtPage] = useState(1);
  const [evtSize, setEvtSize] = useState(20);
  const [detail, setDetail] = useState<{ title: string; rows: { label: string; value: string | null | undefined }[]; json?: unknown } | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-user-billing', userId],
    queryFn: () => adminGetUserBilling(userId, 200),
    enabled: !!userId,
    retry: false,
  });

  const fmt = (v: string | null) => (v ? format(new Date(v), 'yyyy-MM-dd HH:mm') : '—');
  const money = (amount: number | null | undefined, currency: string | null | undefined) => {
    const value = (amount ?? 0) / 100;
    const code = (currency || 'USD').toUpperCase();
    const intlLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
    const isRialFamily = ['IRR', 'IRT', 'RIAL', 'TOMAN', 'TMN'].includes(code);
    // Persian UI shows Iranian amounts in Toman (1 Toman = 10 Rial).
    if (locale === 'fa' && isRialFamily) {
      const toman = code === 'IRR' || code === 'RIAL' ? value / 10 : value;
      return `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 }).format(Math.round(toman))} تومان`;
    }
    if (isRialFamily) {
      const label = locale === 'tr' ? 'Toman' : 'Toman';
      const toman = code === 'IRR' || code === 'RIAL' ? value / 10 : value;
      return `${new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 0 }).format(Math.round(toman))} ${label}`;
    }
    // No currency symbols/icons — plain localized number plus the ISO code.
    const formatted = new Intl.NumberFormat(intlLocale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
    if (locale === 'fa') {
      const faCode = code === 'USD' ? 'دلار' : code === 'EUR' ? 'یورو' : code;
      return `${formatted} ${faCode}`;
    }
    return `${formatted} ${code}`;
  };

  const isPaid = (s: string | null) => ['succeeded', 'paid', 'completed', 'success'].includes((s || '').toLowerCase());
  const isRefund = (s: string | null) => ['refunded', 'partially_refunded'].includes((s || '').toLowerCase());
  const statusVariant = (s: string | null) =>
    isPaid(s) ? 'secondary' : isRefund(s) ? 'outline' : ['failed', 'canceled', 'cancelled', 'error'].includes((s || '').toLowerCase()) ? 'destructive' : 'outline';

  if (isLoading) {
    return (
      <Card><CardContent className="p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>
    );
  }
  if (isError || !data) {
    return (
      <Card><CardContent className="p-6"><p className="text-sm text-destructive">{t('admin.users.finLoadFailed')}</p></CardContent></Card>
    );
  }

  const wsName = (id: string) => data.workspaces.find(w => w.id === id)?.name || '—';
  const planName = (id: string | null) => {
    if (!id) return '—';
    const plan = data.plans.find(p => p.id === id);
    if (!plan) return '—';
    const loc = (plan.localized as any)?.[locale]?.name;
    return loc || plan.name;
  };

  const currency = data.payments.find(p => p.currency)?.currency || 'USD';
  const grossPaid = data.payments.filter(p => isPaid(p.status)).reduce((s, p) => s + (p.amount ?? 0), 0);
  const refunded = data.payments.reduce((s, p) => s + (p.refund_amount ?? 0), 0);
  const successCount = data.payments.filter(p => isPaid(p.status)).length;
  const failedCount = data.payments.length - successCount;
  const hasAny = data.payments.length || data.events.length || data.subscriptions.length || data.planChanges.length;

  // Gateway connection overview: configured gateways merged with every
  // provider actually seen in payments / events / subscriptions.
  const gatewayNames = Array.from(new Set([
    ...(data.gateways ?? []).map(g => g.provider_name),
    ...data.payments.map(p => p.provider_name),
    ...data.events.map(e => e.provider_name),
    ...data.subscriptions.map(s => s.provider_name),
  ].filter(Boolean) as string[]));

  const gatewayRows = gatewayNames.map(name => {
    const cfg = (data.gateways ?? []).find(g => g.provider_name === name);
    const pays = data.payments.filter(p => p.provider_name === name);
    const evts = data.events.filter(e => e.provider_name === name);
    const attempts = pays.length + evts.length;
    const success = pays.filter(p => isPaid(p.status)).length + evts.filter(e => isPaid(e.status)).length;
    const failed = attempts - success;
    const lastAt = [...pays.map(p => p.created_at), ...evts.map(e => e.created_at)]
      .filter(Boolean).sort().reverse()[0] as string | undefined;
    const lastErrorItem = [...pays, ...evts].find(x => !isPaid((x as any).status) && (x as any).status);
    const lastError = lastErrorItem
      ? `${(lastErrorItem as any).status}${(lastErrorItem as any).metadata?.error ? ` — ${String((lastErrorItem as any).metadata.error)}` : ''}`
      : null;
    return { name, cfg, attempts, success, failed, lastAt, lastError };
  });

  return (
    <div className="space-y-4" dir={dir}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="border-primary/20 bg-gradient-to-br from-primary/10 to-transparent">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{t('admin.users.finTotalRevenue')}</p>
            <p className="text-xl font-bold mt-1">{money(grossPaid - refunded, currency)}</p>
          </CardContent>
        </Card>
        <StatCard icon={CheckCircle2} label={t('admin.users.finSuccessful')} value={successCount} />
        <StatCard icon={XCircle} label={t('admin.users.finFailed')} value={failedCount} />
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{t('admin.users.finRefunded')}</p>
            <p className="text-xl font-bold mt-1">{money(refunded, currency)}</p>
          </CardContent>
        </Card>
      </div>

      {!hasAny && (
        <Card><CardContent className="p-6"><p className="text-sm text-muted-foreground">{t('admin.users.finNoData')}</p></CardContent></Card>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" /> {t('admin.users.finGateways')}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">{t('admin.users.finGatewaysHint')}</p>
          </div>
          {gatewayRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.users.finNoGateways')}</p>
          ) : (
            <div className="space-y-2">
              {gatewayRows.map(g => (
                <div key={g.name} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium">{g.name}</span>
                    <div className="flex items-center gap-2">
                      {g.cfg ? (
                        <>
                          <Badge variant="outline" className="text-[10px]">{t('admin.users.finGatewayConfigured')}</Badge>
                          <Badge variant={g.cfg.is_active ? 'secondary' : 'outline'} className="text-[10px]">
                            {g.cfg.is_active ? t('admin.users.finGatewayActive') : t('admin.users.finGatewayInactive')}
                          </Badge>
                        </>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">{t('admin.users.finGatewayNotConfigured')}</Badge>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded bg-muted/40 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-muted-foreground">{t('admin.users.finGatewayAttempts')}</span>
                      <span className="font-medium">{g.attempts}</span>
                    </div>
                    <div className="rounded bg-muted/40 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-muted-foreground">{t('admin.users.finGatewaySuccess')}</span>
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">{g.success}</span>
                    </div>
                    <div className="rounded bg-muted/40 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-muted-foreground">{t('admin.users.finGatewayFailed')}</span>
                      <span className="font-medium text-destructive">{g.failed}</span>
                    </div>
                    <div className="rounded bg-muted/40 px-2 py-1.5 flex items-center justify-between">
                      <span className="text-muted-foreground">{t('admin.users.finGatewayLastAttempt')}</span>
                      <span className="font-medium whitespace-nowrap">{fmt(g.lastAt ?? null)}</span>
                    </div>
                  </div>
                  {g.lastError && (
                    <p className="text-[11px] text-destructive break-all">
                      {t('admin.users.finGatewayLastError')}: {g.lastError}
                    </p>
                  )}
                  {g.cfg && g.cfg.config_summary.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[11px] text-muted-foreground">{t('admin.users.finGatewaySettings')}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {g.cfg.config_summary.map(c => (
                          <div key={c.key} className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1 text-[11px]">
                            <span className="text-muted-foreground font-mono">{c.key}</span>
                            <span className="font-medium truncate max-w-[160px]" dir="ltr">{c.value ?? '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data.subscriptions.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" /> {t('admin.users.finSubs')}
            </h3>
            <div className="space-y-2">
              {data.subscriptions.map(s => (
                <div key={s.id} className="rounded-lg border p-3 space-y-1 text-sm">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium">{wsName(s.workspace_id)} — {planName(s.plan_id)}</span>
                    <Badge variant={s.status === 'active' || s.status === 'trialing' ? 'secondary' : 'outline'}>{s.status || '—'}</Badge>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-xs text-muted-foreground">
                    <span>{t('admin.users.finGateway')}: {s.provider_name || '—'}</span>
                    <span>{t('admin.users.finPeriod')}: {fmt(s.current_period_start)} → {fmt(s.current_period_end)}</span>
                    <span>{t('admin.users.finTrialEnd')}: {fmt(s.trial_end)}</span>
                    <span>{t('admin.users.finCancelAtEnd')}: {s.cancel_at_period_end ? '✓' : '—'}</span>
                    {s.provider_subscription_id && <span className="font-mono truncate">{t('admin.users.finRefId')}: {s.provider_subscription_id}</span>}
                    {s.provider_customer_id && <span className="font-mono truncate">customer: {s.provider_customer_id}</span>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data.payments.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" /> {t('admin.users.finPayments')}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">{t('admin.users.finPaymentsHint')}</p>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.users.finDate')}</TableHead>
                    <TableHead>{t('admin.users.finWorkspace')}</TableHead>
                    <TableHead>{t('admin.users.finGateway')}</TableHead>
                    <TableHead>{t('admin.users.finAmount')}</TableHead>
                    <TableHead>{t('admin.users.finRefund')}</TableHead>
                    <TableHead>{t('admin.users.finStatus')}</TableHead>
                    <TableHead>{t('admin.users.finRefId')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.payments.slice((payPage - 1) * paySize, payPage * paySize).map(p => (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => setDetail({
                        title: t('admin.users.finPaymentDetail'),
                        rows: [
                          { label: t('admin.users.finDate'), value: fmt(p.created_at) },
                          { label: t('admin.users.finWorkspace'), value: wsName(p.workspace_id) },
                          { label: t('admin.users.finGateway'), value: p.provider_name },
                          { label: t('admin.users.finAmount'), value: money(p.amount, p.currency) },
                          { label: t('admin.users.finRefund'), value: p.refund_amount ? money(p.refund_amount, p.currency) : null },
                          { label: t('admin.users.finStatus'), value: p.status },
                          { label: t('admin.users.finRefId'), value: p.provider_payment_id },
                        ],
                        json: p.metadata,
                      })}
                    >
                      <TableCell className="whitespace-nowrap text-xs">{fmt(p.created_at)}</TableCell>
                      <TableCell className="text-xs">{wsName(p.workspace_id)}</TableCell>
                      <TableCell className="text-xs">{p.provider_name || '—'}</TableCell>
                      <TableCell className="text-xs font-medium">{money(p.amount, p.currency)}</TableCell>
                      <TableCell className="text-xs">{p.refund_amount ? money(p.refund_amount, p.currency) : '—'}</TableCell>
                      <TableCell><Badge variant={statusVariant(p.status) as any}>{p.status || '—'}</Badge></TableCell>
                      <TableCell className="text-[11px] font-mono max-w-[160px] truncate">{p.provider_payment_id || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <FinPager
              total={data.payments.length}
              page={payPage}
              pageSize={paySize}
              onPage={setPayPage}
              onPageSize={setPaySize}
            />
          </CardContent>
        </Card>
      )}

      {data.events.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-muted-foreground" /> {t('admin.users.finEvents')}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">{t('admin.users.finEventsHint')}</p>
            </div>
            <div className="space-y-2">
              {data.events.slice((evtPage - 1) * evtSize, evtPage * evtSize).map(e => (
                <div
                  key={e.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetail({
                    title: t('admin.users.finEventDetail'),
                    rows: [
                      { label: t('admin.users.finDate'), value: fmt(e.created_at) },
                      { label: t('admin.users.finWorkspace'), value: wsName(e.workspace_id) },
                      { label: t('admin.users.finGateway'), value: e.provider_name },
                      { label: t('admin.users.finStatus'), value: e.status },
                      { label: t('admin.users.finRefId'), value: e.provider_event_id },
                      { label: t('admin.users.finAmount'), value: e.amount != null ? money(e.amount, e.currency) : null },
                    ],
                    json: e.metadata,
                  })}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{e.event_type || '—'}</p>
                    <p className="text-muted-foreground truncate">
                      {wsName(e.workspace_id)} · {e.provider_name || '—'}
                      {e.provider_event_id ? ` · ${e.provider_event_id}` : ''}
                    </p>
                  </div>
                  <div className="text-end shrink-0 space-y-1">
                    {e.amount != null && <p className="font-medium">{money(e.amount, e.currency)}</p>}
                    <Badge variant={statusVariant(e.status) as any}>{e.status || '—'}</Badge>
                    <p className="text-muted-foreground">{fmt(e.created_at)}</p>
                  </div>
                </div>
              ))}
            </div>
            <FinPager
              total={data.events.length}
              page={evtPage}
              pageSize={evtSize}
              onPage={setEvtPage}
              onPageSize={setEvtSize}
            />
          </CardContent>
        </Card>
      )}

      {data.planChanges.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" /> {t('admin.users.finPlanChanges')}
            </h3>
            <div className="space-y-2">
              {data.planChanges.map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs flex-wrap">
                  <span>
                    <span className="text-muted-foreground">{t('admin.users.finFrom')}:</span> {planName(c.old_plan_id)}{' '}
                    <span className="text-muted-foreground">{t('admin.users.finTo')}:</span> {planName(c.new_plan_id)}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{c.change_type || '—'}</Badge>
                    <span className="text-muted-foreground">{wsName(c.workspace_id)}</span>
                    <span className="text-muted-foreground">{fmt(c.created_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <DetailDialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.title || ''}
        rows={detail?.rows || []}
        json={detail?.json}
      />
    </div>
  );
}
