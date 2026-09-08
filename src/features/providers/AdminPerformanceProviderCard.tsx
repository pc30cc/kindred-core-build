/**
 * ADMIN — SEO PERFORMANCE PROVIDER CARD
 *
 * Mirrors AdminBacklinksProviderCard.tsx's shape, adapted for a single
 * optional API key credential instead of login+password (Google PageSpeed
 * Insights authenticates with one API key and works keyless at a lower
 * shared quota). Talks exclusively to `/api/admin/providers/seo-performance`,
 * which returns a redacted view (`hasCredentials`) and never the stored key
 * itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { Gauge, CheckCircle2, XCircle, Loader2, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  adminGetPerformanceProvider, adminSavePerformanceProvider, adminDeletePerformanceProvider, adminTestPerformanceProvider,
  type AdminPerformanceProviderInfo, type AdminPerformanceTestResult,
} from '@/lib/api';

export function AdminPerformanceProviderCard() {
  const { toast } = useToast();
  const [info, setInfo] = useState<AdminPerformanceProviderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdminPerformanceTestResult | null>(null);

  // Form state. `apiKey` always starts empty — the stored secret is never
  // fetched, cached or rendered.
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);

  const keyKept = info?.hasCredentials === true;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await adminGetPerformanceProvider());
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDialog = () => {
    setApiKey('');
    setEnabled(info?.enabled ?? true);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = await adminSavePerformanceProvider({
        providerName: 'pagespeed',
        enabled,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setInfo(next);
      setApiKey('');
      setDialogOpen(false);
      toast({ title: 'Performance provider saved' });
    } catch (err) {
      toast({
        title: 'Could not save performance provider',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await adminTestPerformanceProvider());
    } catch (err) {
      setTestResult({
        success: false,
        provider: info?.providerName ?? 'unknown',
        error: err instanceof Error ? err.message : 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDisable = async () => {
    try {
      setInfo(await adminDeletePerformanceProvider());
      setTestResult(null);
      toast({ title: 'Performance provider removed' });
    } catch (err) {
      toast({
        title: 'Could not remove performance provider',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card className="bg-card border-border" data-testid="admin-performance-provider-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <Gauge className="h-4 w-4 text-primary" />
            SEO Performance Provider
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant={info?.configured ? 'default' : 'outline'} className="text-[10px]">
              {info?.configured ? 'Configured' : 'Not Configured'}
            </Badge>
            <Badge variant={info?.enabled ? 'default' : 'secondary'} className="text-[10px]">
              {info?.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Vendor</span>
                <span className="text-foreground font-medium">Google PageSpeed Insights</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">API Key</span>
                {info?.hasCredentials ? (
                  <span className="flex items-center gap-1 text-emerald-500" data-testid="performance-credential-saved">
                    <ShieldCheck className="h-3 w-3" /> Key saved
                  </span>
                ) : (
                  <span className="text-muted-foreground">Keyless (shared quota)</span>
                )}
              </div>
            </div>

            {testResult && (
              <div
                className={`rounded-md border p-2 text-xs ${testResult.success ? 'border-emerald-500/40 text-emerald-500' : 'border-destructive/40 text-destructive'}`}
                data-testid="performance-test-result"
              >
                {testResult.success ? (
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Connection OK ({testResult.latencyMs ?? 0} ms)
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> {testResult.error ?? 'Connection failed'}
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={openDialog}>Configure</Button>
              <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || !info?.configured}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : null}
                Test Connection
              </Button>
              {info?.configured && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={handleDisable}>
                  Remove
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Gauge className="h-4 w-4 text-primary" /> Configure Performance Provider
            </DialogTitle>
            <DialogDescription className="text-xs">
              A Google API key is stored server-side and is never sent back to the browser. PageSpeed Insights
              works without a key at a much lower shared quota — leave this blank to use the shared quota.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="performance-api-key" className="text-xs">Google API Key (optional)</Label>
              <Input
                id="performance-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyKept ? 'Leave blank to keep the current key' : 'Optional'}
              />
              {keyKept && (
                <p className="flex items-center gap-1 text-[11px] text-emerald-500">
                  <ShieldCheck className="h-3 w-3" /> Key saved
                </p>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <Label htmlFor="performance-enabled" className="text-xs">Enabled</Label>
              <Switch id="performance-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>

          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : null} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
