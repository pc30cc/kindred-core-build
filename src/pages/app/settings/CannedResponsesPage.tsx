/**
 * Phase 6 — Canned Responses settings page.
 *
 * Routes: /app/w/:slug/settings/canned-responses
 *
 * - Locale tabs (en / fa / tr) drive the operator-locale used for ranking.
 * - Server returns operator-locale rows first, then fallback locales — items
 *   from a different locale than the active tab are still shown with a
 *   locale badge so admins see the full picture.
 * - Permission-aware: members manage their own; owners/admins manage any.
 * - Live preview happens inside the form using SAMPLE_CONTEXT only.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import {
  useCannedResponses,
  useCreateCannedResponse,
  useUpdateCannedResponse,
  useDeleteCannedResponse,
} from '@/hooks/useCannedResponses';
import type { CannedLocale, CannedResponse } from '@/lib/canned-responses-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Pencil, Trash2, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CannedResponseForm, type CannedFormValues } from '@/components/canned-responses/CannedResponseForm';
import { formatDate as formatLocalizedDate } from '@/lib/date';

const LOCALES: { value: CannedLocale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fa', label: 'فارسی' },
  { value: 'tr', label: 'Türkçe' },
];

export default function SettingsCannedResponsesPage() {
  const { t, dir } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { user } = useAuth();
  const { data: role } = useWorkspaceRole(workspace?.id);
  const isAdmin = isWorkspaceAdmin(role);

  const [activeLocale, setActiveLocale] = useState<CannedLocale>('en');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // 200ms debounce on search input
  useMemo(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);

  const list = useCannedResponses({
    workspaceId: workspace?.id,
    locale: activeLocale,
    q: debouncedSearch,
    limit: 50,
  });

  const createMut = useCreateCannedResponse(workspace?.id);
  const updateMut = useUpdateCannedResponse(workspace?.id);
  const deleteMut = useDeleteCannedResponse(workspace?.id);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CannedResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CannedResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const items = list.data?.items ?? [];

  const canManageRow = (row: CannedResponse): boolean => {
    if (!user) return false;
    if (isAdmin) return true;
    return row.created_by === user.id;
  };

  const handleCreate = (values: CannedFormValues) => {
    setServerError(null);
    createMut.mutate(values, {
      onSuccess: () => setCreateOpen(false),
      onError: (e) => setServerError(e instanceof Error ? e.message : t('canned.createFailed')),
    });
  };

  const handleUpdate = (values: CannedFormValues) => {
    if (!editing) return;
    setServerError(null);
    updateMut.mutate(
      { id: editing.id, patch: values },
      {
        onSuccess: () => setEditing(null),
        onError: (e) => setServerError(e instanceof Error ? e.message : t('canned.updateFailed')),
      },
    );
  };

  const handleToggleActive = (row: CannedResponse, next: boolean) => {
    if (!canManageRow(row)) return;
    updateMut.mutate({ id: row.id, patch: { is_active: next } });
  };

  const handleDelete = () => {
    if (!confirmDelete) return;
    deleteMut.mutate(confirmDelete.id, {
      onSettled: () => setConfirmDelete(null),
    });
  };

  return (
    <div dir={dir} className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('canned.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('canned.subtitle')}
            {!isAdmin && ` ${t('canned.memberHint')}`}
          </p>
        </div>
        <Button onClick={() => { setServerError(null); setCreateOpen(true); }} disabled={!workspace}>
          <Plus className="h-4 w-4 me-1.5" />
          {t('canned.new')}
        </Button>
      </div>

      {/* Locale tabs + search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Tabs value={activeLocale} onValueChange={(v) => setActiveLocale(v as CannedLocale)}>
          <TabsList>
            {LOCALES.map((l) => (
              <TabsTrigger key={l.value} value={l.value}>{l.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="relative w-full max-w-xs">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('canned.searchPlaceholder')}
            className="ps-8"
          />
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
        {list.isLoading ? (
          <div className="p-12 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin me-2" /> {t('canned.loading')}
          </div>
        ) : list.isError ? (
          <div className="p-8 text-sm text-destructive">
            {t('canned.loadFailed', { error: (list.error as Error)?.message ?? t('canned.unknownError') })}
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">
              {debouncedSearch
                ? t('canned.noMatches', { query: debouncedSearch })
                : t('canned.empty')}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((row) => {
              const isFallback = row.locale !== activeLocale;
              const canManage = canManageRow(row);
              return (
                <li key={row.id} className="p-4 flex items-start gap-4 hover:bg-accent/20 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-[12px] px-1.5 py-0.5 rounded bg-muted text-foreground font-mono">
                        /{row.shortcut}
                      </code>
                      <span className="text-sm font-medium text-foreground truncate">{row.title}</span>
                      {isFallback && (
                        <Badge variant="secondary" className="text-[10px] uppercase">{row.locale}</Badge>
                      )}
                      {!row.is_active && (
                        <Badge variant="outline" className="text-[10px]">{t('canned.inactive')}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                      {row.body}
                    </p>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                      <span>{t('canned.usedCount', { count: String(row.usage_count) })}</span>
                      <span>
                        {t('canned.lastUsed', {
                          date: row.last_used_at ? formatLocalizedDate(row.last_used_at) : t('canned.never'),
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <div className={cn('flex items-center gap-1.5', !canManage && 'opacity-50')}>
                      <Switch
                        checked={row.is_active}
                        onCheckedChange={(v) => handleToggleActive(row, v)}
                        disabled={!canManage || updateMut.isPending}
                        aria-label={t('canned.activeAria')}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setServerError(null); setEditing(row); }}
                      disabled={!canManage}
                      title={canManage ? t('canned.edit') : t('canned.noPermissionEdit')}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConfirmDelete(row)}
                      disabled={!canManage}
                      title={canManage ? t('canned.delete') : t('canned.noPermissionDelete')}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) { setCreateOpen(false); setServerError(null); } }}>
        <DialogContent className="max-w-2xl" dir={dir}>
          <DialogHeader>
            <DialogTitle>{t('canned.createTitle')}</DialogTitle>
            <DialogDescription>
              {t('canned.createDescription', { sample: '{{contact.name}}' })}
            </DialogDescription>
          </DialogHeader>
          <CannedResponseForm
            defaultLocale={activeLocale}
            submitLabel={createMut.isPending ? t('canned.saving') : t('canned.create')}
            submitting={createMut.isPending}
            serverError={serverError}
            onSubmit={handleCreate}
            onCancel={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) { setEditing(null); setServerError(null); } }}>
        <DialogContent className="max-w-2xl" dir={dir}>
          <DialogHeader>
            <DialogTitle>{t('canned.editTitle')}</DialogTitle>
            <DialogDescription>{t('canned.editDescription')}</DialogDescription>
          </DialogHeader>
          {editing && (
            <CannedResponseForm
              key={editing.id}
              initial={editing}
              defaultLocale={editing.locale}
              submitLabel={updateMut.isPending ? t('canned.saving') : t('canned.saveChanges')}
              submitting={updateMut.isPending}
              serverError={serverError}
              onSubmit={handleUpdate}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <AlertDialogContent dir={dir}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('canned.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete &&
                t('canned.deleteDescription', {
                  shortcut: confirmDelete.shortcut,
                  title: confirmDelete.title,
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('canned.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMut.isPending ? t('canned.deleting') : t('canned.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
