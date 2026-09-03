import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ShieldOff, Database, Mail, MessageSquare, KeyRound, RotateCcw } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatPattern as format } from '@/lib/date';
import {
  useVerificationOverview, useVerificationPurpose, useUpdatePurposeSettings, useResetPurposeSettings,
  useVerificationAudit, useTemplatePreview, VerificationAdminApiError,
  type VerificationPurpose, type PurposeOverview, type PlatformCeilings, type ProviderReadinessState,
} from '@/hooks/useVerificationAdmin';
import type { Locale } from '@/i18n/config';

const CHANNELS: Record<VerificationPurpose, 'email' | 'sms' | 'emailAndSms'> = {
  signup_email: 'email',
  signup_phone: 'sms',
  password_reset: 'email',
  login_step_up: 'emailAndSms',
  change_email: 'email',
  change_phone: 'sms',
  sensitive_action: 'emailAndSms',
  workspace_invitation: 'emailAndSms',
};

function newRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function GateBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? 'default' : 'outline'} className={ok ? 'bg-emerald-600/20 text-emerald-500 border-emerald-600/30' : 'text-muted-foreground'}>
      {label}
    </Badge>
  );
}

export default function AdminVerificationPage() {
  const { t, locale, dir } = useTranslation();
  const [tab, setTab] = useState('overview');
  const [editingPurpose, setEditingPurpose] = useState<VerificationPurpose | null>(null);
  const [auditFilter, setAuditFilter] = useState<VerificationPurpose | 'all'>('all');
  const [previewLocale, setPreviewLocale] = useState<Locale>(locale);

  const overview = useVerificationOverview();
  const audit = useVerificationAudit({ purpose: auditFilter === 'all' ? undefined : auditFilter, limit: 50 });
  const preview = useTemplatePreview();

  useEffect(() => {
    preview.mutate(previewLocale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewLocale]);

  const purposeName = (p: string) => t(`admin.verification.purposeNames.${p}` as any);
  const purposeDesc = (p: string) => t(`admin.verification.purposeDescriptions.${p}` as any);
  const channelLabel = (p: VerificationPurpose) => t(`admin.verification.channel.${CHANNELS[p]}` as any);

  return (
    <div className="space-y-6" dir={dir}>
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('admin.verification.title' as any)}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('admin.verification.subtitle' as any)}</p>
      </div>

      <Alert className="border-amber-500/40 bg-amber-500/10">
        <ShieldOff className="h-4 w-4 text-amber-500" />
        <AlertTitle className="text-amber-600">{t('admin.verification.banner.title' as any)}</AlertTitle>
        <AlertDescription>{t('admin.verification.banner.description' as any)}</AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">{t('admin.verification.tabOverview' as any)}</TabsTrigger>
          <TabsTrigger value="purposes">{t('admin.verification.tabPurposes' as any)}</TabsTrigger>
          <TabsTrigger value="preview">{t('admin.verification.preview.title' as any)}</TabsTrigger>
          <TabsTrigger value="audit">{t('admin.verification.tabAudit' as any)}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t('admin.verification.readiness.title' as any)}</CardTitle></CardHeader>
            <CardContent className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              <ReadinessRow
                icon={<Database className="h-4 w-4" />}
                label={t('admin.verification.readiness.database' as any)}
                ok={overview.data?.readiness.databaseAvailable ?? false}
                okText={t('admin.verification.readiness.databaseOk' as any)}
                badText={t('admin.verification.readiness.databaseError' as any)}
              />
              <ProviderReadinessRow
                icon={<Mail className="h-4 w-4" />}
                label={t('admin.verification.readiness.email' as any)}
                state={overview.data?.readiness.emailProviderStatus ?? 'unconfigured'}
                textFor={(s) => t(`admin.verification.readiness.email${s === 'configured' ? 'Ok' : s === 'unconfigured' ? 'Missing' : s === 'invalid' ? 'Invalid' : 'Unavailable'}` as any)}
              />
              <ProviderReadinessRow
                icon={<MessageSquare className="h-4 w-4" />}
                label={t('admin.verification.readiness.sms' as any)}
                state={overview.data?.readiness.smsProviderStatus ?? 'unconfigured'}
                textFor={(s) => t(`admin.verification.readiness.sms${s === 'configured' ? 'Ok' : s === 'unconfigured' ? 'Missing' : s === 'invalid' ? 'Invalid' : 'Unavailable'}` as any)}
              />
              <div className="rounded-lg border p-3 space-y-1 col-span-1 md:col-span-2 lg:col-span-3">
                <div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4" />{t('admin.verification.readiness.crypto' as any)}</div>
                <div className="text-sm text-muted-foreground">
                  {overview.data?.readiness.status === 'error'
                    ? `${t('admin.verification.readiness.cryptoError' as any)}${overview.data.readiness.cryptoErrorCode ? ` (${overview.data.readiness.cryptoErrorCode})` : ''}`
                    : overview.data?.readiness.pepperConfigured
                      ? t('admin.verification.readiness.cryptoConfigured' as any)
                      : t('admin.verification.readiness.cryptoUnconfigured' as any)}
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-1">
                  <span>{t('admin.verification.readiness.currentKeyVersion' as any)}: {overview.data?.readiness.currentKeyVersion ?? t('admin.verification.readiness.none' as any)}</span>
                  <span>{t('admin.verification.readiness.stableIndexVersion' as any)}: {overview.data?.readiness.stableIndexKeyVersion ?? '—'}</span>
                  <span>{t('admin.verification.readiness.configuredVersions' as any)}: {overview.data?.readiness.configuredKeyVersions.length ? overview.data.readiness.configuredKeyVersions.join(', ') : t('admin.verification.readiness.none' as any)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="purposes">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.verification.table.purpose' as any)}</TableHead>
                    <TableHead>{t('admin.verification.table.channel' as any)}</TableHead>
                    <TableHead>{t('admin.verification.table.adminConfigured' as any)}</TableHead>
                    <TableHead>{t('admin.verification.table.consumerReady' as any)}</TableHead>
                    <TableHead>{t('admin.verification.table.deploymentReady' as any)}</TableHead>
                    <TableHead>{t('admin.verification.table.effective' as any)}</TableHead>
                    <TableHead>{t('admin.verification.table.updated' as any)}</TableHead>
                    <TableHead className="text-end">{t('admin.verification.table.actions' as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(overview.data?.purposes ?? []).map((o) => (
                    <TableRow key={o.purpose}>
                      <TableCell>
                        <div className="font-medium">{purposeName(o.purpose)}</div>
                        <div className="text-xs text-muted-foreground">{purposeDesc(o.purpose)}</div>
                      </TableCell>
                      <TableCell>{channelLabel(o.purpose)}</TableCell>
                      <TableCell><YesNoBadge value={o.gates.adminEnabled} t={t} /></TableCell>
                      <TableCell><YesNoBadge value={o.gates.consumerImplemented} t={t} /></TableCell>
                      <TableCell><YesNoBadge value={o.gates.deploymentAllowlisted} t={t} /></TableCell>
                      <TableCell>
                        <Badge variant={o.gates.effectiveEnabled ? 'default' : 'secondary'}>
                          {o.gates.effectiveEnabled ? t('admin.verification.table.effectiveActive' as any) : t('admin.verification.table.effectiveDormant' as any)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {o.settings.updatedAt ? format(new Date(o.settings.updatedAt), 'PPp') : t('admin.verification.table.never' as any)}
                      </TableCell>
                      <TableCell className="text-end">
                        <Button size="sm" variant="outline" onClick={() => setEditingPurpose(o.purpose)}>
                          {t('admin.verification.table.edit' as any)}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('admin.verification.preview.title' as any)}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('admin.verification.preview.description' as any)}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Label>{t('admin.verification.preview.locale' as any)}</Label>
                <Select value={previewLocale} onValueChange={(v) => setPreviewLocale(v as Locale)}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="fa">فارسی</SelectItem>
                    <SelectItem value="tr">Türkçe</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">{t('admin.verification.preview.fakeCodeNotice' as any)}</p>
              {preview.isPending ? (
                <p className="text-sm text-muted-foreground">{t('admin.verification.preview.loading' as any)}</p>
              ) : preview.data ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t('admin.verification.preview.emailSubject' as any)}</div>
                    <div className="rounded border p-2 text-sm" dir={previewLocale === 'fa' ? 'rtl' : 'ltr'}>{preview.data.email.subject}</div>
                    <div className="text-sm font-medium">{t('admin.verification.preview.emailText' as any)}</div>
                    <pre className="rounded border p-2 text-sm whitespace-pre-wrap" dir={previewLocale === 'fa' ? 'rtl' : 'ltr'}>{preview.data.email.text}</pre>
                    <div className="text-sm font-medium">{t('admin.verification.preview.emailHtml' as any)}</div>
                    {/*
                      A fully locked-down sandbox: no script execution, no
                      origin-equivalent access to this app's cookies or
                      storage, no top-level navigation, no form submission,
                      no popups — this renders untrusted-shaped HTML (a real
                      send would build from the same template), so an empty
                      sandbox allow-list is deliberate and must stay empty.
                      Proven by a static test (adminPreviewSandbox.test.ts)
                      that fails the build if any allow-* token appears.
                    */}
                    <iframe
                      title={t('admin.verification.preview.iframeTitle' as any)}
                      sandbox=""
                      className="w-full h-40 rounded border"
                      srcDoc={preview.data.email.html}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t('admin.verification.preview.smsText' as any)}</div>
                    <div className="rounded border p-2 text-sm" dir={previewLocale === 'fa' ? 'rtl' : 'ltr'}>{preview.data.sms.text}</div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{t('admin.verification.audit.title' as any)}</CardTitle>
              <div className="flex items-center gap-2">
                <Label className="text-sm">{t('admin.verification.audit.filterByPurpose' as any)}</Label>
                <Select value={auditFilter} onValueChange={(v) => setAuditFilter(v as VerificationPurpose | 'all')}>
                  <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('admin.verification.audit.allPurposes' as any)}</SelectItem>
                    {Object.keys(CHANNELS).map((p) => (
                      <SelectItem key={p} value={p}>{purposeName(p)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.verification.audit.timestamp' as any)}</TableHead>
                    <TableHead>{t('admin.verification.audit.purpose' as any)}</TableHead>
                    <TableHead>{t('admin.verification.audit.action' as any)}</TableHead>
                    <TableHead>{t('admin.verification.audit.actor' as any)}</TableHead>
                    <TableHead>{t('admin.verification.audit.locale' as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(audit.data?.rows ?? []).length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">{t('admin.verification.audit.noRows' as any)}</TableCell></TableRow>
                  )}
                  {(audit.data?.rows ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">{format(new Date(row.createdAt), 'PPp')}</TableCell>
                      <TableCell>{purposeName(row.purpose)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {row.action === 'update' ? t('admin.verification.audit.actionUpdate' as any) : t('admin.verification.audit.actionReset' as any)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{row.actorProfileId ?? t('admin.verification.audit.unknownActor' as any)}</TableCell>
                      <TableCell className="text-xs">{row.locale ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {editingPurpose && (
        <PurposeEditorDialog
          purpose={editingPurpose}
          platformCeilings={overview.data?.platformCeilings}
          onClose={() => setEditingPurpose(null)}
        />
      )}
    </div>
  );
}

function ReadinessRow({ icon, label, ok, okText, badText }: { icon: React.ReactNode; label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="rounded-lg border p-3 space-y-1">
      <div className="flex items-center gap-2 text-sm font-medium">{icon}{label}</div>
      <div className={`text-sm ${ok ? 'text-emerald-500' : 'text-muted-foreground'}`}>{ok ? okText : badText}</div>
    </div>
  );
}

/**
 * Providers are one of FOUR safe states, never a boolean — a stored
 * provider_name with no usable credential ('invalid') and a readiness
 * check that could not reach the database ('unavailable') both need to
 * read differently from 'configured' and from 'unconfigured'.
 */
function ProviderReadinessRow({
  icon, label, state, textFor,
}: { icon: React.ReactNode; label: string; state: ProviderReadinessState; textFor: (s: ProviderReadinessState) => string }) {
  const colorClass = state === 'configured'
    ? 'text-emerald-500'
    : state === 'invalid' || state === 'unavailable'
      ? 'text-destructive'
      : 'text-muted-foreground';
  return (
    <div className="rounded-lg border p-3 space-y-1">
      <div className="flex items-center gap-2 text-sm font-medium">{icon}{label}</div>
      <div className={`text-sm ${colorClass}`}>{textFor(state)}</div>
    </div>
  );
}

function YesNoBadge({ value, t }: { value: boolean; t: (k: any) => string }) {
  return <GateBadge ok={value} label={value ? t('admin.verification.table.yes' as any) : t('admin.verification.table.no' as any)} />;
}

function PurposeEditorDialog({
  purpose, platformCeilings, onClose,
}: { purpose: VerificationPurpose; platformCeilings?: PlatformCeilings; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const detail = useVerificationPurpose(purpose);
  const updateMutation = useUpdatePurposeSettings();
  const resetMutation = useResetPurposeSettings();
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<ReturnType<typeof buildFormState> | null>(null);

  useEffect(() => {
    if (detail.data) setForm(buildFormState(detail.data.settings, locale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.settings.revision]);

  const gates = detail.data?.gates;
  const ceilings = platformCeilings ?? detail.data?.platformCeilings;

  const errorMessage = useMemo(() => {
    if (!error) return null;
    return t(`admin.verification.errors.${error}` as any) !== `admin.verification.errors.${error}`
      ? t(`admin.verification.errors.${error}` as any)
      : t('admin.verification.errors.generic' as any);
  }, [error, t]);

  if (!form || !detail.data) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent><DialogHeader><DialogTitle>{t('admin.verification.editor.title' as any, { purpose })}</DialogTitle></DialogHeader></DialogContent>
      </Dialog>
    );
  }

  async function handleSave() {
    if (!form) return;
    setError(null);
    try {
      await updateMutation.mutateAsync({
        purpose,
        payload: {
          requestId: newRequestId(),
          expectedRevision: detail.data!.settings.revision,
          adminEnabled: form.adminEnabled,
          otpLength: form.otpLength,
          otpTtlSeconds: form.otpTtlSeconds,
          maxVerificationAttempts: form.maxVerificationAttempts,
          resendCooldownSeconds: form.resendCooldownSeconds,
          maxSendsPerWindow: form.maxSendsPerWindow,
          rateWindowSeconds: form.rateWindowSeconds,
          proofTtlSeconds: form.proofTtlSeconds,
          globalRateLimitEnabled: form.globalRateLimitEnabled,
          globalRateLimitMaxPerWindow: form.globalRateLimitEnabled ? form.globalRateLimitMaxPerWindow : null,
          globalRateLimitWindowSeconds: form.globalRateLimitEnabled ? form.globalRateLimitWindowSeconds : null,
          defaultLocale: form.defaultLocale,
          locale,
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof VerificationAdminApiError ? err.code : 'generic');
    }
  }

  async function handleReset() {
    setError(null);
    try {
      await resetMutation.mutateAsync({ purpose, requestId: newRequestId(), expectedRevision: detail.data!.settings.revision, locale });
      setConfirmReset(false);
      onClose();
    } catch (err) {
      setError(err instanceof VerificationAdminApiError ? err.code : 'generic');
    }
  }

  const adminEnabledBlocked = !gates?.consumerImplemented || !gates?.deploymentAllowlisted;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('admin.verification.editor.title' as any, { purpose: t(`admin.verification.purposeNames.${purpose}` as any) })}</DialogTitle>
          <DialogDescription>{t('admin.verification.editor.description' as any)}</DialogDescription>
        </DialogHeader>

        {errorMessage && <Alert variant="destructive"><AlertDescription>{errorMessage}</AlertDescription></Alert>}

        <div className="space-y-4">
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium">{t('admin.verification.editor.gatesTitle' as any)}</div>
            <div className="flex flex-wrap gap-2">
              <GateBadge ok={!!gates?.adminEnabled} label={t('admin.verification.editor.gateAdmin' as any)} />
              <GateBadge ok={!!gates?.consumerImplemented} label={t('admin.verification.editor.gateConsumer' as any)} />
              <GateBadge ok={!!gates?.deploymentAllowlisted} label={t('admin.verification.editor.gateDeployment' as any)} />
              <GateBadge ok={!!gates?.databaseEnabled} label={t('admin.verification.editor.gateDatabase' as any)} />
              <GateBadge ok={!!gates?.effectiveEnabled} label={t('admin.verification.editor.gateEffective' as any)} />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="admin-enabled">{t('admin.verification.editor.adminEnabled' as any)}</Label>
              <p className="text-xs text-muted-foreground mt-1">
                {adminEnabledBlocked ? t('admin.verification.editor.adminEnabledHintBlocked' as any) : t('admin.verification.editor.adminEnabledHintOk' as any)}
              </p>
            </div>
            <Switch
              id="admin-enabled"
              checked={form.adminEnabled}
              disabled={adminEnabledBlocked}
              onCheckedChange={(v) => setForm({ ...form, adminEnabled: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <NumberField label={t('admin.verification.editor.otpLength' as any)} ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.otpLength ?? '') })}
              value={form.otpLength} onChange={(v) => setForm({ ...form, otpLength: v })} min={4} max={ceilings?.otpLength} />
            <NumberField label={t('admin.verification.editor.otpTtlSeconds' as any)} ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.otpTtlSeconds ?? '') })}
              value={form.otpTtlSeconds} onChange={(v) => setForm({ ...form, otpTtlSeconds: v })} min={30} max={ceilings?.otpTtlSeconds} />
            <NumberField label={t('admin.verification.editor.maxVerificationAttempts' as any)} ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.maxVerificationAttempts ?? '') })}
              value={form.maxVerificationAttempts} onChange={(v) => setForm({ ...form, maxVerificationAttempts: v })} min={1} max={ceilings?.maxVerificationAttempts} />
            <NumberField label={t('admin.verification.editor.resendCooldownSeconds' as any)} ceilingLabel={t('admin.verification.editor.floor' as any, { value: String(ceilings?.resendCooldownSecondsMin ?? '') })}
              value={form.resendCooldownSeconds} onChange={(v) => setForm({ ...form, resendCooldownSeconds: v })} min={ceilings?.resendCooldownSecondsMin} />
            <NumberField label={t('admin.verification.editor.maxSendsPerWindow' as any)} ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.maxSendsPerWindow ?? '') })}
              value={form.maxSendsPerWindow} onChange={(v) => setForm({ ...form, maxSendsPerWindow: v })} min={1} max={ceilings?.maxSendsPerWindow} />
            <NumberField label={t('admin.verification.editor.rateWindowSeconds' as any)} ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.rateWindowSeconds ?? '') })}
              value={form.rateWindowSeconds} onChange={(v) => setForm({ ...form, rateWindowSeconds: v })} min={60} max={ceilings?.rateWindowSeconds} />
            <NumberField label={t('admin.verification.editor.proofTtlSeconds' as any)} ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.proofTtlSeconds ?? '') })}
              value={form.proofTtlSeconds} onChange={(v) => setForm({ ...form, proofTtlSeconds: v })} min={30} max={ceilings?.proofTtlSeconds} />
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="global-rl">{t('admin.verification.editor.globalRateLimitEnabled' as any)}</Label>
              <Switch id="global-rl" checked={form.globalRateLimitEnabled} onCheckedChange={(v) => setForm({ ...form, globalRateLimitEnabled: v })} />
            </div>
            {form.globalRateLimitEnabled && (
              <div className="grid grid-cols-2 gap-4">
                <NumberField label={t('admin.verification.editor.globalRateLimitMaxPerWindow' as any)} value={form.globalRateLimitMaxPerWindow ?? 1}
                  onChange={(v) => setForm({ ...form, globalRateLimitMaxPerWindow: v })} min={1} />
                <NumberField label={t('admin.verification.editor.globalRateLimitWindowSeconds' as any)}
                  ceilingLabel={t('admin.verification.editor.ceiling' as any, { value: String(ceilings?.globalRateLimitWindowSecondsMax ?? '') })}
                  value={form.globalRateLimitWindowSeconds ?? 60} onChange={(v) => setForm({ ...form, globalRateLimitWindowSeconds: v })} min={60} max={ceilings?.globalRateLimitWindowSecondsMax} />
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label>{t('admin.verification.editor.defaultLocale' as any)}</Label>
            <Select value={form.defaultLocale} onValueChange={(v) => setForm({ ...form, defaultLocale: v as Locale })}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="fa">فارسی</SelectItem>
                <SelectItem value="tr">Türkçe</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="ghost" className="text-destructive gap-1" onClick={() => setConfirmReset(true)}>
            <RotateCcw className="h-4 w-4" />{t('admin.verification.editor.reset' as any)}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{t('admin.verification.editor.cancel' as any)}</Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? t('admin.verification.editor.saving' as any) : t('admin.verification.editor.save' as any)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.verification.editor.resetConfirmTitle' as any, { purpose: t(`admin.verification.purposeNames.${purpose}` as any) })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.verification.editor.resetConfirmDescription' as any)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin.verification.editor.cancel' as any)}</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset} disabled={resetMutation.isPending}>
              {t('admin.verification.editor.resetConfirmAction' as any)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function buildFormState(settings: PurposeOverview['settings'], _locale: Locale) {
  return {
    adminEnabled: settings.adminEnabled,
    otpLength: settings.otpLength,
    otpTtlSeconds: settings.otpTtlSeconds,
    maxVerificationAttempts: settings.maxVerificationAttempts,
    resendCooldownSeconds: settings.resendCooldownSeconds,
    maxSendsPerWindow: settings.maxSendsPerWindow,
    rateWindowSeconds: settings.rateWindowSeconds,
    proofTtlSeconds: settings.proofTtlSeconds,
    globalRateLimitEnabled: settings.globalRateLimitEnabled,
    globalRateLimitMaxPerWindow: settings.globalRateLimitMaxPerWindow,
    globalRateLimitWindowSeconds: settings.globalRateLimitWindowSeconds,
    defaultLocale: settings.defaultLocale,
  };
}

function NumberField({
  label, ceilingLabel, value, onChange, min, max,
}: { label: string; ceilingLabel?: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {ceilingLabel && <p className="text-xs text-muted-foreground">{ceilingLabel}</p>}
    </div>
  );
}
