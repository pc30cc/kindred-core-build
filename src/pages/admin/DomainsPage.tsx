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

export default function AdminDomainsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const { data: domains, isLoading } = useQuery({
    queryKey: ['admin-all-domains'],
    queryFn: async () => {
      const body = await adminFetch<{ domains: any[] }>('/api/admin/management/domains');
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
      toast({ description: t('admin.domains.updated' as any) });
    },
    onError: (err: any) => {
      toast({ variant: 'destructive', description: String(err?.message ?? err) });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{t('admin.domains.title' as any)}</h1>
      <p className="text-muted-foreground text-sm">{t('admin.domains.subtitle' as any)}</p>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-muted-foreground">{t('admin.domains.domain' as any)}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.common.workspace' as any)}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.domains.verified' as any)}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.domains.primary' as any)}</TableHead>
                <TableHead className="text-muted-foreground text-end">{t('admin.domains.actions' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t('admin.common.loading' as any)}</TableCell></TableRow>
              )}
              {(!isLoading && (!domains || domains.length === 0)) && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t('admin.domains.empty' as any)}</TableCell></TableRow>
              )}
              {domains?.map((d: any) => (
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
                      {d.verified ? t('admin.domains.verified' as any) : t('admin.common.pending' as any)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{d.is_primary ? t('admin.common.yes' as any) : t('admin.common.no' as any)}</TableCell>
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
                        {!d.is_primary && (
                          <Button size="sm" variant="ghost" disabled={patch.isPending}
                            onClick={() => patch.mutate({ id: d.id, is_primary: true })}>
                            <Star className="h-4 w-4 me-1" />
                            {t('admin.domains.setPrimary' as any)}
                          </Button>
                        )}
                        <Button size="icon" variant="ghost"
                          onClick={() => { setEditingId(d.id); setDraft(d.domain ?? ''); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
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
