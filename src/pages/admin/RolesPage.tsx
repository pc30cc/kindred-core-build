import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import {
  Shield, Users, UserCog, Loader2, Trash2, CheckCircle2, Plus,
} from 'lucide-react';

const roleLabelsMap: Record<string, Record<string, string>> = {
  fa: { admin: 'سوپر ادمین', moderator: 'مدیر', user: 'کاربر' },
  en: { admin: 'Super Admin', moderator: 'Moderator', user: 'User' },
};

const roleCategoriesMap: Record<string, { title: string; roles: string[] }[]> = {
  fa: [
    { title: 'سطح پلتفرم', roles: ['admin'] },
    { title: 'سطح مدیریت', roles: ['moderator'] },
    { title: 'سطح کاربری', roles: ['user'] },
  ],
  en: [
    { title: 'Platform Level', roles: ['admin'] },
    { title: 'Management Level', roles: ['moderator'] },
    { title: 'User Level', roles: ['user'] },
  ],
};

export default function AdminRolesPage() {
  const { dir, locale } = useTranslation();
  const isRtl = dir === 'rtl';
  const roleLabels = roleLabelsMap[locale] || roleLabelsMap.en;
  const roleCategories = roleCategoriesMap[locale] || roleCategoriesMap.en;
  const queryClient = useQueryClient();

  const [targetUserId, setTargetUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState('user');

  const { data: allRoles = [], isLoading } = useQuery({
    queryKey: ['admin-all-roles'],
    queryFn: async () => {
      const { data } = await supabase.from('user_roles').select('*').order('role');
      if (!data) return [];
      const ids = [...new Set(data.map(r => r.user_id))];
      if (ids.length === 0) return data.map(r => ({ ...r, userName: r.user_id.slice(0, 8), email: '' }));
      const { data: profiles } = await supabase.rpc('admin_list_profiles', { _limit: 200, _offset: 0 });
      return data.map(r => {
        const p = (profiles || []).find((pr: any) => pr.id === r.user_id);
        return { ...r, userName: p?.full_name || r.user_id.slice(0, 8), email: p?.email || '' };
      });
    },
  });

  const assignRole = useMutation({
    mutationFn: async () => {
      if (!targetUserId.trim()) throw new Error(isRtl ? 'شناسه کاربر الزامی است' : 'User ID is required');
      const { error } = await supabase.from('user_roles')
        .upsert({ user_id: targetUserId.trim(), role: selectedRole as any }, { onConflict: 'user_id,role' });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(isRtl ? 'نقش اختصاص یافت' : 'Role assigned');
      setTargetUserId('');
      queryClient.invalidateQueries({ queryKey: ['admin-all-roles'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const removeRole = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('user_roles').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(isRtl ? 'نقش حذف شد' : 'Role removed');
      queryClient.invalidateQueries({ queryKey: ['admin-all-roles'] });
    },
  });

  const L = {
    title: isRtl ? 'مدیریت نقش‌ها' : 'Role Management',
    assignNew: isRtl ? 'اختصاص نقش جدید' : 'Assign New Role',
    userId: isRtl ? 'شناسه کاربر (UUID)' : 'User ID (UUID)',
    role: isRtl ? 'نقش' : 'Role',
    assign: isRtl ? 'اختصاص' : 'Assign',
    roleMatrix: isRtl ? 'ماتریس دسترسی نقش‌ها' : 'Role Access Matrix',
    activeRoles: isRtl ? 'نقش‌های فعال' : 'Active Roles',
  };

  return (
    <div className="space-y-6" dir={dir}>
      <h1 className="text-2xl font-bold text-foreground">{L.title}</h1>

      {/* Assign new role */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h3 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <UserCog className="w-4 h-4 text-primary" /> {L.assignNew}
          </h3>
          <div className={`grid grid-cols-3 gap-3 ${isRtl ? '' : ''}`}>
            <div className="space-y-1.5">
              <Label className="text-xs">{L.userId}</Label>
              <Input
                value={targetUserId}
                onChange={e => setTargetUserId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-..."
                dir="ltr"
                className="text-left font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{L.role}</Label>
              <select
                value={selectedRole}
                onChange={e => setSelectedRole(e.target.value)}
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                dir={dir}
              >
                {Object.entries(roleLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <Button
                onClick={() => assignRole.mutate()}
                disabled={assignRole.isPending || !targetUserId}
                className="w-full gap-1.5"
              >
                {assignRole.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCog className="w-4 h-4" />}
                {L.assign}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Role matrix */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h3 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <Shield className="w-4 h-4 text-primary" /> {L.roleMatrix}
          </h3>
          <div className="space-y-4">
            {roleCategories.map(cat => (
              <div key={cat.title}>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2">{cat.title}</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {cat.roles.map(r => {
                    const count = allRoles.filter((ar: any) => ar.role === r).length;
                    return (
                      <div key={r} className={`flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/20 border border-border/50 ${isRtl ? 'flex-row-reverse' : ''}`}>
                        <span className="text-xs text-foreground">{roleLabels[r] || r}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Active roles list */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h3 className={`text-sm font-semibold text-foreground flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <Users className="w-4 h-4 text-primary" /> {L.activeRoles} ({allRoles.length})
          </h3>
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : allRoles.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              {isRtl ? 'هیچ نقشی وجود ندارد' : 'No roles found'}
            </p>
          ) : (
            <div className="space-y-1.5">
              {allRoles.map((r: any) => (
                <div key={r.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/20 ${isRtl ? 'flex-row-reverse' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-foreground">{r.userName}</span>
                    {r.email && <span className="text-[10px] text-muted-foreground font-mono mx-2" dir="ltr">{r.email}</span>}
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${r.role === 'admin' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
                    {roleLabels[r.role] || r.role}
                  </span>
                  <button
                    onClick={() => removeRole.mutate(r.id)}
                    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
