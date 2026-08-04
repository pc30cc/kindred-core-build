import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  listDepartmentMembers,
  setDepartmentMembers,
  getFallbackPolicy,
  updateFallbackPolicy,
  getDepartmentDiagnostics,
  type Department,
  type DepartmentChannel,
} from '@/lib/workspace-departments-api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from '@/lib/toast';
import {
  Building2, Plus, Trash2, Users, MessageSquare, Phone, Video,
  Loader2, AlertCircle, CheckCircle2, Eye,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';

export default function DepartmentsPage() {
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id;
  const wsPath = useWorkspacePath();
  const qc = useQueryClient();

  const { data: departments = [], isLoading } = useQuery({
    queryKey: ['workspace-departments', workspaceId],
    queryFn: () => listDepartments(workspaceId!),
    enabled: !!workspaceId,
  });

  const { data: fallback } = useQuery({
    queryKey: ['workspace-departments-fallback', workspaceId],
    queryFn: () => getFallbackPolicy(workspaceId!),
    enabled: !!workspaceId,
  });

  const [diagChannel, setDiagChannel] = useState<DepartmentChannel>('chat');
  const { data: diagnostics } = useQuery({
    queryKey: ['workspace-departments-diag', workspaceId, diagChannel],
    queryFn: () => getDepartmentDiagnostics(workspaceId!, diagChannel),
    enabled: !!workspaceId,
    refetchInterval: 15_000,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [membersFor, setMembersFor] = useState<Department | null>(null);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['workspace-departments', workspaceId] });
    qc.invalidateQueries({ queryKey: ['workspace-departments-diag', workspaceId] });
  };

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateDepartment(workspaceId!, id, { enabled }),
    onSuccess: invalidateAll,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDepartment(workspaceId!, id),
    onSuccess: () => {
      toast.success('Department deleted');
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateFallback = useMutation({
    mutationFn: (patch: Partial<typeof fallback>) =>
      updateFallbackPolicy(workspaceId!, patch as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-departments-fallback', workspaceId] });
      qc.invalidateQueries({ queryKey: ['workspace-departments-diag', workspaceId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!workspaceId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            Departments
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Optional <span className="text-foreground font-medium">routing</span> configuration.
            Departments decide where incoming chats and calls go (Sales,
            Support, Billing…). Leave empty to send everything to the
            General Pool. Member access permissions live separately under{' '}
            <Link to={wsPath('/settings/access-profiles')} className="text-primary hover:underline">
              Access Profiles
            </Link>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={wsPath('/settings/team')}>
              <Users className="h-4 w-4 me-2" />
              Manage in Team
            </Link>
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 me-2" />
            New department
          </Button>
        </div>
      </div>

      {/* Departments list */}
      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto" />
          </div>
        ) : departments.length === 0 ? (
          <div className="p-10 text-center">
            <Building2 className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="font-medium">No departments yet</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Your workspace works without departments. Add one only if you want
              to route by team.
            </p>
            <Button variant="outline" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 me-2" /> Create first department
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {departments.map((d) => (
              <div key={d.id} className="p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{d.name}</span>
                    {!d.enabled && <Badge variant="outline">Disabled</Badge>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    {d.chat_enabled && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" /> Chat
                      </span>
                    )}
                    {d.audio_enabled && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" /> Audio
                      </span>
                    )}
                    {d.video_enabled && (
                      <span className="flex items-center gap-1">
                        <Video className="h-3 w-3" /> Video
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMembersFor(d)}
                >
                  <Users className="h-4 w-4 me-1" /> Members
                </Button>
                <Switch
                  checked={d.enabled}
                  onCheckedChange={(v) =>
                    toggleEnabled.mutate({ id: d.id, enabled: v })
                  }
                />
                <Button variant="ghost" size="sm" onClick={() => setEditing(d)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(`Delete department "${d.name}"?`)) remove.mutate(d.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Fallback policy */}
      <Card className="p-5">
        <h2 className="text-lg font-semibold mb-1">Fallback policy</h2>
        <p className="text-sm text-muted-foreground mb-4">
          When no eligible department member is available, routing tries this
          order: General Pool → Owner → Queue → Callback → Offline.
        </p>
        {fallback && (
          <div className="space-y-3">
            <FallbackToggle
              label="Enable owner fallback"
              checked={fallback.owner_fallback_enabled}
              onChange={(v) => updateFallback.mutate({ owner_fallback_enabled: v })}
            />
            <div className="ms-6 space-y-2 opacity-90">
              <FallbackToggle
                label="Owner answers chat"
                checked={fallback.owner_fallback_for_chat}
                disabled={!fallback.owner_fallback_enabled}
                onChange={(v) => updateFallback.mutate({ owner_fallback_for_chat: v })}
              />
              <FallbackToggle
                label="Owner answers audio calls"
                checked={fallback.owner_fallback_for_audio}
                disabled={!fallback.owner_fallback_enabled}
                onChange={(v) => updateFallback.mutate({ owner_fallback_for_audio: v })}
              />
              <FallbackToggle
                label="Owner answers video calls"
                checked={fallback.owner_fallback_for_video}
                disabled={!fallback.owner_fallback_enabled}
                onChange={(v) => updateFallback.mutate({ owner_fallback_for_video: v })}
              />
            </div>
            <FallbackToggle
              label="Use General Pool when no department selected"
              checked={fallback.general_pool_enabled}
              onChange={(v) => updateFallback.mutate({ general_pool_enabled: v })}
            />
          </div>
        )}
      </Card>

      {/* Diagnostics */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Eye className="h-4 w-4" /> Routing diagnostics
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Preview what visitors see and why each department is hidden.
            </p>
          </div>
          <Select value={diagChannel} onValueChange={(v) => setDiagChannel(v as any)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="audio">Audio</SelectItem>
              <SelectItem value="video">Video</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {diagnostics && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-4 text-muted-foreground">
              <span>Visible: <strong className="text-foreground">{diagnostics.visible_departments.length}</strong></span>
              <span>Hidden: <strong className="text-foreground">{diagnostics.hidden_departments.length}</strong></span>
              <span>General Pool: <strong className="text-foreground">{diagnostics.general_pool_size}</strong></span>
            </div>
            {diagnostics.visible_departments.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase">Visible</p>
                {diagnostics.visible_departments.map((v) => (
                  <div key={v.id} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span>{v.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {v.available_count} available · {v.member_count} eligible
                    </span>
                  </div>
                ))}
              </div>
            )}
            {diagnostics.hidden_departments.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase">Hidden</p>
                {diagnostics.hidden_departments.map((h) => (
                  <div key={h.id} className="flex items-center gap-2 text-sm">
                    <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{h.name}</span>
                    <Badge variant="outline" className="text-xs">{h.reason}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {showCreate && (
        <DepartmentDialog
          mode="create"
          workspaceId={workspaceId}
          onClose={() => setShowCreate(false)}
          onSaved={invalidateAll}
        />
      )}
      {editing && (
        <DepartmentDialog
          mode="edit"
          department={editing}
          workspaceId={workspaceId}
          onClose={() => setEditing(null)}
          onSaved={invalidateAll}
        />
      )}
      {membersFor && (
        <MembersDialog
          department={membersFor}
          workspaceId={workspaceId}
          onClose={() => setMembersFor(null)}
          onSaved={invalidateAll}
        />
      )}
    </div>
  );
}

function FallbackToggle({
  label, checked, onChange, disabled,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className={disabled ? 'text-muted-foreground' : ''}>{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function DepartmentDialog({
  mode, department, workspaceId, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  department?: Department;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: department?.name || '',
    enabled: department?.enabled ?? true,
    chat_enabled: department?.chat_enabled ?? true,
    audio_enabled: department?.audio_enabled ?? false,
    video_enabled: department?.video_enabled ?? false,
    sort_order: department?.sort_order ?? 0,
  });

  const save = useMutation({
    mutationFn: () =>
      mode === 'create'
        ? createDepartment(workspaceId, form)
        : updateDepartment(workspaceId, department!.id, form),
    onSuccess: () => {
      toast.success(mode === 'create' ? 'Department created' : 'Department updated');
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New department' : 'Edit department'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Sales, Support, Billing"
            />
          </div>
          <div>
            <Label>Sort order</Label>
            <Input
              type="number"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-2">
            <Label>Channels</Label>
            <FallbackToggle
              label="Chat"
              checked={form.chat_enabled}
              onChange={(v) => setForm({ ...form, chat_enabled: v })}
            />
            <FallbackToggle
              label="Audio calls"
              checked={form.audio_enabled}
              onChange={(v) => setForm({ ...form, audio_enabled: v })}
            />
            <FallbackToggle
              label="Video calls"
              checked={form.video_enabled}
              onChange={(v) => setForm({ ...form, video_enabled: v })}
            />
          </div>
          <FallbackToggle
            label="Enabled"
            checked={form.enabled}
            onChange={(v) => setForm({ ...form, enabled: v })}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!form.name.trim() || save.isPending}
          >
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({
  department, workspaceId, onClose, onSaved,
}: {
  department: Department;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: members = [] } = useWorkspaceMembers(workspaceId);
  const { data: assigned = [] } = useQuery({
    queryKey: ['department-members', workspaceId, department.id],
    queryFn: () => listDepartmentMembers(workspaceId, department.id),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const sel = useMemo(() => selected ?? new Set(assigned), [selected, assigned]);

  const save = useMutation({
    mutationFn: () =>
      setDepartmentMembers(workspaceId, department.id, Array.from(sel)),
    onSuccess: () => {
      toast.success('Members updated');
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function toggle(uid: string) {
    const next = new Set(sel);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setSelected(next);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Members of {department.name}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[400px] overflow-y-auto py-2 space-y-1">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No workspace members yet.
            </p>
          ) : (
            members.map((m) => (
              <label
                key={m.user_id}
                className="flex items-center gap-3 p-2 rounded hover:bg-accent/40 cursor-pointer"
              >
                <Checkbox
                  checked={sel.has(m.user_id)}
                  onCheckedChange={() => toggle(m.user_id)}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {m.full_name || m.email || m.user_id.slice(0, 8)}
                  </p>
                  {m.email && m.full_name && (
                    <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                  )}
                </div>
                <Badge variant="outline" className="text-xs">{m.role}</Badge>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}