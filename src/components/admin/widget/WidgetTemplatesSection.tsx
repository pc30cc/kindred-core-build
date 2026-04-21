import { useWidgetTemplates, useUpdateWidgetTemplate } from '@/hooks/useWidgetTemplates';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { CheckCircle2, Layers, Lock, Sparkles } from 'lucide-react';

function statusBadge(status: string) {
  switch (status) {
    case 'active':
      return <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3" />Active</Badge>;
    case 'beta':
      return <Badge variant="outline" className="gap-1 text-xs border-primary/40 text-primary"><Sparkles className="h-3 w-3" />Beta</Badge>;
    case 'deprecated':
      return <Badge variant="outline" className="text-xs">Deprecated</Badge>;
    case 'hidden':
      return <Badge variant="outline" className="text-xs">Hidden</Badge>;
    default:
      return <Badge variant="outline" className="text-xs">{status}</Badge>;
  }
}

export function WidgetTemplatesSection() {
  const { data: templates, isLoading, error } = useWidgetTemplates();
  const updateMut = useUpdateWidgetTemplate();

  const toggleEnabled = (id: string, enabled: boolean) => {
    updateMut.mutate(
      { id, patch: { enabled } },
      {
        onSuccess: () => toast({ title: enabled ? 'Template enabled' : 'Template disabled' }),
        onError: (e: any) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          Widget Templates
        </CardTitle>
        <CardDescription>
          Registry of widget UI templates available to the platform. Disable a template here to
          remove it from every workspace. The built-in <code className="rounded bg-muted px-1 py-0.5 text-[11px]">default</code> template
          cannot be disabled — it is the runtime fallback so existing widgets never break.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {(error as Error).message}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !templates || templates.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No widget templates registered. Re-run the database migration to seed the default template.
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[36%]">Template</TableHead>
                  <TableHead className="w-[18%]">Slug</TableHead>
                  <TableHead className="w-[14%]">Status</TableHead>
                  <TableHead className="w-[18%]">Tags</TableHead>
                  <TableHead className="w-[14%] text-right">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => {
                  const locked = t.is_builtin || t.slug === 'default';
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="align-top">
                        <div className="font-medium text-sm">{t.name}</div>
                        {t.description && (
                          <div className="text-xs text-muted-foreground mt-0.5 max-w-md">{t.description}</div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t.slug}</code>
                      </TableCell>
                      <TableCell className="align-top">{statusBadge(t.status)}</TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-wrap gap-1">
                          {t.is_builtin && (
                            <Badge variant="outline" className="gap-1 text-[10px]">
                              <Lock className="h-2.5 w-2.5" />Built-in
                            </Badge>
                          )}
                          {t.slug === 'default' && (
                            <Badge className="gap-1 text-[10px] bg-primary/10 text-primary border-primary/30 hover:bg-primary/15">
                              Current
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Switch
                            checked={t.enabled}
                            disabled={locked || updateMut.isPending}
                            onCheckedChange={(v) => toggleEnabled(t.id, v)}
                            aria-label={`${t.enabled ? 'Disable' : 'Enable'} ${t.name}`}
                          />
                        </div>
                        {locked && (
                          <p className="text-[10px] text-muted-foreground mt-1">Cannot disable</p>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Foundation only.</strong>{' '}
          Workspace-level template selection is not available yet — every widget continues to use the
          built-in <code className="rounded bg-background px-1 py-0.5 text-[10px]">default</code> template.
          New templates registered here will become selectable in a future workspace setting without
          changes to this admin screen.
        </div>
      </CardContent>
    </Card>
  );
}