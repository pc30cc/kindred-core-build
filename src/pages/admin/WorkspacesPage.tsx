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
  useAdminWorkspaceDetail, useAdminDeleteWorkspace,
} from '@/hooks/useAdmin';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Building2, Users, MessageSquare, BookUser, Trash2,
  Globe, Palette, Bot, Loader2, Shield, ArrowLeft,
  Mail, Calendar, MapPin, MonitorSmartphone, Copy, Search,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

export default function AdminWorkspacesPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [phoneFilter, setPhoneFilter] = useState<'all' | 'verified' | 'unverified'>('all');
  const deferredSearch = useDeferredValue(search);
  const [limit, setLimit] = useState(30);
  const { data: allWorkspaces, isLoading } = useAdminWorkspaces(limit, page * limit, deferredSearch, sort);
  const workspaces = allWorkspaces?.filter(w =>
    phoneFilter === 'all'
      ? true
      : phoneFilter === 'verified'
        ? Boolean((w as any).owner_phone_verified)
        : !(w as any).owner_phone_verified,
  );
  const { data: count } = useAdminWorkspaceCount();

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
      toast.success('Workspace deleted successfully');
      setDeleteId(null);
      setDeleteConfirm('');
      if (selectedId === deleteId) setSelectedId(null);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete workspace');
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
        <h1 className="text-2xl font-bold text-foreground">Workspaces</h1>
        <span className="text-sm text-muted-foreground">{count ?? 0} total</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, slug or email..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="pl-9"
          />
        </div>
        <Select value={phoneFilter} onValueChange={v => { setPhoneFilter(v as typeof phoneFilter); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.users.filterPhoneAll')}</SelectItem>
            <SelectItem value="verified">{t('admin.users.filterPhoneVerified')}</SelectItem>
            <SelectItem value="unverified">{t('admin.users.filterPhoneUnverified')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={v => { setSort(v); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="most_members">Most members</SelectItem>
            <SelectItem value="most_active">Most active</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={v => { setLimit(Number(v)); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10 per page</SelectItem>
            <SelectItem value="20">20 per page</SelectItem>
            <SelectItem value="30">30 per page</SelectItem>
            <SelectItem value="50">50 per page</SelectItem>
            <SelectItem value="100">100 per page</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>{t('admin.users.colOwnerPhone')}</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Created</TableHead>
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
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No workspaces found</TableCell>
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
                    <div className="flex items-center gap-2">
                      <Badge variant={(w as any).owner_phone_verified ? 'default' : 'secondary'} className="text-xs">
                        {(w as any).owner_phone_verified
                          ? t('phoneVerification.statusVerified')
                          : t('phoneVerification.statusUnverified')}
                      </Badge>
                      {(w as any).owner_phone_masked && (
                        <span className="text-xs text-muted-foreground font-mono" dir="ltr">
                          {(w as any).owner_phone_masked}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{w.member_count}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(new Date(w.created_at), 'yyyy-MM-dd')}
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

      {/* Pagination */}
      <div className="flex justify-between items-center">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
        <span className="text-sm text-muted-foreground">Page {page + 1}</span>
        <Button variant="outline" size="sm" disabled={!workspaces || workspaces.length < limit} onClick={() => setPage(p => p + 1)}>Next</Button>
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
          <ArrowLeft className="h-4 w-4" /> Back to list
        </Button>
        <p className="text-center text-muted-foreground py-12">Workspace not found</p>
      </div>
    );
  }

  const ws = detail.workspace;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-5 w-5" />
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
          Delete
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={Users} label="Members" value={detail.members?.length ?? 0} />
        <StatCard icon={BookUser} label="Contacts" value={detail.contact_count} />
        <StatCard icon={MessageSquare} label="Conversations" value={detail.conversation_count} />
        <StatCard icon={Globe} label="Locale" value={ws?.default_locale || 'en'} />
      </div>

      {/* Members */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Members ({detail.members?.length ?? 0})
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
                <Badge variant={m.role === 'owner' ? 'default' : 'secondary'}>{m.role}</Badge>
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
                Branding
              </h3>
              <div className="space-y-2 text-sm">
                <InfoRow label="Platform Name" value={detail.branding.platform_name} />
                <InfoRow label="Primary Color" value={detail.branding.primary_color} color />
                <InfoRow label="Accent Color" value={detail.branding.accent_color} color />
                <InfoRow label="Support Email" value={detail.branding.support_email} />
                <InfoRow label="Legal Name" value={detail.branding.legal_name} />
              </div>
            </CardContent>
          </Card>
        )}

        {detail.widget_settings && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                Widget Settings
              </h3>
              <div className="space-y-2 text-sm">
                <InfoRow label="Enabled" value={detail.widget_settings.enabled ? 'Yes' : 'No'} />
                <InfoRow label="Chat" value={detail.widget_settings.chat_enabled ? 'Yes' : 'No'} />
                <InfoRow label="KB" value={detail.widget_settings.kb_enabled ? 'Yes' : 'No'} />
                <InfoRow label="Position" value={detail.widget_settings.position} />
                <InfoRow label="Tracking" value={detail.widget_settings.visitor_tracking_enabled ? 'Yes' : 'No'} />
                <InfoRow label="Color" value={detail.widget_settings.primary_color} color />
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
            Technical Details
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <InfoRow label="Workspace ID" value={ws?.id} />
            <InfoRow label="Owner ID" value={ws?.owner_id} />
            <InfoRow label="Account ID" value={ws?.account_id} />
            <InfoRow label="Created" value={ws?.created_at ? format(new Date(ws.created_at), 'yyyy-MM-dd HH:mm') : '—'} />
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
  return (
    <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            Delete Workspace
          </DialogTitle>
          <DialogDescription>
            This will permanently delete <strong>{deleteWs?.name}</strong> and all its data. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Type <code className="bg-muted px-1.5 py-0.5 rounded font-semibold text-destructive">{deleteWs?.slug}</code> to confirm:
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
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={deleteConfirm !== deleteWs?.slug || isPending}
            onClick={onDelete}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
            Delete permanently
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
  const { data: profile, isLoading } = useQuery({
    queryKey: ['admin-member-profile', member?.user_id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_profiles', {
        _limit: 1,
        _offset: 0,
      });
      if (error) throw error;
      // Filter to find the specific user
      const all = data as any[];
      return all.find((p: any) => p.id === member?.user_id) || null;
    },
    enabled: !!member?.user_id,
  });

  // Fetch full profile directly
  const { data: fullProfile } = useQuery({
    queryKey: ['admin-member-full-profile', member?.user_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', member!.user_id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!member?.user_id,
  });

  const p = fullProfile;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  return (
    <Dialog open={!!member} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Member Details
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
                  {member?.role}
                </Badge>
              </div>
            </div>

            <Separator />

            {/* Info rows */}
            <div className="space-y-2 text-sm">
              <DetailRow
                icon={Mail}
                label="Email"
                value={p.email}
                onCopy={() => copyToClipboard(p.email)}
              />
              <DetailRow icon={Building2} label="Company" value={p.company_name} />
              <DetailRow icon={Globe} label="Website" value={p.website_domain} />
              <DetailRow icon={Globe} label="Preferred Locale" value={p.preferred_locale} />
              <DetailRow icon={Globe} label="Signup Locale" value={p.signup_locale} />
              <DetailRow icon={Bot} label="AI Mode" value={p.ai_mode} />
              <DetailRow icon={MapPin} label="Signup IP" value={p.signup_ip} />
              <DetailRow
                icon={Calendar}
                label="Joined"
                value={p.created_at ? format(new Date(p.created_at), 'yyyy-MM-dd HH:mm') : null}
              />
              <DetailRow
                icon={Calendar}
                label="Member Since"
                value={member?.created_at ? format(new Date(member.created_at), 'yyyy-MM-dd HH:mm') : null}
              />
            </div>

            <Separator />

            {/* User ID */}
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-xs text-muted-foreground">User ID</span>
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
