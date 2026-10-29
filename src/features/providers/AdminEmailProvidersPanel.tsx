/**
 * ADMIN — EMAIL PROVIDERS
 *
 * The Email panel of Super Admin → Providers. It has its own panel, like SMS
 * and storage, because the generic vendor workspace read and wrote the whole
 * provider row through the browser (the relay's password came back into a
 * revealable input) and tested a browser stub that always answered "OK".
 * Everything here goes through /api/admin/providers/email
 * (server/routes/adminEmailProviders.ts):
 *
 *   - two slots: the platform provider (every mail) and an optional
 *     notification provider (the operator notification mails, when Super
 *     Admin → Notifications points them at it);
 *   - only vendors the server can send through can be saved; the others are
 *     listed as not available yet;
 *   - a stored password or key is never sent to the browser: it shows as
 *     saved, and a save that leaves it blank keeps it;
 *   - "Test connection" signs in to the saved provider without sending, and
 *     "Send test email" sends one mail through it to the admin's own
 *     address and shows what really happened;
 *   - who changed what, and when (the store's audit rows), and the list of
 *     addresses the platform no longer mails.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, History, Info, Loader2, Mail, RefreshCw, Send, TestTube, Trash2, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { useEdition } from '@/hooks/useEdition';
import { useI18n } from '@/i18n';
import { formatDateTime } from '@/lib/date';
import { cn } from '@/lib/utils';
import { isEmailProviderAdapter } from '../../../shared/emailProviders';
import { EMAIL_FIELD_GROUPS, getVendorsForEdition, type ProviderVendor } from './schemas';
import { ProviderConfigForm } from './ProviderConfigForm';
import { ProviderVendorRail, type VendorState } from './ProviderVendorRail';
import { EmailSuppressionsCard } from './EmailSuppressionsCard';
import {
  EMAIL_PROVIDERS_QUERY_KEY,
  EmailProviderApiError,
  fetchEmailProviders,
  removeEmailProvider,
  saveEmailProvider,
  sendEmailProviderTest,
  verifyEmailProviderSlot,
  type EmailProviderChange,
  type EmailProviderSlot,
  type EmailProvidersState,
} from './emailProviderApi';

const SLOTS: readonly EmailProviderSlot[] = ['default', 'notification'];

type Translate = ReturnType<typeof useI18n>['t'];

/** A translation, or the fallback when the key has none (t returns the key itself then). */
function tOr(t: Translate, key: string, fallback: string, vars?: Record<string, string | number>): string {
  const value = t(key as never, vars as never);
  return value === key ? fallback : value;
}

function fieldLabel(t: Translate, field: string): string {
  return tOr(t, `adminProviders.email.fields.${field}.label`, field);
}

const GROUP_IDS = Object.fromEntries(Object.entries(EMAIL_FIELD_GROUPS).map(([id, name]) => [name, id])) as Record<string, string>;

/**
 * An adapter vendor with its labels, hints, groups and choices in the
 * admin's language. The schema keeps English like every other provider
 * type; this page is the one a Persian-speaking owner configures mail on.
 */
function localizeEmailVendor(vendor: ProviderVendor, t: Translate): ProviderVendor {
  return {
    ...vendor,
    fields: vendor.fields.map((field) => ({
      ...field,
      label: fieldLabel(t, field.key),
      hint: field.hint ? tOr(t, `adminProviders.email.fields.${field.key}.hint`, field.hint) : undefined,
      group: field.group ? tOr(t, `adminProviders.email.groups.${GROUP_IDS[field.group] ?? ''}`, field.group) : undefined,
      options: field.options?.map((o) => ({ ...o, label: tOr(t, `adminProviders.email.${field.key}.${o.value}`, o.label) })),
    })),
  };
}

function stringValues(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) out[k] = typeof v === 'string' ? v : v == null ? '' : String(v);
  return out;
}

/** A refusal from the server, in words, with the field it names. */
function describeSaveError(t: Translate, err: unknown): { message: string; field?: string } {
  if (err instanceof EmailProviderApiError) {
    const field = err.field && err.field !== 'config' && err.field !== 'provider_name' ? err.field : undefined;
    const generic = t('adminProviders.email.errors.generic', { code: err.code });
    // A sentence about a field needs one; without it, the code is said as is.
    if (!field && /_field$/.test(err.code)) return { message: generic };
    return {
      message: tOr(t, `adminProviders.email.errors.${err.code}`, generic, { field: field ? fieldLabel(t, field) : '' }),
      field,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

interface TestOutcome {
  ok: boolean;
  title: string;
  detail: string;
}

function SlotStatus({ slot, state }: { slot: EmailProviderSlot; state: EmailProvidersState }) {
  const { t, locale } = useI18n();
  const slotState = state.slots[slot];
  const provider = slotState.provider_name;
  const tone = slotState.readiness === 'configured'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
    : slotState.readiness === 'invalid'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
      : 'border-border bg-muted text-muted-foreground';
  const change = slotState.lastChange;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">
          {provider ?? t('adminProviders.email.notSet')}
        </span>
        <Badge variant="outline" className={cn('h-5 text-[10px]', tone)} data-readiness={slotState.readiness}>
          {t(`adminProviders.email.status.${slotState.readiness}` as never)}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {change
            ? t('adminProviders.email.lastChange', {
                who: change.actor?.name || change.actor?.email || t('adminProviders.email.history.unknownUser'),
                when: formatDateTime(change.at, undefined, locale),
              })
            : t('adminProviders.email.noChange')}
        </span>
      </div>
      {provider && !isEmailProviderAdapter(provider) && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {t('adminProviders.email.noAdapter')}
        </p>
      )}
      {provider && isEmailProviderAdapter(provider) && slotState.problems.length > 0 && (
        <ul className="space-y-0.5">
          {slotState.problems.map((p) => (
            <li key={`${p.field}:${p.problem}`} className="flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {t(`adminProviders.email.problem.${p.problem}` as never, { field: fieldLabel(t, p.field) } as never)}
            </li>
          ))}
        </ul>
      )}
      {!provider && (
        <p
          className={cn(
            'flex items-start gap-1.5 text-xs',
            slot === 'default' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {slot === 'default'
            ? <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            : <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
          {slot === 'default' ? t('adminProviders.email.notSetDefault') : t('adminProviders.email.notSetNotification')}
        </p>
      )}
    </div>
  );
}

function EmailProviderSlotCard({ slot, state }: { slot: EmailProviderSlot; state: EmailProvidersState }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { edition } = useEdition();
  const slotState = state.slots[slot];
  const configured = slotState.provider_name;

  const vendors = useMemo(
    () => getVendorsForEdition('email', edition).map((v) => (isEmailProviderAdapter(v.name) ? localizeEmailVendor(v, t) : v)),
    [edition, t],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const listed = (name: string | null): name is string => !!name && vendors.some((v) => v.name === name);
  // The picked vendor, else the saved one, else the first that can send.
  const selected = listed(picked)
    ? picked
    : listed(configured) ? configured : vendors.find((v) => !v.comingSoon)?.name ?? '';
  const vendor = vendors.find((v) => v.name === selected);
  const isConfigured = !!configured && selected === configured;

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [saves, setSaves] = useState(0);

  const applyState = (next: EmailProvidersState) => qc.setQueryData(EMAIL_PROVIDERS_QUERY_KEY, next);
  const clearMessages = () => {
    setFieldErrors({});
    setFormError(null);
    setOutcome(null);
  };

  const save = useMutation({
    mutationFn: (values: Record<string, string>) => saveEmailProvider(slot, selected, values),
    onSuccess: (next) => {
      applyState(next);
      clearMessages();
      setSaves((n) => n + 1);
      toast({ title: t('adminProviders.email.saved'), description: vendor?.label ?? selected });
    },
    onError: (err) => {
      const { message, field } = describeSaveError(t, err);
      if (field && vendor?.fields.some((f) => f.key === field)) {
        setFieldErrors({ [field]: message });
        setFormError(null);
      } else {
        setFieldErrors({});
        setFormError(message);
      }
      toast({ title: t('adminProviders.email.saveFailed'), description: message, variant: 'destructive' });
    },
  });

  const remove = useMutation({
    mutationFn: () => removeEmailProvider(slot),
    onSuccess: (next) => {
      applyState(next);
      clearMessages();
      setRemoveOpen(false);
      setPicked(null);
      toast({ title: t('adminProviders.email.removed') });
    },
    onError: (err) => {
      setRemoveOpen(false);
      toast({ title: t('adminProviders.email.saveFailed'), description: describeSaveError(t, err).message, variant: 'destructive' });
    },
  });

  const rateLimited = (err: unknown) => err instanceof EmailProviderApiError && err.status === 429;

  const verify = useMutation({
    mutationFn: () => verifyEmailProviderSlot(slot),
    onMutate: () => setOutcome(null),
    onSuccess: (r) => setOutcome({
      ok: r.ok,
      title: r.ok ? t('adminProviders.email.testOk') : t('adminProviders.email.testFailed'),
      detail: r.detail,
    }),
    onError: (err) => setOutcome({
      ok: false,
      title: t('adminProviders.email.testFailed'),
      detail: rateLimited(err) ? t('adminProviders.email.rateLimited') : describeSaveError(t, err).message,
    }),
  });

  const sendTest = useMutation({
    mutationFn: () => sendEmailProviderTest(slot),
    onMutate: () => setOutcome(null),
    onSuccess: (r) => setOutcome(r.success
      ? {
          ok: true,
          title: t('adminProviders.email.sendOk', { email: r.to ?? state.testRecipient ?? '' }),
          detail: r.serverMessageId || r.id ? t('adminProviders.email.sendOkId', { id: r.serverMessageId || r.id || '' }) : '',
        }
      : {
          ok: false,
          title: tOr(t, `adminProviders.email.sendErrors.${r.errorCode ?? ''}`, t('adminProviders.email.sendFailed')),
          detail: r.error ?? '',
        }),
    onError: (err) => setOutcome({
      ok: false,
      title: t('adminProviders.email.sendFailed'),
      detail: rateLimited(err)
        ? t('adminProviders.email.rateLimited')
        : err instanceof EmailProviderApiError && err.code === 'no_admin_address'
          ? t('adminProviders.email.noTestRecipient')
          : describeSaveError(t, err).message,
    }),
  });

  const stateOf = (v: ProviderVendor): VendorState => (v.name === configured ? 'primary' : v.comingSoon ? 'soon' : 'idle');
  const badgeLabel = (s: VendorState): string | null => (
    s === 'primary' ? t('adminProviders.panel.vendorActive') : s === 'soon' ? t('adminProviders.email.notAvailable') : null
  );

  const canTest = isConfigured && slotState.readiness !== 'unconfigured';
  const busy = verify.isPending || sendTest.isPending;

  return (
    <Card className="border-border/60" data-email-slot={slot}>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
            <Mail className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{t(`adminProviders.email.slots.${slot}.title` as never)}</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{t(`adminProviders.email.slots.${slot}.desc` as never)}</p>
          </div>
        </div>

        <SlotStatus slot={slot} state={state} />

        {slot === 'default' && state.legacyReplyTo && (
          <p className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/20 p-2.5 text-[11px] text-muted-foreground leading-relaxed">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{t('adminProviders.email.legacyReplyTo', { email: state.legacyReplyTo })}</span>
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <div className="rounded-lg border border-border/60 p-2 h-fit">
            <ProviderVendorRail
              vendors={vendors}
              selected={selected}
              onSelect={(name) => {
                setPicked(name);
                clearMessages();
              }}
              stateOf={stateOf}
              badgeLabel={badgeLabel}
              subtitleOf={(v) => (v.comingSoon ? t('adminProviders.email.notAvailable') : null)}
            />
          </div>

          <div className="min-w-0 space-y-3">
            {!vendor ? (
              <p className="text-xs text-muted-foreground py-6 text-center">{t('adminProviders.panel.noVendorMatch')}</p>
            ) : vendor.comingSoon ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3" data-not-available>
                <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground leading-relaxed">{t('adminProviders.email.notAvailableDesc')}</p>
              </div>
            ) : (
              <>
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-relaxed">
                  {isConfigured
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                    : <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                  {isConfigured ? t('adminProviders.email.activeNote') : t('adminProviders.email.inactiveNote')}
                </p>
                {formError && (
                  <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                    <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {formError}
                  </p>
                )}
                <ProviderConfigForm
                  key={`${slot}:${selected}:${configured ?? ''}:${saves}`}
                  vendor={vendor}
                  initialValues={isConfigured ? stringValues(slotState.config) : {}}
                  savedSecretKeys={isConfigured ? slotState.secretKeysSet : undefined}
                  fieldErrors={fieldErrors}
                  dense
                  hideVendorHeader
                  isPending={save.isPending}
                  submitLabel={isConfigured ? t('adminProviders.panel.saveChanges') : t('adminProviders.panel.saveActivate')}
                  onSubmit={(values) => save.mutate(values)}
                  extraActions={
                    <>
                      <Button
                        type="button" variant="outline" size="sm"
                        onClick={() => verify.mutate()}
                        disabled={!canTest || busy}
                        title={canTest ? undefined : t('adminProviders.email.testNeedsSave')}
                      >
                        {verify.isPending
                          ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                          : <TestTube className="h-3.5 w-3.5 me-1.5" />}
                        {t('adminProviders.email.testConnection')}
                      </Button>
                      <Button
                        type="button" variant="outline" size="sm"
                        onClick={() => sendTest.mutate()}
                        disabled={!canTest || busy || !state.testRecipient}
                        title={canTest ? undefined : t('adminProviders.email.testNeedsSave')}
                      >
                        {sendTest.isPending
                          ? <Loader2 className="h-3.5 w-3.5 me-1.5 animate-spin" />
                          : <Send className="h-3.5 w-3.5 me-1.5" />}
                        {t('adminProviders.email.sendTest')}
                      </Button>
                      {isConfigured && (
                        <Button
                          type="button" variant="ghost" size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setRemoveOpen(true)}
                        >
                          <Trash2 className="h-3.5 w-3.5 me-1.5" />
                          {t('adminProviders.email.remove')}
                        </Button>
                      )}
                    </>
                  }
                />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {!canTest
                    ? t('adminProviders.email.testNeedsSave')
                    : state.testRecipient
                      ? t('adminProviders.email.sendTestTo', { email: state.testRecipient })
                      : t('adminProviders.email.noTestRecipient')}
                </p>
                {outcome && (
                  <div
                    role="status"
                    data-test-outcome={outcome.ok ? 'ok' : 'failed'}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border p-2.5',
                      outcome.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5',
                    )}
                  >
                    {outcome.ok
                      ? <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                      : <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-xs font-medium text-foreground">{outcome.title}</p>
                      {outcome.detail && (
                        <p dir="ltr" className="text-[11px] font-mono text-muted-foreground break-words text-start">{outcome.detail}</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent className="admin-scope bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">{t('adminProviders.email.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {slot === 'default' ? t('adminProviders.email.removeDescDefault') : t('adminProviders.email.removeDescNotification')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              {t('adminProviders.form.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()} disabled={remove.isPending}>
              {t('adminProviders.email.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function EmailProviderHistoryCard({ history }: { history: EmailProviderChange[] }) {
  const { t, locale } = useI18n();
  const separator = locale === 'fa' ? '، ' : ', ';
  const providerName = (name: string | null) => (
    !name || name === 'disabled' ? t('adminProviders.email.history.none') : name
  );
  return (
    <Card className="border-border/60">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-muted text-muted-foreground shrink-0">
            <History className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{t('adminProviders.email.history.title')}</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{t('adminProviders.email.history.desc')}</p>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">{t('adminProviders.email.history.empty')}</p>
        ) : (
          <ul className="space-y-1.5" data-email-history>
            {history.map((change, i) => (
              <li key={`${change.at}:${i}`} className="rounded-md border border-border px-3 py-2 text-xs space-y-0.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {change.actor?.name || change.actor?.email || t('adminProviders.email.history.unknownUser')}
                  </span>
                  <span className="text-muted-foreground">{formatDateTime(change.at, undefined, locale)}</span>
                </div>
                <p className="text-muted-foreground">
                  {t(`adminProviders.email.history.slot.${change.slot}` as never)}
                  {' · '}
                  <span dir="ltr">
                    {change.previous_provider !== change.provider_name
                      ? `${providerName(change.previous_provider)} → ${providerName(change.provider_name)}`
                      : providerName(change.provider_name)}
                  </span>
                </p>
                {change.changed_fields.filter((f) => f !== 'provider_name').length > 0 && (
                  <p className="text-muted-foreground">
                    {t('adminProviders.email.history.fields', {
                      fields: change.changed_fields.filter((f) => f !== 'provider_name').map((f) => fieldLabel(t, f)).join(separator),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminEmailProvidersPanel() {
  const { t } = useI18n();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: EMAIL_PROVIDERS_QUERY_KEY,
    queryFn: fetchEmailProviders,
  });

  if (isLoading) {
    return (
      <Card className="border-border/60">
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-destructive">{t('adminProviders.email.loadFailed')}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" />
            {t('adminProviders.email.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-email-providers>
      {!data.encryptionAvailable && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-muted-foreground leading-relaxed">
          <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
          {t('adminProviders.email.encryptionUnavailable')}
        </p>
      )}
      {SLOTS.map((slot) => <EmailProviderSlotCard key={slot} slot={slot} state={data} />)}
      <EmailSuppressionsCard />
      <EmailProviderHistoryCard history={data.history} />
    </div>
  );
}
