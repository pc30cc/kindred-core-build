import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { adminFetch } from '@/hooks/useAdmin';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';

export default function AdminDomainsPage() {
  const { t } = useTranslation();
  const { data: domains, isLoading } = useQuery({
    queryKey: ['admin-all-domains'],
    queryFn: async () => {
      const body = await adminFetch<{ domains: any[] }>('/api/admin/management/domains');
      return body.domains;
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t('admin.common.loading' as any)}</TableCell></TableRow>
              )}
              {(!isLoading && (!domains || domains.length === 0)) && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t('admin.domains.empty' as any)}</TableCell></TableRow>
              )}
              {domains?.map((d: any) => (
                <TableRow key={d.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground font-mono text-sm">{d.domain}</TableCell>
                  <TableCell className="text-foreground/80 text-sm">{d.workspaces?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge className={d.verified ? 'bg-green-900/50 text-green-400 border-green-500/30' : 'bg-yellow-900/50 text-yellow-400 border-yellow-500/30'}>
                      {d.verified ? t('admin.domains.verified' as any) : t('admin.common.pending' as any)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{d.is_primary ? t('admin.common.yes' as any) : t('admin.common.no' as any)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
