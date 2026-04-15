import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  useAdminWorkspaces, useAdminWorkspaceCount,
  useAdminWorkspaceDetail, useAdminDeleteWorkspace,
} from '@/hooks/useAdmin';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Building2, Users, MessageSquare, BookUser, Eye, Trash2,
  Globe, Palette, Bot, Loader2, ChevronRight, Shield,
} from 'lucide-react';

export default function AdminWorkspacesPage() {
  const [page, setPage] = useState(0);
  const limit = 25;
  const { data: workspaces, isLoading } = useAdminWorkspaces(limit, page * limit);
  const { data: count } = useAdminWorkspaceCount();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const { data: detail, isLoading: detailLoading } = useAdminWorkspaceDetail(selectedId);
  const deleteMutation = useAdminDeleteWorkspace();

  const selectedWs = workspaces?.find(w => w.id === selectedId);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Workspaces</h1>
        <span className="text-sm text-muted-foreground">{count ?? 0} total</span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && (!workspaces || workspaces.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No workspaces found</TableCell>
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
                    <Badge variant="secondary">{w.member_count}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(new Date(w.created_at), 'yyyy-MM-dd')}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="icon"
                        onClick={(e) => { e.stopPropagation(); setSelectedId(w.id); }}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); setDeleteId(w.id); }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
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

      {/* Workspace Detail Dialog */}
      <Dialog open={!!selectedId} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              {selectedWs?.name || 'Workspace Details'}
            </DialogTitle>
            <DialogDescription>
              {selectedWs?.slug && <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{selectedWs.slug}</code>}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : detail ? (
            <div className="space-y-6">
              {/* Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard icon={Users} label="Members" value={detail.members?.length ?? 0} />
                <StatCard icon={BookUser} label="Contacts" value={detail.contact_count} />
                <StatCard icon={MessageSquare} label="Conversations" value={detail.conversation_count} />
                <StatCard icon={Globe} label="Locale" value={detail.workspace?.default_locale || 'en'} />
              </div>

              <Separator />

              {/* Members */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  Members
                </h3>
                <div className="space-y-2">
                  {detail.members?.map((m: any) => (
                    <div key={m.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
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
                      <Badge variant={m.role === 'owner' ? 'default' : 'secondary'}>
                        {m.role}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              {/* Branding */}
              {detail.branding && (
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Palette className="h-4 w-4 text-muted-foreground" />
                    Branding
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <InfoRow label="Platform Name" value={detail.branding.platform_name} />
                    <InfoRow label="Primary Color" value={detail.branding.primary_color} color />
                    <InfoRow label="Accent Color" value={detail.branding.accent_color} color />
                    <InfoRow label="Support Email" value={detail.branding.support_email} />
                  </div>
                </div>
              )}

              <Separator />

              {/* Widget */}
              {detail.widget_settings && (
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    Widget Settings
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <InfoRow label="Enabled" value={detail.widget_settings.enabled ? 'Yes' : 'No'} />
                    <InfoRow label="Chat" value={detail.widget_settings.chat_enabled ? 'Yes' : 'No'} />
                    <InfoRow label="KB" value={detail.widget_settings.kb_enabled ? 'Yes' : 'No'} />
                    <InfoRow label="Position" value={detail.widget_settings.position} />
                    <InfoRow label="Visitor Tracking" value={detail.widget_settings.visitor_tracking_enabled ? 'Yes' : 'No'} />
                    <InfoRow label="Color" value={detail.widget_settings.primary_color} color />
                  </div>
                </div>
              )}

              <Separator />

              {/* Workspace Info */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  Details
                </h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <InfoRow label="ID" value={detail.workspace?.id} />
                  <InfoRow label="Owner ID" value={detail.workspace?.owner_id} />
                  <InfoRow label="Account ID" value={detail.workspace?.account_id} />
                  <InfoRow label="Created" value={detail.workspace?.created_at ? format(new Date(detail.workspace.created_at), 'yyyy-MM-dd HH:mm') : '—'} />
                </div>
              </div>

              {/* Delete button */}
              <div className="pt-2">
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => { setDeleteId(selectedId); }}
                >
                  <Trash2 className="h-4 w-4 me-2" />
                  Delete this workspace
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">Workspace not found</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) { setDeleteId(null); setDeleteConfirm(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete Workspace
            </DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{deleteWs?.name}</strong> and all its data including contacts, conversations, members, and settings. This action cannot be undone.
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
            <Button variant="outline" onClick={() => { setDeleteId(null); setDeleteConfirm(''); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirm !== deleteWs?.slug || deleteMutation.isPending}
              onClick={handleDelete}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
