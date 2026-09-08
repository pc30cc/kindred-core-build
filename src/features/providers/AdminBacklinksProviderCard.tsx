/**
 * ADMIN — SEO BACKLINKS PROVIDER CARD
 *
 * Mirrors AdminSmsProviderCard.tsx's shape. Talks exclusively to
 * `/api/admin/providers/seo-backlinks`, which returns a redacted view
 * (`hasCredentials`) and never the stored credential itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link2, CheckCircle2, XCircle, Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  adminGetBacklinksProvider, adminSaveBacklinksProvider, adminDeleteBacklinksProvider, adminTestBacklinksProvider,
  type AdminBacklinksProviderInfo, type AdminBacklinksTestResult,
} from '@/lib/api';

export function AdminBacklinksProviderCard() {
  const { toast } = useToast();
  const [info, setInfo] = useState<AdminBacklinksProviderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdminBacklinksTestResult | null>(null);

  // Form state. `password` always starts empty — the stored secret is never
  // fetched, cached or rendered.
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(true);

  const passwordKept = info?.hasCredentials === true;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await adminGetBacklinksProvider());
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDialog = () => {
    setLogin(info?.login ?? '');
    setPassword('');
    setEnabled(info?.enabled ?? true);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!login.trim()) {
      toast({ title: 'Login required', description: 'Enter the DataForSEO account login.', variant: 'destructive' });
      return;
    }
    if (!passwordKept && !password.trim()) {
      toast({ title: 'Password required', description: 'An account password must be provided the first time this provider is saved.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const next = await adminSaveBacklinksProvider({
        providerName: 'dataforseo',
        enabled,
        login: login.trim(),
        ...(password.trim() ? { password: password.trim() } : {}),
      });
      setInfo(next);
      setPassword('');
      setDialogOpen(false);
      toast({ title: 'Backlinks provider saved' });
    } catch (err) {
      toast({
        title: 'Could not save backlinks provider',
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
      setTestResult(await adminTestBacklinksProvider());
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
      setInfo(await adminDeleteBacklinksProvider());
      setTestResult(null);
      toast({ title: 'Backlinks provider removed' });
    } catch (err) {
      toast({
        title: 'Could not remove backlinks provider',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card className="bg-card border-border" data-testid="admin-backlinks-provider-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <Link2 className="h-4 w-4 text-primary" />
            SEO Backlinks Provider
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
                <span className="text-foreground font-medium">DataForSEO</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Login</span>
                <span className="text-foreground">{info?.login ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Credential</span>
                {info?.hasCredentials ? (
                  <span className="flex items-center gap-1 text-emerald-500" data-testid="backlinks-credential-saved">
                    <ShieldCheck className="h-3 w-3" /> Credential saved
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </div>
            </div>

            {testResult && (
              <div
                className={`rounded-md border p-2 text-xs ${testResult.success ? 'border-emerald-500/40 text-emerald-500' : 'border-destructive/40 text-destructive'}`}
                data-testid="backlinks-test-result"
              >
                {testResult.success ? (
                  <div className="space-y-0.5">
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Connection OK ({testResult.latencyMs ?? 0} ms)
                    </span>
                    <span className="flex items-center gap-1 text-foreground">
                      <Wallet className="h-3 w-3" /> Balance: {testResult.balance ?? '—'} {testResult.currency ?? 'USD'}
                    </span>
                  </div>
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
              <Link2 className="h-4 w-4 text-primary" /> Configure Backlinks Provider
            </DialogTitle>
            <DialogDescription className="text-xs">
              DataForSEO account credentials are stored server-side and are never sent back to the browser.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="backlinks-login" className="text-xs">Login</Label>
              <Input
                id="backlinks-login"
                autoComplete="off"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="backlinks-password" className="text-xs">Password</Label>
              <Input
                id="backlinks-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={passwordKept ? 'Leave blank to keep the current password' : 'Required'}
              />
              {passwordKept && (
                <p className="flex items-center gap-1 text-[11px] text-emerald-500">
                  <ShieldCheck className="h-3 w-3" /> Credential saved
                </p>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <Label htmlFor="backlinks-enabled" className="text-xs">Enabled</Label>
              <Switch id="backlinks-enabled" checked={enabled} onCheckedChange={setEnabled} />
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
