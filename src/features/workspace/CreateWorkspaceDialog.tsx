import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Building2, Globe, Loader2, Lock, Sparkles, ArrowUpRight } from 'lucide-react';
import { useCreateWorkspace, useAccount } from '@/hooks/useWorkspace';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional path to the billing/plans page for the upgrade CTA. */
  upgradeHref?: string;
}

interface Capacity {
  used: number;
  limit: number | null;
  canCreate: boolean;
  plan: string | null;
}

export function CreateWorkspaceDialog({ open, onOpenChange, upgradeHref }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [capacityLoading, setCapacityLoading] = useState(false);
  const navigate = useNavigate();
  const { data: account } = useAccount();
  const createWorkspace = useCreateWorkspace();
  const { t, dir } = useTranslation();

  // Plan capacity is resolved server-side (max_workspaces is an
  // account-level cap enforced at creation), so the dialog only mirrors it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCapacityLoading(true);
    fetch(`${API_BASE}/api/workspaces/capacity`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setCapacity(d as Capacity); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setCapacityLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const locked = capacity ? !capacity.canCreate : false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !account?.id || locked) return;

    try {
      const newWsId = await createWorkspace.mutateAsync({
        accountId: account.id,
        name: name.trim(),
      });

      const res = await fetch(`${API_BASE}/api/workspaces/${newWsId}`, { credentials: 'include' });
      const newWs = res.ok ? await res.json() : null;

      toast.success(t('workspaceCreate.created'));
      setName('');
      setDomain('');
      onOpenChange(false);

      navigate(newWs?.slug ? `/app/w/${newWs.slug}` : '/app');
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg === 'email_verification_required') {
        toast.error(t('workspaceCreate.verifyRequired'), {
          description: t('workspaceCreate.verifyRequiredDesc'),
        });
      } else if (msg.includes('workspace_limit_reached')) {
        setCapacity((c) => (c ? { ...c, canCreate: false } : c));
        toast.error(t('workspaceCreate.limitTitle'));
      } else {
        toast.error(msg || t('workspaceCreate.failed'));
      }
    }
  };

  const limitLabel = capacity?.limit == null ? t('workspaceCreate.unlimited') : String(capacity.limit);
  const pct = capacity?.limit ? Math.min(100, Math.round((capacity.used / capacity.limit) * 100)) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir={dir} className="sm:max-w-lg p-0 overflow-hidden gap-0">
        {/* Header band */}
        <div className="relative px-6 pt-6 pb-5 bg-gradient-to-b from-primary/10 to-transparent border-b border-border/60">
          <div className="flex items-start gap-3">
            <div className="h-11 w-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0 shadow-sm">
              <Building2 className="h-5 w-5" />
            </div>
            <DialogHeader className="space-y-1 text-start">
              <DialogTitle className="text-base font-semibold">{t('workspaceCreate.title')}</DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed">
                {t('workspaceCreate.subtitle')}
              </DialogDescription>
            </DialogHeader>
          </div>

          {/* Plan usage */}
          <div className="mt-4 rounded-lg border border-border/60 bg-background/70 backdrop-blur-sm px-3 py-2.5">
            {capacityLoading && !capacity ? (
              <Skeleton className="h-4 w-40" />
            ) : capacity ? (
              <>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-muted-foreground">{t('workspaceCreate.usage')}</span>
                  <span className="font-semibold tabular-nums">
                    {capacity.used} / {limitLabel}
                  </span>
                </div>
                {capacity.limit != null && (
                  <Progress value={pct} className={cn('h-1.5 mt-2', locked && '[&>div]:bg-destructive')} />
                )}
              </>
            ) : (
              <p className="text-[12px] text-muted-foreground">{t('workspaceCreate.checking')}</p>
            )}
          </div>
        </div>

        <div className="px-6 py-5">
          {locked ? (
            <div className="text-center space-y-3 py-2">
              <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
                <Lock className="h-5 w-5" />
              </div>
              <h3 className="text-sm font-semibold">{t('workspaceCreate.limitTitle')}</h3>
              <p className="text-[13px] text-muted-foreground leading-relaxed max-w-sm mx-auto">
                {t('workspaceCreate.limitDesc')
                  .replace('{limit}', limitLabel)
                  .replace('{used}', String(capacity?.used ?? 0))}
              </p>
              <div className="flex justify-center gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('workspaceCreate.cancel')}
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(upgradeHref || '/app');
                  }}
                >
                  <Sparkles className="h-4 w-4 me-2" />
                  {t('workspaceCreate.upgrade')}
                  <ArrowUpRight className="h-3.5 w-3.5 ms-1" />
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ws-name">{t('workspaceCreate.nameLabel')}</Label>
                <div className="relative">
                  <Building2 className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="ws-name"
                    placeholder={t('workspaceCreate.namePlaceholder')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="ps-9"
                    autoFocus
                    required
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('workspaceCreate.nameHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ws-domain">{t('workspaceCreate.domainLabel')}</Label>
                <div className="relative">
                  <Globe className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="ws-domain"
                    dir="ltr"
                    placeholder={t('workspaceCreate.domainPlaceholder')}
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    className="ps-9 text-start"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('workspaceCreate.domainHint')}</p>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('workspaceCreate.cancel')}
                </Button>
                <Button type="submit" disabled={!name.trim() || createWorkspace.isPending}>
                  {createWorkspace.isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
                  {t('workspaceCreate.submit')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
