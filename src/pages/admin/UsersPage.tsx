import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Search, Edit, Ban, CheckCircle2, ShieldCheck, ShieldOff,
  User, AtSign, Phone, Calendar, Shield, Building2, Key, KeyRound,
  Loader2, Save, Plus, Trash2, Clock, Users, AlertTriangle, Eye, X,
} from 'lucide-react';

/* ── Role labels (fa/en) ── */
const roleLabelsMap: Record<string, Record<string, string>> = {
  fa: { admin: 'سوپر ادمین', moderator: 'مدیر', user: 'کاربر' },
  en: { admin: 'Super Admin', moderator: 'Moderator', user: 'User' },
};

function useAdminUsersData() {
  return useQuery({
    queryKey: ['admin-users-full'],
    queryFn: async () => {
      // Fetch profiles
      const { data: profiles, error: pErr } = await supabase.rpc('admin_list_profiles', { _limit: 200, _offset: 0 });
      if (pErr) throw pErr;

      const ids = (profiles || []).map((p: any) => p.id);
      if (ids.length === 0) return [];

      // Fetch roles
      const { data: roles } = await supabase.from('user_roles').select('*').in('user_id', ids);
      // Fetch workspace memberships
      const { data: members } = await supabase.from('workspace_members').select('user_id, workspace_id, role');
      // Fetch auth data from edge function
      const { data: authData, error: authErr } = await supabase.functions.invoke('admin-actions', {
        body: { action: 'list_users' },
      });
      const authUsers = authErr ? [] : (authData?.users || []);

      return (profiles || []).map((p: any) => {
        const authUser = authUsers.find((au: any) => au.id === p.id);
        return {
          ...p,
          email: authUser?.email || p.email || '',
          banned_until: authUser?.banned_until,
          last_sign_in_at: authUser?.last_sign_in_at,
          email_confirmed_at: authUser?.email_confirmed_at,
          phone: authUser?.phone,
          roles: roles?.filter((r: any) => r.user_id === p.id) || [],
          workspaces: members?.filter((m: any) => m.user_id === p.id) || [],
        };
      });
    },
  });
}

export default function AdminUsersPage() {
  const { t, dir, locale } = useTranslation();
  const isRtl = dir === 'rtl';
  const roleLabels = roleLabelsMap[locale] || roleLabelsMap.en;
  const queryClient = useQueryClient();

  const { data: users = [], isLoading } = useAdminUsersData();

  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState<'all' | 'unconfirmed'>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any>(null);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [addingRole, setAddingRole] = useState(false);
  const [newRoleToAdd, setNewRoleToAdd] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Create user state
  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const isBanned = (user: any) => {
    if (!user.banned_until) return false;
    return new Date(user.banned_until) > new Date();
  };

  const isUnconfirmed = (u: any) => !u.email_confirmed_at;

  const unconfirmedCount = users.filter(isUnconfirmed).length;

  const filtered = users.filter((u: any) => {
    const matchesSearch = u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      u.email?.toLowerCase().includes(search.toLowerCase()) ||
      u.id?.includes(search);
    if (!matchesSearch) return false;
    if (userFilter === 'unconfirmed') return isUnconfirmed(u);
    return true;
  });

  const openUserDialog = (user: any) => {
    setSelectedUser(user);
    setEditName(user.full_name || '');
    setEditPhone(user.phone || '');
    setAddingRole(false);
    setNewRoleToAdd('');
    setNewPassword('');
    setDialogOpen(true);
  };

  const handleSaveProfile = async () => {
    if (!selectedUser) return;
    setActionLoading('save-profile');
    try {
      const { error } = await supabase.from('profiles').update({
        full_name: editName,
      }).eq('id', selectedUser.id);
      if (error) throw error;
      toast.success(isRtl ? 'پروفایل به‌روز شد' : 'Profile updated');
      queryClient.invalidateQueries({ queryKey: ['admin-users-full'] });
      setSelectedUser({ ...selectedUser, full_name: editName });
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleResetPassword = async () => {
    if (!selectedUser?.email) return;
    setActionLoading('reset-pw');
    try {
      const { data, error } = await supabase.functions.invoke('admin-actions', {
        body: { action: 'reset_password', userId: selectedUser.id, email: selectedUser.email },
      });
      if (error || data?.error) throw new Error(data?.error || 'Error');
      toast.success(isRtl ? 'لینک ریست پسورد ایجاد شد' : 'Password reset link generated');
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleUpdatePassword = async () => {
    if (!selectedUser || !newPassword || newPassword.length < 6) {
      toast.error(isRtl ? 'رمز عبور باید حداقل ۶ کاراکتر باشد' : 'Password must be at least 6 characters');
      return;
    }
    setActionLoading('update-pw');
    try {
      const { data, error } = await supabase.functions.invoke('admin-actions', {
        body: { action: 'update_password', userId: selectedUser.id, password: newPassword },
      });
      if (error || data?.error) throw new Error(data?.error || 'Error');
      toast.success(isRtl ? 'رمز عبور تغییر کرد' : 'Password changed');
      setNewPassword('');
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleToggleDisable = async () => {
    if (!selectedUser) return;
    const disable = !isBanned(selectedUser);
    setActionLoading('toggle-ban');
    try {
      const { data, error } = await supabase.functions.invoke('admin-actions', {
        body: { action: 'disable_user', userId: selectedUser.id, disable },
      });
      if (error || data?.error) throw new Error(data?.error || 'Error');
      toast.success(disable
        ? (isRtl ? 'کاربر غیرفعال شد' : 'User disabled')
        : (isRtl ? 'کاربر فعال شد' : 'User enabled'));
      setSelectedUser({ ...selectedUser, banned_until: disable ? new Date(Date.now() + 100 * 365 * 86400000).toISOString() : null });
      queryClient.invalidateQueries({ queryKey: ['admin-users-full'] });
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleConfirmEmail = async (u?: any) => {
    const user = u || selectedUser;
    if (!user) return;
    setActionLoading(`confirm-email-${user.id}`);
    try {
      const { data, error } = await supabase.functions.invoke('admin-actions', {
        body: { action: 'confirm_email', userId: user.id },
      });
      if (error || data?.error) throw new Error(data?.error || 'Error');
      toast.success(isRtl ? 'ایمیل تأیید شد' : 'Email confirmed');
      queryClient.invalidateQueries({ queryKey: ['admin-users-full'] });
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleRemoveRole = async (role: string) => {
    if (!selectedUser) return;
    setActionLoading(`rm-role-${role}`);
    try {
      const { error } = await supabase.from('user_roles').delete()
        .eq('user_id', selectedUser.id).eq('role', role as "admin" | "moderator" | "user");
      if (error) throw error;
      toast.success(isRtl ? 'نقش حذف شد' : 'Role removed');
      setSelectedUser({ ...selectedUser, roles: selectedUser.roles.filter((r: any) => r.role !== role) });
      queryClient.invalidateQueries({ queryKey: ['admin-users-full'] });
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleAddRole = async () => {
    if (!selectedUser || !newRoleToAdd) return;
    setActionLoading('add-role');
    try {
      const { error } = await supabase.from('user_roles')
        .upsert({ user_id: selectedUser.id, role: newRoleToAdd as "admin" | "moderator" | "user" }, { onConflict: 'user_id,role' });
      if (error) throw error;
      toast.success(isRtl ? 'نقش اضافه شد' : 'Role added');
      setSelectedUser({ ...selectedUser, roles: [...selectedUser.roles, { role: newRoleToAdd, user_id: selectedUser.id }] });
      setNewRoleToAdd('');
      setAddingRole(false);
      queryClient.invalidateQueries({ queryKey: ['admin-users-full'] });
    } catch (e: any) { toast.error(e.message); }
    setActionLoading(null);
  };

  const handleCreateUser = async () => {
    if (!createEmail || !createPassword) return;
    setCreateLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-actions', {
        body: { action: 'create_user', email: createEmail, password: createPassword, fullName: createName, emailConfirm: true },
      });
      if (error || data?.error) throw new Error(data?.error || 'Error');
      toast.success(isRtl ? 'کاربر ایجاد شد' : 'User created');
      setCreateEmail('');
      setCreateName('');
      setCreatePassword('');
      setCreateDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['admin-users-full'] });
    } catch (e: any) { toast.error(e.message); }
    setCreateLoading(false);
  };

  const L = {
    title: isRtl ? 'مدیریت کاربران' : 'User Management',
    allUsers: isRtl ? 'همه کاربران' : 'All Users',
    unconfirmed: isRtl ? 'تأیید نشده' : 'Unconfirmed',
    searchPlaceholder: isRtl ? 'جستجوی کاربر (نام، ایمیل)...' : 'Search users (name, email)...',
    user: isRtl ? 'کاربر' : 'User',
    email: isRtl ? 'ایمیل' : 'Email',
    roles: isRtl ? 'نقش‌ها' : 'Roles',
    workspaces: isRtl ? 'فضای کاری' : 'Workspaces',
    status: isRtl ? 'وضعیت' : 'Status',
    lastLogin: isRtl ? 'آخرین ورود' : 'Last Login',
    actions: isRtl ? 'عملیات' : 'Actions',
    editUser: isRtl ? 'ویرایش کاربر' : 'Edit User',
    editDesc: isRtl ? 'مشاهده و ویرایش اطلاعات کاربر' : 'View and edit user information',
    profileInfo: isRtl ? 'اطلاعات پروفایل' : 'Profile Information',
    fullName: isRtl ? 'نام کامل' : 'Full Name',
    phone: isRtl ? 'تلفن' : 'Phone',
    joinDate: isRtl ? 'تاریخ عضویت' : 'Joined',
    saveChanges: isRtl ? 'ذخیره تغییرات' : 'Save Changes',
    rolesAccess: isRtl ? 'نقش‌ها و دسترسی' : 'Roles & Access',
    addRole: isRtl ? 'افزودن نقش' : 'Add Role',
    selectRole: isRtl ? 'انتخاب نقش...' : 'Select role...',
    noRoles: isRtl ? 'هیچ نقشی اختصاص نیافته' : 'No roles assigned',
    workspacesTitle: isRtl ? 'فضاهای کاری' : 'Workspaces',
    noWorkspaces: isRtl ? 'عضو هیچ فضای کاری نیست' : 'Not a member of any workspace',
    authInfo: isRtl ? 'اطلاعات احراز هویت' : 'Authentication Info',
    lastLoginAt: isRtl ? 'آخرین ورود' : 'Last Sign In',
    neverLoggedIn: isRtl ? 'هنوز وارد نشده' : 'Never logged in',
    emailConfirm: isRtl ? 'تأیید ایمیل' : 'Email Confirmation',
    confirmed: isRtl ? 'تأیید شده' : 'Confirmed',
    pending: isRtl ? 'در انتظار' : 'Pending',
    changePassword: isRtl ? 'تغییر رمز عبور' : 'Change Password',
    newPassword: isRtl ? 'رمز عبور جدید' : 'New Password',
    updatePassword: isRtl ? 'تغییر رمز' : 'Update',
    resetPassword: isRtl ? 'ریست پسورد' : 'Reset Password',
    confirmEmailBtn: isRtl ? 'تأیید ایمیل' : 'Confirm Email',
    emailNotConfirmed: isRtl ? 'ایمیل تأیید نشده' : 'Email not confirmed',
    emailConfirmed: isRtl ? 'ایمیل تأیید شده' : 'Email confirmed',
    disabled: isRtl ? 'غیرفعال' : 'Disabled',
    accountActive: isRtl ? 'حساب فعال' : 'Account Active',
    accountDisabled: isRtl ? 'حساب غیرفعال' : 'Account Disabled',
    enable: isRtl ? 'فعال کردن' : 'Enable',
    disable: isRtl ? 'غیرفعال کردن' : 'Disable',
    enableAccount: isRtl ? 'فعال کردن حساب' : 'Enable Account',
    disableAccount: isRtl ? 'غیرفعال کردن حساب' : 'Disable Account',
    edit: isRtl ? 'ویرایش' : 'Edit',
    noName: isRtl ? 'بدون نام' : 'No name',
    addUser: isRtl ? 'افزودن کاربر' : 'Add User',
    createUser: isRtl ? 'ایجاد کاربر جدید' : 'Create New User',
    createDesc: isRtl ? 'کاربر جدید به سیستم اضافه کنید' : 'Add a new user to the system',
    password: isRtl ? 'رمز عبور' : 'Password',
    create: isRtl ? 'ایجاد' : 'Create',
    spaces: isRtl ? 'فضا' : 'spaces',
    cancel: isRtl ? 'لغو' : 'Cancel',
  };

  const wsRoleLabels: Record<string, string> = isRtl
    ? { owner: 'مالک', admin: 'مدیر', agent: 'اپراتور', viewer: 'بیننده' }
    : { owner: 'Owner', admin: 'Admin', agent: 'Agent', viewer: 'Viewer' };

  return (
    <div className="space-y-6" dir={dir}>
      <div className={`flex items-center justify-between ${isRtl ? 'flex-row-reverse' : ''}`}>
        <h1 className="text-2xl font-bold text-foreground">{L.title}</h1>
        <Button onClick={() => setCreateDialogOpen(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          {L.addUser}
        </Button>
      </div>

      {/* Filter tabs */}
      <div className={`flex items-center gap-2 flex-wrap ${isRtl ? 'flex-row-reverse' : ''}`}>
        <button
          onClick={() => setUserFilter('all')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            userFilter === 'all' ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary border border-border/50'
          }`}
        >
          <Users className="w-3.5 h-3.5" /> {L.allUsers} ({users.length})
        </button>
        <button
          onClick={() => setUserFilter('unconfirmed')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            userFilter === 'unconfirmed' ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary border border-border/50'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5" /> {L.unconfirmed} ({unconfirmedCount})
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className={`absolute ${isRtl ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground`} />
        <Input
          placeholder={L.searchPlaceholder}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={isRtl ? 'pr-10' : 'pl-10'}
          dir={dir}
        />
      </div>

      {/* Users table */}
      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.user}</th>
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.email}</th>
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.roles}</th>
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.workspaces}</th>
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.status}</th>
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.lastLogin}</th>
                    <th className={`${isRtl ? 'text-right' : 'text-left'} px-4 py-2.5 text-[11px] font-semibold text-muted-foreground`}>{L.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {filtered.map((u: any) => (
                    <tr key={u.id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => openUserDialog(u)}>
                      <td className="px-4 py-3">
                        <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                            {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-foreground">{u.full_name || L.noName}</div>
                            <div className="text-[10px] text-muted-foreground font-mono" dir="ltr">{u.id.slice(0, 8)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground font-mono" dir="ltr">{u.email || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.length > 0 ? u.roles.slice(0, 2).map((r: any) => (
                            <span key={r.role} className={`text-[10px] px-2 py-0.5 rounded-full ${r.role === 'admin' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
                              {roleLabels[r.role] || r.role}
                            </span>
                          )) : <span className="text-[10px] text-muted-foreground">—</span>}
                          {u.roles.length > 2 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">+{u.roles.length - 2}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {u.workspaces.length > 0 ? `${u.workspaces.length} ${L.spaces}` : '—'}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex flex-col gap-1">
                          {!u.email_confirmed_at ? (
                            <button
                              onClick={() => handleConfirmEmail(u)}
                              disabled={actionLoading === `confirm-email-${u.id}`}
                              className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors w-fit flex items-center gap-1"
                            >
                              {actionLoading === `confirm-email-${u.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <AtSign className="w-3 h-3" />}
                              {L.emailNotConfirmed}
                            </button>
                          ) : (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 w-fit">{L.emailConfirmed}</span>
                          )}
                          {isBanned(u) && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive w-fit">{L.disabled}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground" dir="ltr">
                        {u.last_sign_in_at ? format(new Date(u.last_sign_in_at), 'yyyy-MM-dd') : '—'}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" onClick={() => openUserDialog(u)} className="h-7 px-2.5 text-[10px] gap-1">
                          <Edit className="w-3 h-3" /> {L.edit}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── User Detail/Edit Dialog ── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-border" dir={dir}>
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-3 ${isRtl ? 'flex-row-reverse text-right' : ''}`}>
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary shrink-0">
                {(selectedUser?.full_name || selectedUser?.email || '?').charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">{selectedUser?.full_name || L.noName}</div>
                <div className="text-xs text-muted-foreground font-mono font-normal" dir="ltr">{selectedUser?.id}</div>
              </div>
            </DialogTitle>
            <DialogDescription className={isRtl ? 'text-right' : ''}>{L.editDesc}</DialogDescription>
          </DialogHeader>

          {selectedUser && (
            <div className="space-y-6 mt-2">
              {/* Status Banner */}
              <div className={`flex items-center justify-between px-4 py-3 rounded-lg border ${
                isBanned(selectedUser) ? 'bg-destructive/5 border-destructive/20' : 'bg-emerald-500/5 border-emerald-500/20'
              } ${isRtl ? 'flex-row-reverse' : ''}`}>
                <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  {isBanned(selectedUser) ? <ShieldOff className="w-4 h-4 text-destructive" /> : <ShieldCheck className="w-4 h-4 text-emerald-500" />}
                  <span className={`text-sm font-medium ${isBanned(selectedUser) ? 'text-destructive' : 'text-emerald-500'}`}>
                    {isBanned(selectedUser) ? L.accountDisabled : L.accountActive}
                  </span>
                </div>
                <Button
                  variant={isBanned(selectedUser) ? 'default' : 'destructive'}
                  size="sm"
                  onClick={handleToggleDisable}
                  disabled={actionLoading === 'toggle-ban'}
                  className="h-8 text-xs"
                >
                  {actionLoading === 'toggle-ban' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isBanned(selectedUser) ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                  <span className={isRtl ? 'mr-1' : 'ml-1'}>{isBanned(selectedUser) ? L.enableAccount : L.disableAccount}</span>
                </Button>
              </div>

              {/* Profile Info */}
              <div className="space-y-3">
                <h4 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <User className="w-4 h-4 text-primary" /> {L.profileInfo}
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className={`text-xs flex items-center gap-1.5 ${isRtl ? 'flex-row-reverse' : ''}`}><User className="w-3 h-3" /> {L.fullName}</Label>
                    <Input value={editName} onChange={e => setEditName(e.target.value)} dir={dir} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className={`text-xs flex items-center gap-1.5 ${isRtl ? 'flex-row-reverse' : ''}`}><AtSign className="w-3 h-3" /> {L.email}</Label>
                    <Input value={selectedUser.email} disabled dir="ltr" className="text-left bg-muted/50 cursor-not-allowed" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className={`text-xs flex items-center gap-1.5 ${isRtl ? 'flex-row-reverse' : ''}`}><Calendar className="w-3 h-3" /> {L.joinDate}</Label>
                    <Input value={selectedUser.created_at ? format(new Date(selectedUser.created_at), 'yyyy-MM-dd') : '—'} disabled className="bg-muted/50 cursor-not-allowed" dir="ltr" />
                  </div>
                </div>
                <Button size="sm" onClick={handleSaveProfile} disabled={actionLoading === 'save-profile'} className="h-8 text-xs gap-1.5">
                  {actionLoading === 'save-profile' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  {L.saveChanges}
                </Button>
              </div>

              {/* Roles Section */}
              <div className="space-y-3">
                <div className={`flex items-center justify-between ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <h4 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                    <Shield className="w-4 h-4 text-primary" /> {L.rolesAccess}
                  </h4>
                  <Button variant="outline" size="sm" onClick={() => setAddingRole(true)} className="h-7 text-[11px] gap-1">
                    <Plus className="w-3 h-3" /> {L.addRole}
                  </Button>
                </div>
                <div className="space-y-2">
                  {selectedUser.roles.length === 0 && !addingRole && (
                    <p className="text-xs text-muted-foreground py-3 text-center bg-secondary/20 rounded-lg">{L.noRoles}</p>
                  )}
                  {selectedUser.roles.map((r: any) => (
                    <div key={r.role} className={`flex items-center justify-between px-4 py-2.5 rounded-lg bg-secondary/30 border border-border/50 ${isRtl ? 'flex-row-reverse' : ''}`}>
                      <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                        <Shield className="w-3.5 h-3.5 text-primary" />
                        <span className="text-sm text-foreground">{roleLabels[r.role] || r.role}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">({r.role})</span>
                      </div>
                      <button
                        onClick={() => handleRemoveRole(r.role)}
                        disabled={actionLoading === `rm-role-${r.role}`}
                        className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `rm-role-${r.role}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  ))}
                  {addingRole && (
                    <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary/5 border border-primary/20 ${isRtl ? 'flex-row-reverse' : ''}`}>
                      <select
                        value={newRoleToAdd}
                        onChange={e => setNewRoleToAdd(e.target.value)}
                        className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm"
                        dir={dir}
                      >
                        <option value="">{L.selectRole}</option>
                        {Object.entries(roleLabels)
                          .filter(([k]) => !selectedUser.roles.some((r: any) => r.role === k))
                          .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <Button size="sm" onClick={handleAddRole} disabled={!newRoleToAdd || actionLoading === 'add-role'} className="h-8 text-xs">
                        {actionLoading === 'add-role' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setAddingRole(false); setNewRoleToAdd(''); }} className="h-8 text-xs">{L.cancel}</Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Workspaces Section */}
              <div className="space-y-3">
                <h4 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <Building2 className="w-4 h-4 text-primary" /> {L.workspacesTitle}
                </h4>
                {selectedUser.workspaces.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center bg-secondary/20 rounded-lg">{L.noWorkspaces}</p>
                ) : (
                  <div className="space-y-2">
                    {selectedUser.workspaces.map((ws: any, i: number) => (
                      <div key={i} className={`flex items-center justify-between px-4 py-2.5 rounded-lg bg-secondary/30 border border-border/50 ${isRtl ? 'flex-row-reverse' : ''}`}>
                        <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                          <Building2 className="w-3.5 h-3.5 text-blue-500" />
                          <span className="text-sm text-foreground font-mono text-xs" dir="ltr">{ws.workspace_id?.slice(0, 8)}</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500">
                          {wsRoleLabels[ws.role] || ws.role}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Auth Details */}
              <div className="space-y-3">
                <h4 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <Key className="w-4 h-4 text-primary" /> {L.authInfo}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="px-4 py-3 rounded-lg bg-secondary/20 border border-border/50">
                    <div className="text-[10px] text-muted-foreground mb-1">{L.lastLoginAt}</div>
                    <div className="text-sm text-foreground" dir="ltr">
                      {selectedUser.last_sign_in_at ? format(new Date(selectedUser.last_sign_in_at), 'yyyy-MM-dd HH:mm') : L.neverLoggedIn}
                    </div>
                  </div>
                  <div className="px-4 py-3 rounded-lg bg-secondary/20 border border-border/50">
                    <div className="text-[10px] text-muted-foreground mb-1">{L.emailConfirm}</div>
                    <div className={`text-sm text-foreground flex items-center gap-1.5 ${isRtl ? 'flex-row-reverse' : ''}`}>
                      {selectedUser.email_confirmed_at
                        ? <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> {L.confirmed}</>
                        : <><Clock className="w-3.5 h-3.5 text-amber-500" /> {L.pending}</>}
                    </div>
                  </div>
                </div>
              </div>

              {/* Change Password */}
              <div className="space-y-3">
                <h4 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <KeyRound className="w-4 h-4 text-primary" /> {L.changePassword}
                </h4>
                <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <Input
                    type="password"
                    placeholder={L.newPassword}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="max-w-xs"
                    dir="ltr"
                  />
                  <Button size="sm" onClick={handleUpdatePassword} disabled={actionLoading === 'update-pw' || !newPassword} className="h-9 text-xs gap-1.5">
                    {actionLoading === 'update-pw' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                    {L.updatePassword}
                  </Button>
                </div>
              </div>

              {/* Actions Footer */}
              <div className={`flex items-center gap-2 pt-3 border-t border-border flex-wrap ${isRtl ? 'flex-row-reverse' : ''}`}>
                <Button variant="outline" size="sm" onClick={handleResetPassword} disabled={actionLoading === 'reset-pw'} className="h-9 text-xs gap-1.5">
                  {actionLoading === 'reset-pw' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  {L.resetPassword}
                </Button>
                {!selectedUser.email_confirmed_at && (
                  <Button variant="outline" size="sm" onClick={() => handleConfirmEmail()} disabled={actionLoading === `confirm-email-${selectedUser.id}`} className="h-9 text-xs gap-1.5 text-amber-500 border-amber-500/30 hover:bg-amber-500/10">
                    {actionLoading === `confirm-email-${selectedUser.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AtSign className="w-3.5 h-3.5" />}
                    {L.confirmEmailBtn}
                  </Button>
                )}
                <Button
                  variant={isBanned(selectedUser) ? 'default' : 'destructive'}
                  size="sm"
                  onClick={handleToggleDisable}
                  disabled={actionLoading === 'toggle-ban'}
                  className="h-9 text-xs gap-1.5"
                >
                  {actionLoading === 'toggle-ban' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isBanned(selectedUser) ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                  {isBanned(selectedUser) ? L.enableAccount : L.disableAccount}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Create User Dialog ── */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md bg-card border-border" dir={dir}>
          <DialogHeader>
            <DialogTitle className={isRtl ? 'text-right' : ''}>{L.createUser}</DialogTitle>
            <DialogDescription className={isRtl ? 'text-right' : ''}>{L.createDesc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{L.fullName}</Label>
              <Input value={createName} onChange={e => setCreateName(e.target.value)} dir={dir} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{L.email}</Label>
              <Input type="email" value={createEmail} onChange={e => setCreateEmail(e.target.value)} dir="ltr" className="text-left" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{L.password}</Label>
              <Input type="password" value={createPassword} onChange={e => setCreatePassword(e.target.value)} dir="ltr" className="text-left" />
            </div>
          </div>
          <DialogFooter className={isRtl ? 'flex-row-reverse' : ''}>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>{L.cancel}</Button>
            <Button onClick={handleCreateUser} disabled={createLoading || !createEmail || !createPassword} className="gap-1.5">
              {createLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {L.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
