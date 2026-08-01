/**
 * ADMIN — SMS PROVIDER CARD
 *
 * Dedicated card for the platform SMS provider. Deliberately does NOT use the
 * generic `AdminProviderCard`, because that card reads and writes full provider
 * config straight from the browser. SMS credentials are server-only: this card
 * talks exclusively to `/api/admin/providers/sms`, which returns a redacted
 * view (`hasApiKey`) and never the credential itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { Smartphone, CheckCircle2, XCircle, Loader2, ExternalLink, ShieldCheck, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { PROVIDER_SCHEMAS } from '@/features/providers/schemas';
import {
  adminGetSmsProvider, adminSaveSmsProvider, adminDeleteSmsProvider, adminTestSmsProvider,
  type AdminSmsProviderInfo, type AdminSmsTestResult,
} from '@/lib/api';

const VERIFY_TEMPLATE_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export function AdminSmsProviderCard() {
  const { toast } = useToast();
  const [info, setInfo] = useState<AdminSmsProviderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdminSmsTestResult | null>(null);

  // Form state. `apiKey` always starts empty — the stored secret is never
  // fetched, cached or rendered.
  const [apiKey, setApiKey] = useState('');
  const [verifyTemplate, setVerifyTemplate] = useState('');
  const [sender, setSender] = useState('');
  const [enabled, setEnabled] = useState(true);

  const vendors = PROVIDER_SCHEMAS.sms?.vendors ?? [];
  const kavenegar = vendors.find((v) => v.name === 'kavenegar');
  const comingSoon = vendors.filter((v) => v.comingSoon);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await adminGetSmsProvider());
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDialog = () => {
    setApiKey('');
    setVerifyTemplate(info?.verifyTemplate ?? '');
    setSender(info?.sender ?? '');
    setEnabled(info?.enabled ?? true);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!VERIFY_TEMPLATE_PATTERN.test(verifyTemplate)) {
      toast({
        title: 'Invalid verification template',
        description: 'Letters and digits only — no spaces or underscores.',
        variant: 'destructive',
      });
      return;
    }
    if (!info?.hasApiKey && !apiKey.trim()) {
      toast({
        title: 'API key required',
        description: 'An API key must be provided the first time this provider is saved.',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    try {
      const next = await adminSaveSmsProvider({
        providerName: 'kavenegar',
        enabled,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(sender.trim() ? { sender: sender.trim() } : {}),
        verifyTemplate,
      });
      setInfo(next);
      setApiKey('');
      setDialogOpen(false);
      toast({ title: 'SMS provider saved' });
    } catch (err) {
      toast({
        title: 'Could not save SMS provider',
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
      setTestResult(await adminTestSmsProvider());
    } catch (err) {
      setTestResult({
        success: false,
        provider: 'kavenegar',
        error: err instanceof Error ? err.message : 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDisable = async () => {
    try {
      setInfo(await adminDeleteSmsProvider());
      setTestResult(null);
      toast({ title: 'SMS provider removed' });
    } catch (err) {
      toast({
        title: 'Could not remove SMS provider',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card className="bg-card border-border" data-testid="admin-sms-provider-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <Smartphone className="h-4 w-4 text-primary" />
            SMS Provider
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
                <span className="text-foreground font-medium">
                  {info?.providerName === 'kavenegar' ? (kavenegar?.label ?? 'Kavenegar') : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Credential</span>
                {info?.hasApiKey ? (
                  <span className="flex items-center gap-1 text-emerald-500" data-testid="sms-credential-saved">
                    <ShieldCheck className="h-3 w-3" /> Credential saved
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Verification template</span>
                <span className="text-foreground">{info?.verifyTemplate ?? '—'}</span>
              </div>
              {info?.sender && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Default sender</span>
                  <span className="text-foreground">{info.sender}</span>
                </div>
              )}
            </div>

            {testResult && (
              <div
                className={`rounded-md border p-2 text-xs ${
                  testResult.success ? 'border-emerald-500/40 text-emerald-500' : 'border-destructive/40 text-destructive'
                }`}
                data-testid="sms-test-result"
              >
                {testResult.success ? (
                  <div className="space-y-0.5">
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Connection OK ({testResult.latencyMs ?? 0} ms)
                    </span>
                    <span className="flex items-center gap-1 text-foreground">
                      <Wallet className="h-3 w-3" /> Balance:{' '}
                      {testResult.balance ?? '—'} {testResult.currency ?? 'IRR'}
                      {testResult.accountType ? ` · ${testResult.accountType}` : ''}
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

            {comingSoon.length > 0 && (
              <div className="pt-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Coming soon</p>
                <div className="flex flex-wrap gap-1">
                  {comingSoon.map((v) => (
                    <Badge key={v.name} variant="outline" className="text-[9px] opacity-60" data-testid={`sms-vendor-soon-${v.name}`}>
                      {v.label}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Smartphone className="h-4 w-4 text-primary" /> Configure SMS Provider
            </DialogTitle>
            <DialogDescription className="text-xs">
              Kavenegar is the only vendor with a live runtime today. Credentials are stored
              server-side and are never sent back to the browser.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Vendor</Label>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs">
                <span className="text-foreground">{kavenegar?.label ?? 'Kavenegar'}</span>
                {kavenegar?.docsUrl && (
                  <a href={kavenegar.docsUrl} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline">
                    Docs <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-api-key" className="text-xs">API Key</Label>
              <Input
                id="sms-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={info?.hasApiKey ? 'Leave blank to keep the current key' : 'Required'}
              />
              {info?.hasApiKey && (
                <p className="flex items-center gap-1 text-[11px] text-emerald-500">
                  <ShieldCheck className="h-3 w-3" /> Credential saved
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-template" className="text-xs">OTP / Verification Template</Label>
              <Input
                id="sms-template"
                value={verifyTemplate}
                onChange={(e) => setVerifyTemplate(e.target.value)}
                placeholder="verifyLogin"
              />
              <p className="text-[11px] text-muted-foreground">
                Template name from your Kavenegar panel — letters and digits only.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-sender" className="text-xs">Default Sender (optional)</Label>
              <Input
                id="sms-sender"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                placeholder="10008663"
              />
              <p className="text-[11px] text-muted-foreground">
                Used for plain SMS only. Verification messages use Kavenegar's approved line.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <Label htmlFor="sms-enabled" className="text-xs">Enabled</Label>
              <Switch id="sms-enabled" checked={enabled} onCheckedChange={setEnabled} />
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
