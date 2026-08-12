import { useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import {
  useContacts, useCreateContact, useBulkDeleteContacts,
} from '@/hooks/useContacts';
import { useContactChannels } from '@/hooks/useContactChannels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus, Search, Filter, Download, Upload, MoreHorizontal, Star, Eye,
  Mail, Phone, Users, ChevronDown, Trash2, Loader2, FileDown, X, Lock,
  MessageSquare, PhoneCall,
} from 'lucide-react';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { ContactImportWizard } from '@/features/contacts/ContactImportWizard';
import {
  getInitials, getDisplayName, timeAgo,
  getCompanyFromMetadata, getLocationFromMetadata, getScoreFromMetadata,
  exportContactsToCSV, downloadFile,
} from '@/features/contacts/utils';

type SortKey = 'name' | 'email' | 'company' | 'last_active' | 'score';

export default function ContactsPage() {
  const { t, dir } = useTranslation();
  const navigate = useNavigate();
  const { slug: wsSlug } = useParams();
  const workspace = useCurrentWorkspace();
  const { data: contacts, isLoading } = useContacts(workspace?.id);
  const { data: channels } = useContactChannels(workspace?.id);
  const createContact = useCreateContact(workspace?.id);
  const bulkDelete = useBulkDeleteContacts();
  const { data: ents } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const can = (key: string) => ents?.features?.[key]?.value !== false;
  const canCreate = can('contact_create');
  const canImport = can('contact_import');
  const canExport = can('contact_export');
  const goBilling = () => navigate(`/app/w/${wsSlug}/billing`);
  const lockedToast = () => {
    toast({ title: t('contacts.featureLockedTitle'), description: t('contacts.featureLockedDesc'), variant: 'destructive' });
  };

  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [filterHasEmail, setFilterHasEmail] = useState(false);
  const [filterHasPhone, setFilterHasPhone] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('last_active');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createForm, setCreateForm] = useState({ name: '', email: '', phone: '' });

  const allTags = useMemo(() => {
    const set = new Set<string>();
    contacts?.forEach((c) => (c.tags ?? []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [contacts]);

  const filtered = useMemo(() => {
    if (!contacts) return [];
    let list = contacts.filter((c) => {
      if (filterHasEmail && !c.email) return false;
      if (filterHasPhone && !c.phone) return false;
      if (filterTag && !(c.tags ?? []).includes(filterTag)) return false;
      if (search) {
        const q = search.toLowerCase();
        const haystack = [c.name, c.email, c.phone, getCompanyFromMetadata(c)]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      let av: any = '', bv: any = '';
      switch (sortBy) {
        case 'name': av = a.name ?? ''; bv = b.name ?? ''; break;
        case 'email': av = a.email ?? ''; bv = b.email ?? ''; break;
        case 'company': av = getCompanyFromMetadata(a) ?? ''; bv = getCompanyFromMetadata(b) ?? ''; break;
        case 'score': av = getScoreFromMetadata(a); bv = getScoreFromMetadata(b); break;
        case 'last_active':
        default:
          av = a.updated_at ?? a.created_at ?? '';
          bv = b.updated_at ?? b.created_at ?? '';
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [contacts, search, filterTag, filterHasEmail, filterHasPhone, sortBy, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir('desc'); }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((c) => c.id)));
  };

  const openContact = (id: string) => {
    navigate(`/app/w/${wsSlug}/contacts/${id}`);
  };

  const handleCreate = async () => {
    try {
      await createContact.mutateAsync(createForm);
      setCreateForm({ name: '', email: '', phone: '' });
      setCreateOpen(false);
      toast({ title: t('contacts.toastCreated') });
    } catch (e: any) {
      toast({ title: t('contacts.toastError'), description: e?.message, variant: 'destructive' });
    }
  };

  const handleExport = () => {
    if (!canExport) { lockedToast(); goBilling(); return; }
    if (!filtered.length) {
      toast({ title: t('contacts.toastNothingToExport'), variant: 'destructive' });
      return;
    }
    const csv = exportContactsToCSV(filtered);
    downloadFile(`contacts-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    toast({ title: t('contacts.toastExported'), description: t('contacts.toastExportedDesc', { count: String(filtered.length) }) });
  };

  const handleBulkDelete = async () => {
    try {
      const res = await bulkDelete.mutateAsync(Array.from(selected));
      toast({ title: t('contacts.toastDeleted'), description: t('contacts.toastDeletedDesc', { count: String(res.deleted) }) });
      setSelected(new Set());
      setBulkDeleteOpen(false);
    } catch (e: any) {
      toast({ title: t('contacts.toastError'), description: e?.message, variant: 'destructive' });
    }
  };

  const activeFilters = (filterTag ? 1 : 0) + (filterHasEmail ? 1 : 0) + (filterHasPhone ? 1 : 0);
  const withEmail = contacts?.filter((c) => c.email).length || 0;
  const withPhone = contacts?.filter((c) => c.phone).length || 0;

  return (
    <div className="flex flex-col h-full bg-background" dir={dir}>
      {/* ── Header ── */}
      <div className="border-b border-border bg-card px-5 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" />
              <h1 className="text-base font-bold text-foreground">
                {t('contacts.title')}
              </h1>
            </div>
            <Badge variant="secondary" className="text-xs">{filtered.length}</Badge>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder={t('contacts.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 ps-8 pe-3 w-[220px] text-xs"
              />
            </div>

            {/* Filters */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 text-xs gap-1.5">
                  <Filter className="w-3.5 h-3.5" />
                  {t('contacts.filters')}
                  {activeFilters > 0 && (
                    <Badge variant="default" className="ms-1 h-4 px-1.5 text-[10px]">{activeFilters}</Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <div className="p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox id="has-email" checked={filterHasEmail} onCheckedChange={(v) => setFilterHasEmail(!!v)} />
                    <Label htmlFor="has-email" className="text-xs cursor-pointer flex-1">{t('contacts.hasEmail')}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="has-phone" checked={filterHasPhone} onCheckedChange={(v) => setFilterHasPhone(!!v)} />
                    <Label htmlFor="has-phone" className="text-xs cursor-pointer flex-1">{t('contacts.hasPhone')}</Label>
                  </div>
                </div>
                {allTags.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="p-2">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{t('contacts.tagsLabel')}</Label>
                      <div className="flex flex-wrap gap-1 mt-2 max-h-32 overflow-y-auto">
                        {allTags.map((tag) => (
                          <button
                            key={tag}
                            onClick={() => setFilterTag(filterTag === tag ? null : tag)}
                            className={cn(
                              'text-[10px] px-2 py-1 rounded-full border transition-colors',
                              filterTag === tag
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-secondary text-foreground border-transparent hover:border-border',
                            )}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {activeFilters > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => { setFilterTag(null); setFilterHasEmail(false); setFilterHasPhone(false); }}>
                      <X className="w-3.5 h-3.5 me-2" />{t('contacts.clearFilters')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              className={cn('h-9 text-xs gap-1.5', !canImport && 'opacity-60')}
              onClick={() => (canImport ? setImportOpen(true) : (lockedToast(), goBilling()))}
              title={canImport ? undefined : t('contacts.featureLockedDesc')}
            >
              {canImport ? <Upload className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
              {t('contacts.import')}
            </Button>

            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              {canCreate ? (
                <DialogTrigger asChild>
                  <Button size="sm" className="h-9 text-xs gap-1.5">
                    <Plus className="w-3.5 h-3.5" />{t('contacts.newContact')}
                  </Button>
                </DialogTrigger>
              ) : (
                <Button
                  size="sm"
                  className="h-9 text-xs gap-1.5 opacity-60"
                  onClick={() => { lockedToast(); goBilling(); }}
                  title={t('contacts.featureLockedDesc')}
                >
                  <Lock className="w-3.5 h-3.5" />{t('contacts.newContact')}
                </Button>
              )}
              <DialogContent dir={dir}>
                <DialogHeader>
                  <DialogTitle className="text-start">{t('contacts.addContact')}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('contacts.name')}</Label>
                    <Input value={createForm.name} onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('contacts.email')}</Label>
                    <Input type="email" value={createForm.email} onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('contacts.phone')}</Label>
                    <Input value={createForm.phone} onChange={(e) => setCreateForm((p) => ({ ...p, phone: e.target.value }))} />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('contacts.cancel')}</Button>
                  <Button onClick={handleCreate} disabled={createContact.isPending}>
                    {createContact.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('contacts.create')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 text-xs gap-1.5">
                  {t('contacts.actions')} <ChevronDown className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExport}>
                  {canExport
                    ? <FileDown className="w-3.5 h-3.5 me-2" />
                    : <Lock className="w-3.5 h-3.5 me-2" />}
                  <span className={cn(!canExport && 'text-muted-foreground')}>{t('contacts.exportCsv')}</span>
                </DropdownMenuItem>
                {selected.size > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setBulkDeleteOpen(true)} className="text-destructive">
                      <Trash2 className="w-3.5 h-3.5 me-2" />{t('contacts.deleteSelected', { count: String(selected.size) })}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Stat strip */}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /><span>{t('contacts.statTotal', { count: String(contacts?.length || 0) })}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5" /><span>{t('contacts.statWithEmail', { count: String(withEmail) })}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Phone className="w-3.5 h-3.5" /><span>{t('contacts.statWithPhone', { count: String(withPhone) })}</span>
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="bg-primary/10 border-b border-primary/20 px-5 py-2 flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">
            {t('contacts.selectedCount', { count: String(selected.size) })}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
              {t('contacts.clear')}
            </Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs gap-1.5" onClick={() => setBulkDeleteOpen(true)}>
              <Trash2 className="w-3.5 h-3.5" />{t('contacts.delete')}
            </Button>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : !filtered.length ? (
          <EmptyState
            t={t}
            hasContacts={!!contacts?.length}
            onAdd={() => setCreateOpen(true)}
            onImport={() => setImportOpen(true)}
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-card sticky top-0 z-10 border-b border-border">
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                <th className="w-10 p-3">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === filtered.length}
                    onCheckedChange={toggleSelectAll}
                  />
                </th>
                <Th label={t('contacts.colName')} sortKey="name" current={sortBy} dir={sortDir} onClick={toggleSort} icon={Users} />
                <Th label={t('contacts.colEmail')} sortKey="email" current={sortBy} dir={sortDir} onClick={toggleSort} icon={Mail} />
                <th className="text-start p-3 font-semibold">{t('contacts.colSource')}</th>
                <th className="text-start p-3 font-semibold">{t('contacts.colLocation')}</th>
                <Th label={t('contacts.colCompany')} sortKey="company" current={sortBy} dir={sortDir} onClick={toggleSort} />
                <th className="text-start p-3 font-semibold">{t('contacts.colSegments')}</th>
                <Th label={t('contacts.colLastActive')} sortKey="last_active" current={sortBy} dir={sortDir} onClick={toggleSort} />
                <Th label={t('contacts.colScore')} sortKey="score" current={sortBy} dir={sortDir} onClick={toggleSort} icon={Star} />
                <th className="w-16 text-center p-3 font-semibold">{t('contacts.colPreview')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const isSel = selected.has(c.id);
                const company = getCompanyFromMetadata(c);
                const loc = getLocationFromMetadata(c);
                const score = getScoreFromMetadata(c);
                return (
                  <tr
                    key={c.id}
                    className={cn(
                      'border-b border-border/50 transition-colors cursor-pointer',
                      isSel ? 'bg-primary/5' : 'hover:bg-secondary/30',
                    )}
                    onClick={() => openContact(c.id)}
                  >
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={isSel} onCheckedChange={() => toggleSelect(c.id)} />
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                          {c.avatar_url ? (
                            <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                          ) : (
                            getInitials(c.name, c.email)
                          )}
                        </div>
                        <span className="font-medium text-foreground truncate">{getDisplayName(c, t)}</span>
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground truncate max-w-[200px]">{c.email || '—'}</td>
                    <td className="p-3">
                      <SourceBadge info={channels?.[c.id]} t={t} />
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {loc.country || loc.city ? (
                        <div className="flex items-center gap-1.5">
                          {loc.flag && <span>{loc.flag}</span>}
                          <span className="truncate">{[loc.city, loc.country].filter(Boolean).join(', ')}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50 italic text-xs">{t('contacts.unknown')}</span>
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {company || <span className="text-muted-foreground/50 italic text-xs">{t('contacts.unknown')}</span>}
                    </td>
                    <td className="p-3">
                      {(c.tags ?? []).length === 0 ? (
                        <span className="text-muted-foreground/50 italic text-xs">{t('contacts.noSegments')}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-[180px]">
                          {(c.tags ?? []).slice(0, 2).map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-[10px] h-5 px-1.5">{tag}</Badge>
                          ))}
                          {(c.tags ?? []).length > 2 && (
                            <Badge variant="outline" className="text-[10px] h-5 px-1.5">+{(c.tags ?? []).length - 2}</Badge>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground text-xs">{timeAgo(c.updated_at ?? c.created_at)}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <Star
                            key={n}
                            className={cn(
                              'w-3.5 h-3.5',
                              n <= score ? 'fill-warning text-warning' : 'text-muted-foreground/25',
                            )}
                          />
                        ))}
                      </div>
                    </td>
                    <td className="p-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={() => openContact(c.id)}>
                        <Eye className="w-3 h-3" />{t('contacts.preview')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Import wizard */}
      <ContactImportWizard open={importOpen} onOpenChange={setImportOpen} workspaceId={workspace?.id} />

      {/* Bulk delete confirmation */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent dir={dir}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-start">{t('contacts.bulkDeleteTitle', { count: String(selected.size) })}</AlertDialogTitle>
            <AlertDialogDescription className="text-start">
              {t('contacts.bulkDeleteDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('contacts.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('contacts.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Th({ label, sortKey, current, dir, onClick, icon: Icon }: {
  label: string; sortKey: SortKey; current: SortKey; dir: 'asc' | 'desc'; onClick: (k: SortKey) => void; icon?: any;
}) {
  const active = current === sortKey;
  return (
    <th className="text-start p-3 font-semibold">
      <button
        className={cn(
          'flex items-center gap-1.5 hover:text-foreground transition-colors',
          active && 'text-foreground',
        )}
        onClick={() => onClick(sortKey)}
      >
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
        {active && <ChevronDown className={cn('w-3 h-3 transition-transform', dir === 'asc' && 'rotate-180')} />}
      </button>
    </th>
  );
}

function EmptyState({ t, hasContacts, onAdd, onImport }: { t: (k: any, p?: Record<string, string>) => string; hasContacts: boolean; onAdd: () => void; onImport: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
        <Users className="w-8 h-8 text-primary" />
      </div>
      <h3 className="text-base font-semibold text-foreground">
        {hasContacts ? t('contacts.emptyFilteredTitle') : t('contacts.emptyTitle')}
      </h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {hasContacts ? t('contacts.emptyFilteredDesc') : t('contacts.emptyDesc')}
      </p>
      {!hasContacts && (
        <div className="flex gap-2 mt-5">
          <Button onClick={onAdd} className="gap-1.5">
            <Plus className="w-4 h-4" />{t('contacts.addContact')}
          </Button>
          <Button variant="outline" onClick={onImport} className="gap-1.5">
            <Upload className="w-4 h-4" />{t('contacts.importCsv')}
          </Button>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ info, t }: { info?: { chat: boolean; call: boolean; calls: number }; t: (k: any, v?: any) => string }) {
  if (!info || (!info.chat && !info.call)) {
    return <span className="text-muted-foreground/50 italic text-xs">{t('contacts.sourceUnknown')}</span>;
  }
  if (info.chat && info.call) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
        <MessageSquare className="w-3 h-3" />
        <PhoneCall className="w-3 h-3" />
        {t('contacts.sourceBoth')}
      </span>
    );
  }
  if (info.call) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
        <PhoneCall className="w-3 h-3" />
        {t('contacts.sourceCall')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <MessageSquare className="w-3 h-3" />
      {t('contacts.sourceChat')}
    </span>
  );
}
