import { useMemo, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import {
  useCallCenterDepartments,
  useCreateDepartment,
  useUpdateDepartment,
  useDeleteDepartment,
  useCallCenterAgentPresence,
  useCallCenterDepartmentAgents,
  useAddDepartmentAgent,
  useRemoveDepartmentAgent,
} from '@/hooks/useCallCenter';
import type {
  CallCenterDepartment,
  CreateDepartmentPayload,
  CallCenterRoutingMode,
} from '@/lib/call-center-api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { Plus, Users, Settings2, Trash2, Circle, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function slugify(s: string) {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

const ROUTING_LABELS: Record<CallCenterRoutingMode, string> = {
  broadcast: 'Broadcast',
  round_robin: 'Round robin',
  least_busy: 'Least busy',
};

const PRESENCE_TONES: Record<string, string> = {
  available: 'bg-emerald-500',
  busy: 'bg-rose-500',
  away: 'bg-amber-500',
  offline: 'bg-muted-foreground/40',
};

export default function CallCenterDepartmentsPage() {
  const { workspace } = useActiveWorkspace();
  const wid = workspace?.id;
  const { data, isLoading } = useCallCenterDepartments(wid);
  const { data: presenceData } = useCallCenterAgentPresence(wid);
  const departments = data?.departments || [];
  const presence = presenceData?.presence || [];

  const [editing, setEditing] = useState<CallCenterDepartment | null>(null);
  const [creating, setCreating] = useState(false);
  const [agentDeptId, setAgentDeptId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const enabled = departments.filter(d => d.enabled).length;
    const available = presence.filter(p => p.status === 'available').length;
    const offline = presence.filter(p => p.status === 'offline').length;
    return { total: departments.length, enabled, available, offline };
  }, [departments, presence]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Departments
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Route calls to the right team.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4 me-2" />New department</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Total" value={stats.total} />
        <SummaryCard label="Enabled" value={stats.enabled} />
        <SummaryCard label="Available agents" value={stats.available} tone="ok" />
        <SummaryCard label="Offline agents" value={stats.offline} tone="muted" />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : departments.length === 0 ? (
        <Card className="p-8 text-center">
          <Building2 className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
          <h3 className="font-medium">No departments yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Create your first department to start routing calls.</p>
          <Button onClick={() => setCreating(true)} className="mt-4">
            <Plus className="h-4 w-4 me-2" />Create department
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {departments.map(d => (
            <DepartmentRow
              key={d.id}
              dept={d}
              fallbackName={departments.find(x => x.id === d.fallback_department_id)?.name}
              onEdit={() => setEditing(d)}
              onAgents={() => setAgentDeptId(d.id)}
              onDelete={() => setDeletingId(d.id)}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <DepartmentDialog
          open
          onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }}
          dept={editing}
          allDepts={departments}
          workspaceId={wid!}
        />
      )}

      {agentDeptId && (
        <AgentsSheet
          open
          onOpenChange={(o) => { if (!o) setAgentDeptId(null); }}
          departmentId={agentDeptId}
          department={departments.find(d => d.id === agentDeptId)}
          workspaceId={wid!}
          presence={presence}
        />
      )}

      {deletingId && (
        <DeleteDialog
          workspaceId={wid!}
          departmentId={deletingId}
          name={departments.find(d => d.id === deletingId)?.name || ''}
          onClose={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'muted' }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        'text-2xl font-semibold mt-1',
        tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'muted' && 'text-muted-foreground',
      )}>{value}</div>
    </Card>
  );
}

function DepartmentRow({
  dept, fallbackName, onEdit, onAgents, onDelete,
}: {
  dept: CallCenterDepartment;
  fallbackName?: string;
  onEdit: () => void;
  onAgents: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="p-4 flex items-center gap-4 flex-wrap">
      <div
        className="h-10 w-10 rounded-lg flex items-center justify-center text-white font-semibold shrink-0"
        style={{ background: dept.color || 'hsl(var(--primary))' }}
      >
        {(dept.icon || dept.name.charAt(0)).slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-medium truncate">{dept.name}</div>
          <code className="text-xs text-muted-foreground">{dept.slug}</code>
          {!dept.enabled && <Badge variant="outline" className="text-amber-600 border-amber-500/40">Disabled</Badge>}
          <Badge variant="secondary">{ROUTING_LABELS[dept.routing_mode] || dept.routing_mode}</Badge>
          {fallbackName && <Badge variant="outline">Fallback: {fallbackName}</Badge>}
        </div>
        {dept.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{dept.description}</p>}
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" onClick={onAgents}><Users className="h-3.5 w-3.5 me-1" />Agents</Button>
        <Button size="sm" variant="outline" onClick={onEdit}><Settings2 className="h-3.5 w-3.5" /></Button>
        <Button size="sm" variant="outline" onClick={onDelete}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
      </div>
    </Card>
  );
}

function DepartmentDialog({
  open, onOpenChange, dept, allDepts, workspaceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dept: CallCenterDepartment | null;
  allDepts: CallCenterDepartment[];
  workspaceId: string;
}) {
  const create = useCreateDepartment(workspaceId);
  const update = useUpdateDepartment(workspaceId);
  const isEdit = !!dept;

  const [form, setForm] = useState<CreateDepartmentPayload>(() => ({
    name: dept?.name || '',
    slug: dept?.slug || '',
    description: dept?.description || '',
    color: dept?.color || '#3B82F6',
    icon: dept?.icon || '',
    enabled: dept?.enabled ?? true,
    sort_order: dept?.sort_order ?? 0,
    routing_mode: dept?.routing_mode || 'broadcast',
    fallback_department_id: dept?.fallback_department_id || null,
  }));

  const [slugTouched, setSlugTouched] = useState(!!dept);
  const fallbackOptions = allDepts.filter(d => d.id !== dept?.id);

  async function onSubmit() {
    if (!form.name.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' }); return;
    }
    const payload = { ...form, slug: form.slug || slugify(form.name) };
    try {
      if (isEdit && dept) await update.mutateAsync({ id: dept.id, patch: payload });
      else await create.mutateAsync(payload);
      toast({ title: isEdit ? 'Department updated' : 'Department created' });
      onOpenChange(false);
    } catch (e: any) {
      const msg = String(e?.message || 'Save failed');
      const friendly =
        msg.includes('invalid_fallback_department') ? 'Invalid fallback department.' :
        msg.includes('department_not_found') ? 'Department not found.' :
        msg.includes('duplicate') || msg.includes('unique') ? 'Slug already in use.' :
        msg;
      toast({ title: 'Save failed', description: friendly, variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit department' : 'New department'}</DialogTitle>
          <DialogDescription>Group agents and route calls based on visitor needs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm(f => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
                }}
                placeholder="Support" />
            </div>
            <div>
              <Label>Slug</Label>
              <Input value={form.slug} onChange={(e) => { setSlugTouched(true); setForm(f => ({ ...f, slug: slugify(e.target.value) })); }} placeholder="support" />
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea rows={2} value={form.description || ''} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Color</Label>
              <Input type="color" value={form.color || '#3B82F6'} onChange={(e) => setForm(f => ({ ...f, color: e.target.value }))} className="h-10 p-1" />
            </div>
            <div>
              <Label>Icon (1-2 chars)</Label>
              <Input value={form.icon || ''} onChange={(e) => setForm(f => ({ ...f, icon: e.target.value.slice(0, 2) }))} placeholder="S" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Routing mode</Label>
              <Select value={form.routing_mode || 'broadcast'} onValueChange={(v) => setForm(f => ({ ...f, routing_mode: v as CallCenterRoutingMode }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="broadcast">Broadcast — ring all eligible</SelectItem>
                  <SelectItem value="round_robin">Round robin — next agent</SelectItem>
                  <SelectItem value="least_busy">Least busy — fewest active calls</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Fallback department</Label>
              <Select
                value={form.fallback_department_id || '__none__'}
                onValueChange={(v) => setForm(f => ({ ...f, fallback_department_id: v === '__none__' ? null : v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {fallbackOptions.map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Enabled</Label>
              <p className="text-xs text-muted-foreground">Disabled departments will fallback if configured.</p>
            </div>
            <Switch checked={!!form.enabled} onCheckedChange={(v) => setForm(f => ({ ...f, enabled: v }))} />
          </div>
          <div>
            <Label>Sort order</Label>
            <Input type="number" value={form.sort_order ?? 0} onChange={(e) => setForm(f => ({ ...f, sort_order: Number(e.target.value) || 0 }))} className="w-32" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSubmit} disabled={create.isPending || update.isPending}>
            {isEdit ? 'Save changes' : 'Create department'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  workspaceId, departmentId, name, onClose,
}: { workspaceId: string; departmentId: string; name: string; onClose: () => void }) {
  const del = useDeleteDepartment(workspaceId);
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{name}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the department and unassigns its agents. Calls already routed are unaffected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async (e) => {
              e.preventDefault();
              try { await del.mutateAsync(departmentId); toast({ title: 'Department deleted' }); onClose(); }
              catch (err: any) { toast({ title: 'Delete failed', description: String(err?.message || err), variant: 'destructive' }); }
            }}
          >Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AgentsSheet({
  open, onOpenChange, workspaceId, departmentId, department, presence,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  departmentId: string;
  department?: CallCenterDepartment;
  presence: { user_id: string; status: string; active_call_count: number }[];
}) {
  const { data: agentsData, isLoading } = useCallCenterDepartmentAgents(workspaceId, departmentId);
  const { data: members } = useWorkspaceMembers(workspaceId);
  const add = useAddDepartmentAgent(workspaceId, departmentId);
  const remove = useRemoveDepartmentAgent(workspaceId, departmentId);
  const agents = agentsData?.agents || [];
  const memberById = useMemo(() => {
    const m = new Map<string, any>();
    (members || []).forEach(x => m.set(x.user_id, x));
    return m;
  }, [members]);
  const presById = useMemo(() => {
    const m = new Map<string, any>(); presence.forEach(p => m.set(p.user_id, p)); return m;
  }, [presence]);

  const assignedIds = new Set(agents.map(a => a.user_id));
  const candidates = (members || []).filter(m => !assignedIds.has(m.user_id));
  const [pickUserId, setPickUserId] = useState('');
  const [pickRole, setPickRole] = useState<'agent' | 'supervisor'>('agent');

  async function onAdd() {
    if (!pickUserId) return;
    try {
      await add.mutateAsync({ user_id: pickUserId, role: pickRole });
      setPickUserId('');
      toast({ title: 'Agent added' });
    } catch (e: any) {
      toast({ title: 'Failed to add agent', description: String(e?.message || e), variant: 'destructive' });
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{department?.name || 'Department'} — Agents</SheetTitle>
          <SheetDescription>Manage who can receive calls in this department.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <Card className="p-3 space-y-2">
            <Label className="text-xs">Add member</Label>
            <div className="flex gap-2">
              <Select value={pickUserId} onValueChange={setPickUserId}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Select member…" /></SelectTrigger>
                <SelectContent>
                  {candidates.length === 0
                    ? <div className="px-2 py-1.5 text-xs text-muted-foreground">All members already added</div>
                    : candidates.map(m => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name || m.email || m.user_id.slice(0, 8)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select value={pickRole} onValueChange={(v) => setPickRole(v as any)}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" onClick={onAdd} disabled={!pickUserId || add.isPending}>Add</Button>
            </div>
          </Card>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents in this department yet.</p>
          ) : (
            <div className="space-y-2">
              {agents.map(a => {
                const m = memberById.get(a.user_id);
                const p = presById.get(a.user_id);
                const status = p?.status || 'offline';
                return (
                  <Card key={a.id} className="p-3 flex items-center gap-3">
                    <div className="relative">
                      {m?.avatar_url
                        ? <img src={m.avatar_url} alt="" className="h-9 w-9 rounded-full object-cover" />
                        : <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-xs">
                            {(m?.full_name || m?.email || '?').charAt(0).toUpperCase()}
                          </div>}
                      <span className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background', PRESENCE_TONES[status])} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {m?.full_name || m?.email || a.user_id.slice(0, 8)}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <span className="capitalize"><Circle className={cn('h-2 w-2 inline me-1', PRESENCE_TONES[status], 'rounded-full')} />{status}</span>
                        <span>· {a.role}</span>
                        {p && p.active_call_count > 0 && <span>· {p.active_call_count} active</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      try { await remove.mutateAsync(a.user_id); toast({ title: 'Removed' }); }
                      catch (e: any) { toast({ title: 'Failed', description: String(e?.message || e), variant: 'destructive' }); }
                    }}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}