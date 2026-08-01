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
const LINE_NUMBER_PATTERN = /^[0-9]{1,20}$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z0-9_]{1,50}$/;

type RuntimeVendor = 'kavenegar' | 'smsir';

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
  const [vendor, setVendor] = useState<RuntimeVendor>('kavenegar');
  const [lineNumber, setLineNumber] = useState('');
  const [verifyTemplateId, setVerifyTemplateId] = useState('');
  const [verifyParameterName, setVerifyParameterName] = useState('CODE');

  const vendors = PROVIDER_SCHEMAS.sms?.vendors ?? [];
  const kavenegar = vendors.find((v) => v.name === 'kavenegar');
  const smsir = vendors.find((v) => v.name === 'smsir');
  const activeVendorSchema = vendor === 'kavenegar' ? kavenegar : smsir;
  const comingSoon = vendors.filter((v) => v.comingSoon);

  const vendorLabel = (name: AdminSmsProviderInfo['providerName']) => {
    if (name === 'kavenegar') return kavenegar?.label ?? 'Kavenegar';
    if (name === 'smsir') return smsir?.label ?? 'SMS.ir';
    return '—';
  };

  /** Switching vendors always requires a fresh API key — the server enforces this too. */
  const keyKept = info?.hasApiKey === true && info.providerName === vendor;

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
    const current: RuntimeVendor =
      info?.providerName === 'smsir' || info?.providerName === 'kavenegar'
        ? info.providerName
        : 'kavenegar';
    setVendor(current);
    setVerifyTemplate(info?.verifyTemplate ?? '');
    setSender(info?.sender ?? '');
    setLineNumber(info?.lineNumber ?? '');
    setVerifyTemplateId(info?.verifyTemplateId != null ? String(info.verifyTemplateId) : '');
    setVerifyParameterName(info?.verifyParameterName ?? 'CODE');
    setEnabled(info?.enabled ?? true);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (vendor === 'kavenegar') {
      if (!VERIFY_TEMPLATE_PATTERN.test(verifyTemplate)) {
        toast({
          title: 'Invalid verification template',
          description: 'Letters and digits only — no spaces or underscores.',
          variant: 'destructive',
        });
        return;
      }
    } else {
      if (!LINE_NUMBER_PATTERN.test(lineNumber.trim())) {
        toast({
          title: 'Invalid line number',
          description: 'The SMS.ir line number must contain digits only.',
          variant: 'destructive',
        });
        return;
      }
      if (!/^[0-9]{1,15}$/.test(verifyTemplateId.trim()) || Number(verifyTemplateId.trim()) <= 0) {
        toast({
          title: 'Invalid template ID',
          description: 'The SMS.ir verification template ID must be a positive number.',
          variant: 'destructive',
        });
        return;
      }
      if (!PARAMETER_NAME_PATTERN.test(verifyParameterName.trim())) {
        toast({
          title: 'Invalid parameter name',
          description: 'Letters, digits and underscores only.',
          variant: 'destructive',
        });
        return;
      }
    }
    if (!keyKept && !apiKey.trim()) {
      toast({
        title: 'API key required',
        description:
          info?.hasApiKey && info.providerName !== vendor
            ? 'Switching vendors requires a new API key.'
            : 'An API key must be provided the first time this provider is saved.',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    try {
      const next = await adminSaveSmsProvider(
        vendor === 'kavenegar'
          ? {
              providerName: 'kavenegar',
              enabled,
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              ...(sender.trim() ? { sender: sender.trim() } : {}),
              verifyTemplate,
            }
          : {
              providerName: 'smsir',
              enabled,
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              lineNumber: lineNumber.trim(),
              verifyTemplateId: Number(verifyTemplateId.trim()),
              verifyParameterName: verifyParameterName.trim(),
            },
      );
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
        provider: info?.providerName ?? 'unknown',
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
                  {vendorLabel(info?.providerName ?? 'disabled')}
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
              {info?.providerName === 'smsir' ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Line number</span>
                    <span className="text-foreground" data-testid="sms-line-number">{info.lineNumber ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Verification template ID</span>
                    <span className="text-foreground">{info.verifyTemplateId ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Code parameter</span>
                    <span className="text-foreground">{info.verifyParameterName ?? '—'}</span>
                  </div>
                </>
              ) : (
                <>
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
                </>
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
              Kavenegar and SMS.ir have live runtimes today. Credentials are stored
              server-side and are never sent back to the browser.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Vendor</Label>
              <div className="grid grid-cols-2 gap-2">
                {(['kavenegar', 'smsir'] as const).map((name) => (
                  <Button
                    key={name}
                    type="button"
                    size="sm"
                    variant={vendor === name ? 'default' : 'outline'}
                    className="text-xs"
                    data-testid={`sms-vendor-select-${name}`}
                    onClick={() => setVendor(name)}
                  >
                    {vendorLabel(name)}
                  </Button>
                ))}
              </div>
              {activeVendorSchema?.docsUrl && (
                <a href={activeVendorSchema.docsUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                  Docs <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-api-key" className="text-xs">API Key</Label>
              <Input
                id="sms-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyKept ? 'Leave blank to keep the current key' : 'Required'}
              />
              {keyKept ? (
                <p className="flex items-center gap-1 text-[11px] text-emerald-500">
                  <ShieldCheck className="h-3 w-3" /> Credential saved
                </p>
              ) : info?.hasApiKey ? (
                <p className="text-[11px] text-amber-500" data-testid="sms-switch-key-warning">
                  Switching vendors requires a new API key.
                </p>
              ) : null}
            </div>

            {vendor === 'kavenegar' ? (
            <>
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
            </>
            ) : (
            <>
            <div className="space-y-1.5">
              <Label htmlFor="sms-line-number" className="text-xs">Line Number</Label>
              <Input
                id="sms-line-number"
                value={lineNumber}
                onChange={(e) => setLineNumber(e.target.value)}
                placeholder="30007732"
                inputMode="numeric"
              />
              <p className="text-[11px] text-muted-foreground">
                Dedicated line from your SMS.ir panel — digits only.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-template-id" className="text-xs">Verification Template ID</Label>
              <Input
                id="sms-template-id"
                value={verifyTemplateId}
                onChange={(e) => setVerifyTemplateId(e.target.value)}
                placeholder="100000"
                inputMode="numeric"
              />
              <p className="text-[11px] text-muted-foreground">
                Numeric template ID of the approved OTP template.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-parameter-name" className="text-xs">Code Parameter Name</Label>
              <Input
                id="sms-parameter-name"
                value={verifyParameterName}
                onChange={(e) => setVerifyParameterName(e.target.value)}
                placeholder="CODE"
              />
              <p className="text-[11px] text-muted-foreground">
                The template placeholder that receives the verification code.
              </p>
            </div>
            </>
            )}

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
