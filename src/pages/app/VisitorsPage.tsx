import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useOnlineVisitors } from '@/hooks/useVisitors';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Eye, Globe, Monitor, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function VisitorsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: visitors, isLoading } = useOnlineVisitors(workspace?.id);

  const statusColors: Record<string, string> = {
    online: 'bg-success text-success-foreground',
    idle: 'bg-warning text-warning-foreground',
    offline: 'bg-muted text-muted-foreground',
  };

  const onlineCount = visitors?.filter(v => v.status === 'online').length ?? 0;
  const idleCount = visitors?.filter(v => v.status === 'idle').length ?? 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('visitors.title')}</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('visitors.online')}</CardTitle>
            <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
          </CardHeader>
          <CardContent><p className="text-3xl font-bold text-foreground">{onlineCount}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('visitors.idle')}</CardTitle>
            <Clock className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent><p className="text-3xl font-bold text-foreground">{idleCount}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><p className="text-3xl font-bold text-foreground">{visitors?.length ?? 0}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>
          ) : !visitors?.length ? (
            <div className="p-8 text-center">
              <Eye className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">{t('visitors.noVisitors')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('visitors.status')}</TableHead>
                  <TableHead>{t('visitors.currentPage')}</TableHead>
                  <TableHead>{t('visitors.browser')}</TableHead>
                  <TableHead>{t('visitors.device')}</TableHead>
                  <TableHead>{t('visitors.source')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visitors.map(v => (
                  <TableRow key={v.id}>
                    <TableCell>
                      <Badge className={cn('text-xs', statusColors[v.status])}>
                        {t(`visitors.${v.status}` as any)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate font-mono text-xs">
                      {v.current_page || v.visitor_sessions?.current_page || '—'}
                    </TableCell>
                    <TableCell className="text-sm">{v.visitor_sessions?.browser || '—'}</TableCell>
                    <TableCell className="text-sm">{v.visitor_sessions?.device || '—'}</TableCell>
                    <TableCell className="text-sm truncate max-w-[150px]">{v.visitor_sessions?.referrer || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
