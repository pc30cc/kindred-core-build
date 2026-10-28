import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminFetch } from '@/hooks/useAdmin';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { toast } from '@/hooks/use-toast';
import { Check, Pencil, Star, X } from 'lucide-react';

/** A row of GET /api/admin/management/domains. */
interface AdminDomainRow {
  id: string;
  domain: string | null;
  workspace_id: string;
  verified: boolean | null;
  is_primary: boolean | null;
  /** The workspace's registered website (server/services/ownerWebsite.ts). */
  fixed?: boolean;
  workspaces?: { name: string | null } | null;
}

export default function AdminDomainsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const { data: domains, isLoading } = useQuery({
    queryKey: ['admin-all-domains'],
    queryFn: async () => {
      const body = await adminFetch<{ domains: AdminDomainRow[] }>('/api/admin/management/domains');
      return body.domains;
    },
  });

  const patch = useMutation({
    mutationFn: (vars: { id: string; domain?: string; is_primary?: boolean }) =>
      adminFetch(`/api/admin/management/domains/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ domain: vars.domain, is_primary: vars.is_primary }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-all-domains'] });
      setEditingId(null);
      toast({ description: t('admin.domains.updated') });
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', description: err instanceof Error ? err.message : String(err) });
    },
  });

  // A registered website is fixed for good (owner, 2026-10-28): it is not
  // edited, and while it is its workspace's primary no other row takes the
  // flag (the server refuses both too). Other rows edit as before.
  const primaryFixed = new Set((domains ?? []).filter((d) => d.is_primary && d.fixed).map((d) => d.workspace_id));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{t('admin.domains.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('admin.domains.subtitle')}</p>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-muted-foreground">{t('admin.domains.domain')}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.common.workspace')}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.domains.verified')}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.domains.primary')}</TableHead>
                <TableHead className="text-muted-foreground text-end">{t('admin.domains.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t('admin.common.loading')}</TableCell></TableRow>
              )}
              {(!isLoading && (!domains || domains.length === 0)) && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t('admin.domains.empty')}</TableCell></TableRow>
              )}
              {domains?.map((d) => (
                <TableRow key={d.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground font-mono text-sm">
                    {editingId === d.id ? (
                      <Input
                        value={draft}
                        autoFocus
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && draft.trim()) patch.mutate({ id: d.id, domain: draft.trim() });
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="h-8 font-mono text-sm"
                        dir="ltr"
                      />
                    ) : (
                      d.domain
                    )}
                  </TableCell>
                  <TableCell className="text-foreground/80 text-sm">{d.workspaces?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge className={d.verified ? 'bg-green-900/50 text-green-400 border-green-500/30' : 'bg-yellow-900/50 text-yellow-400 border-yellow-500/30'}>
                      {d.verified ? t('admin.domains.verified') : t('admin.common.pending')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{d.is_primary ? t('admin.common.yes') : t('admin.common.no')}</TableCell>
                  <TableCell className="text-end">
                    {editingId === d.id ? (
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" disabled={!draft.trim() || patch.isPending}
                          onClick={() => patch.mutate({ id: d.id, domain: draft.trim() })}>
                          <Check className="h-4 w-4 text-green-500" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setEditingId(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-1">
                        {!d.is_primary && !primaryFixed.has(d.workspace_id) && (
                          <Button size="sm" variant="ghost" disabled={patch.isPending}
                            onClick={() => patch.mutate({ id: d.id, is_primary: true })}>
                            <Star className="h-4 w-4 me-1" />
                            {t('admin.domains.setPrimary')}
                          </Button>
                        )}
                        {!d.fixed && (
                          <Button size="icon" variant="ghost"
                            onClick={() => { setEditingId(d.id); setDraft(d.domain ?? ''); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
