/**
 * WORKSPACE INVITATIONS v5.1 — invited-user flow (Express only).
 *
 * Token hygiene (v5.1 §5.5, §12):
 *   - The raw token arrives ONLY in the URL fragment (`/invite#token=...`).
 *   - It is read once, `history.replaceState` clears it immediately, and it
 *     lives only in module-scope memory for the lifetime of this flow.
 *   - It is never written to localStorage/sessionStorage, never sent to
 *     analytics or error tracking, never placed in a redirect URL or toast.
 *   - Every API call posts it in a JSON body over the same origin.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { API_BASE } from '@/lib/apiBase';
import { toast } from '@/lib/toast';
import { useAuth } from '@/features/auth/AuthContext';
import { invitationErrorKey } from '@/features/invitations/errors';
import { formatDateTime } from '@/lib/date';
import { useRequestIdBook } from '@/features/invitations/requestIds';
import { Loader2, CheckCircle2, XCircle, Building2, ShieldAlert, LogIn, Clock } from 'lucide-react';

type Purpose = 'email_claim' | 'manual_handoff';

type FlowState =
  | 'loading'
  | 'invalid'
  | 'otp_required'
  | 'ready'
  | 'accepting'
  | 'account_exists_login_required'
  | 'seat_limit_reached'
  | 'entitlement_unavailable'
  | 'wrong_account'
  | 'session_failed_login_required'
  | 'accepted';

interface Preview {
  invitation_id: string;
  workspace_id: string;
  workspace_name: string;
  purpose: Purpose;
  role: string;
  member_type: string;
  first_name: string;
  last_name: string;
  job_title: string | null;
  expires_at: string | null;
  masked_email: string;
  masked_phone: string | null;
  requires_otp: boolean;
  account_exists: boolean;
  inviter_name?: string | null;
  department_names?: string[] | null;
}

interface PolicyVersion {
  id: string;
  version: string;
  document_url: string | null;
}

/** Reads and immediately erases the token from the URL fragment. */
function consumeFragmentToken(): { token: string | null; purpose: Purpose } {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  const purpose: Purpose = params.get('p') === 'm' ? 'manual_handoff' : 'email_claim';
  if (raw) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return { token, purpose };
}

/**
 * Phase 0.4 — no invitation mutation may leave the UI stuck. A rejected fetch,
 * an aborted request, a non-JSON body or a 5xx all resolve to a normal result
 * with `transportUnknown = true`, so the caller can re-enable its button and
 * RETRY WITH THE SAME requestId (the server may already have committed).
 */
async function postJson(path: string, body: unknown, timeoutMs = 30_000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    let data: any = {};
    try { data = await res.json(); } catch { data = {}; }
    return { ok: res.ok, status: res.status, data, transportUnknown: res.status >= 500 } as const;
  } catch {
    // Network rejection / abort / timeout: outcome genuinely unknown.
    return { ok: false, status: 0, data: {} as any, transportUnknown: true } as const;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default function InvitePage() {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const { user, isLoading: authLoading, signOut } = useAuth();
  /**
   * Stable, in-memory request ids (v5.1 B.1). Never persisted; a transport
   * retry of the same logical action reuses the id, a new action mints one.
   */
  const requestIds = useRequestIdBook();
  const otpDeliveredRef = useRef(false);
  /**
   * Phase 0.3 — request-id intents must stay NON-SECRET. Instead of hashing the
   * raw token/password/code into the in-memory book, each secret-bearing input
   * owns a revision counter that is bumped on change: a different value is a
   * new logical action, an unchanged retry reuses the same id, and no secret
   * is ever retained.
   */
  const secretRevRef = useRef<Record<string, number>>({});
  const rev = (key: string) => secretRevRef.current[key] ?? 0;
  const bumpRev = (key: string) => { secretRevRef.current[key] = rev(key) + 1; };
  const [existingContinuation, setExistingContinuation] = useState(false);

  // Module-lifetime secret: never persisted anywhere.
  const tokenRef = useRef<string | null>(null);
  const purposeRef = useRef<Purpose>('email_claim');
  const initializedRef = useRef(false);

  const [state, setState] = useState<FlowState>('loading');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [policies, setPolicies] = useState<{ terms: PolicyVersion | null; privacy: PolicyVersion | null }>({ terms: null, privacy: null });
  const [otpCode, setOtpCode] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [consent, setConsent] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);


  const loadPreview = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) {
      const { ok, data } = await postJson('/api/workspace-invitations/context-preview', { locale });
      if (!ok || !data?.preview) { setState('invalid'); return; }
      setPreview(data.preview as Preview);
      setPolicies(data.policies || { terms: null, privacy: null });
      setExistingContinuation(true);
      setState(user ? 'ready' : 'account_exists_login_required');
      return;
    }

    const { ok, data } = await postJson('/api/workspace-invitations/preview', {
      token,
      purpose: purposeRef.current,
      locale,
    });
    if (!ok || !data?.preview) { setState('invalid'); return; }

    setPreview(data.preview as Preview);
    setPolicies(data.policies || { terms: null, privacy: null });

    if ((data.preview as Preview).account_exists) {
      setState('account_exists_login_required');
    } else if ((data.preview as Preview).requires_otp) {
      setState('otp_required');
    } else {
      setState('ready');
    }
  }, [locale, user]);

  useEffect(() => {
    if (authLoading || initializedRef.current) return;
    initializedRef.current = true;
    const { token, purpose } = consumeFragmentToken();
    tokenRef.current = token;
    purposeRef.current = purpose;
    void loadPreview();
  }, [loadPreview, authLoading]);

  const acceptExisting = async () => {
    if (!policies.terms || !policies.privacy) return;
    setState('accepting');
    const { ok, data, transportUnknown } = await postJson('/api/workspace-invitations/accept-existing', {
      requestId: requestIds.get('accept_existing', `${policies.terms.id}|${policies.privacy.id}|${locale}`),
      consent: true,
      termsVersionId: policies.terms.id,
      privacyVersionId: policies.privacy.id,
      locale,
    });
    if (!ok) {
      if (transportUnknown) {
        setState(user ? 'ready' : 'account_exists_login_required');
        toast.error(t('invite.networkError'));
        return;
      }
      const code = String(data?.error || 'INVITATION_NOT_FOUND');
      setErrorCode(code);
      if (code === 'WRONG_ACCOUNT') setState('wrong_account');
      else if (code === 'SEAT_LIMIT_REACHED') setState('seat_limit_reached');
      else if (code === 'ENTITLEMENT_UNAVAILABLE') setState('entitlement_unavailable');
      else if (code === 'SESSION_REQUIRED') setState('account_exists_login_required');
      else setState('invalid');
      return;
    }
    setState('accepted');
    setTimeout(() => { window.location.href = '/app'; }, 1200);
  };

  const requestOtp = async () => {
    if (!tokenRef.current) return;
    setOtpSending(true);
    // An explicit "send me another code" after a confirmed delivery is a NEW
    // logical action; a transport retry of the same click is not.
    if (otpDeliveredRef.current) {
      requestIds.reset('otp_request');
      otpDeliveredRef.current = false;
    }
    let ok = false; let status = 0; let transportUnknown = false;
    try {
      ({ ok, status, transportUnknown } = await postJson('/api/workspace-invitations/otp/request', {
        requestId: requestIds.get('otp_request'),
        token: tokenRef.current,
        purpose: purposeRef.current,
      }));
    } finally {
      // The button is ALWAYS actionable again, whatever the transport did.
      setOtpSending(false);
    }
    if (!ok) {
      if (transportUnknown) {
        // Outcome unknown: keep the SAME requestId so the retry is a replay.
        toast.error(t('invite.networkError'));
        return;
      }
      toast.error(status === 429
        ? t('invite.otpRateLimited')
        : t('invite.otpFailed'));
      return;
    }
    otpDeliveredRef.current = true;
    toast.success(t('invite.otpSent'));
  };

  const verifyOtp = async () => {
    if (!tokenRef.current) return;
    const { ok, status, transportUnknown } = await postJson('/api/workspace-invitations/otp/verify', {
      requestId: requestIds.get('otp_verify', `code-rev:${rev('otp_verify')}`),
      token: tokenRef.current,
      purpose: purposeRef.current,
      code: otpCode,
    });
    if (!ok) {
      if (transportUnknown) {
        toast.error(t('invite.networkError'));
        return;
      }
      toast.error(status === 429
        ? t('invite.otpRateLimited')
        : t('invite.otpInvalid'));
      return;
    }
    setOtpCode('');
    setState('ready');
  };

  const goToLogin = async () => {
    if (!tokenRef.current) return;
    // The token is exchanged for a short-lived HttpOnly context cookie; the
    // redirect URL below carries no invitation secret at all.
    const { ok, data, transportUnknown } = await postJson('/api/workspace-invitations/login-context', {
      requestId: requestIds.get('login_context'),
      token: tokenRef.current,
      purpose: purposeRef.current,
    });
    if (!ok) {
      if (transportUnknown) {
        toast.error(t('invite.networkError'));
        return; // token kept: the same logical action may be retried
      }
      tokenRef.current = null;
      setState('invalid');
      return;
    }
    tokenRef.current = null;
    navigate(String(data?.loginPath || '/auth/login?invited=1'));
  };

  const acceptNew = async () => {
    if (!tokenRef.current || !policies.terms || !policies.privacy) return;
    if (password.length < 10 || password !== confirm) {
      toast.error(t('invite.passwordMismatch'));
      return;
    }
    setState('accepting');
    const { ok, data, transportUnknown } = await postJson('/api/workspace-invitations/accept-new', {
      requestId: requestIds.get(
        'accept_new',
        // Intent = NON-SECRET revision + consent versions + purpose. Changing
        // the password bumps the revision, so it is a new logical action, and
        // the raw password/token is never retained anywhere.
        `pw-rev:${rev('accept_new')}|${policies.terms.id}|${policies.privacy.id}|${purposeRef.current}`,
      ),
      token: tokenRef.current,
      purpose: purposeRef.current,
      password,
      consent: true,
      termsVersionId: policies.terms.id,
      privacyVersionId: policies.privacy.id,
      locale,
    });
    if (!ok) {
      if (transportUnknown) {
        // Unknown outcome: stay retryable and KEEP the same requestId.
        setState('ready');
        toast.error(t('invite.networkError'));
        return;
      }
      setPassword('');
      setConfirm('');
      const code = String(data?.error || 'INVITATION_NOT_FOUND');
      setErrorCode(code);
      if (code === 'ACCOUNT_EXISTS_LOGIN_REQUIRED') setState('account_exists_login_required');
      else if (code === 'SEAT_LIMIT_REACHED') setState('seat_limit_reached');
      else if (code === 'ENTITLEMENT_UNAVAILABLE') setState('entitlement_unavailable');
      else if (code === 'EMAIL_PROOF_REQUIRED') setState('otp_required');
      else setState('invalid');
      return;
    }

    setPassword('');
    setConfirm('');
    tokenRef.current = null;
    if (data?.session === 'SESSION_CREATE_FAILED_LOGIN_REQUIRED') {
      setState('session_failed_login_required');
      return;
    }
    setState('accepted');
    setTimeout(() => { window.location.href = '/app'; }, 1200);
  };

  const card = (icon: React.ReactNode, title: string, description: string, action?: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-3">
          <div className="flex justify-center">{icon}</div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {action ? <CardContent className="space-y-3">{action}</CardContent> : null}
      </Card>
    </div>
  );

  if (state === 'loading') {
    return card(<Loader2 className="h-8 w-8 animate-spin text-primary" />,
      t('invite.loading'), '');
  }

  if (state === 'invalid') {
    return card(<XCircle className="h-8 w-8 text-destructive" />,
      t('invite.invalidTitle'),
      t('invite.invalidBody'));
  }

  if (state === 'seat_limit_reached') {
    return card(<ShieldAlert className="h-8 w-8 text-destructive" />,
      t('invite.seatLimitTitle'),
      t('invite.seatLimitBody'));
  }

  if (state === 'entitlement_unavailable') {
    return card(<ShieldAlert className="h-8 w-8 text-destructive" />,
      t('invite.entitlementTitle'),
      t('invite.entitlementBody'));
  }

  if (state === 'account_exists_login_required') {
    return card(<LogIn className="h-8 w-8 text-primary" />,
      t('invite.loginTitle'),
      t('invite.loginBody'),
      <Button className="w-full" onClick={goToLogin}>{t('invite.goToLogin')}</Button>);
  }

  if (state === 'wrong_account') {
    return card(<ShieldAlert className="h-8 w-8 text-destructive" />,
      t('invite.wrongAccountTitle'),
      t('invite.wrongAccountBody'),
      <div className="space-y-3">
        {user?.email ? (
          <p className="text-center text-xs text-muted-foreground">
            {t('invite.wrongAccountSignedInAs')}: <span dir="ltr">{user.email}</span>
          </p>
        ) : null}
        <Button
          className="w-full"
          variant="outline"
          onClick={async () => { await signOut(); navigate('/auth/login?invited=1'); }}
        >
          {t('invite.signOutAndSwitch')}
        </Button>
      </div>);
  }

  if (state === 'session_failed_login_required') {
    return card(<CheckCircle2 className="h-8 w-8 text-primary" />,
      t('invite.sessionFailedTitle'),
      t('invite.sessionFailedBody'),
      <Button className="w-full" onClick={() => navigate('/auth/login')}>{t('invite.goToLogin')}</Button>);
  }

  if (state === 'accepted') {
    return card(<CheckCircle2 className="h-8 w-8 text-emerald-500" />,
      t('invite.acceptedTitle'),
      t('invite.acceptedBody'));
  }

  const header = (
    <CardHeader className="space-y-3">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-primary" />
        <div>
          <CardTitle>{preview?.workspace_name}</CardTitle>
          <CardDescription>
            {t('invite.invitedAs')}{' '}
            <Badge variant="secondary">
              {preview?.role ? t(`invitations.roles.${preview.role}` as never) : ''}
            </Badge>
          </CardDescription>
        </div>
      </div>
      <div className="text-sm text-muted-foreground space-y-1">
        <div>{preview?.first_name} {preview?.last_name}</div>
        <div dir="ltr" className="text-start">{preview?.masked_email}</div>
        {preview?.masked_phone ? <div dir="ltr" className="text-start">{preview.masked_phone}</div> : null}
        <div>
          {preview?.member_type === 'staff' ? t('invite.memberTypeStaff') : t('invite.memberTypeCustomer')}
        </div>
        {preview?.inviter_name ? (
          <div>{t('invite.invitedBy')}: {preview.inviter_name}</div>
        ) : null}
        {preview?.department_names?.length ? (
          <div>{t('invite.departments')}: {preview.department_names.join('، ')}</div>
        ) : null}
        {preview?.expires_at ? (
          <div className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {t('invite.expiresAt')}: {formatDateTime(preview.expires_at, locale)}
          </div>
        ) : null}
      </div>
    </CardHeader>
  );

  if (state === 'otp_required') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md">
          {header}
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('invite.otpBody')}
            </p>
            <Button variant="outline" className="w-full" onClick={requestOtp} disabled={otpSending}>
              {otpSending ? <Loader2 className="h-4 w-4 animate-spin" /> : t('invite.sendCode')}
            </Button>
            <div className="space-y-2">
              <Label htmlFor="otp">{t('invite.code')}</Label>
              <Input id="otp" inputMode="numeric" maxLength={6} value={otpCode}
                     onChange={(e) => { bumpRev('otp_verify'); setOtpCode(e.target.value.replace(/\D/g, '')); }} />
            </div>
            <Button className="w-full" disabled={otpCode.length !== 6} onClick={verifyOtp}>
              {t('invite.verify')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        {header}
        <CardContent className="space-y-4">
          {!existingContinuation ? <><div className="space-y-2">
            <Label htmlFor="pw">{t('invite.password')}</Label>
            <Input id="pw" type="password" value={password} autoComplete="new-password"
                   onChange={(e) => { bumpRev('accept_new'); setPassword(e.target.value); }} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw2">{t('invite.confirmPassword')}</Label>
            <Input id="pw2" type="password" value={confirm} autoComplete="new-password"
                   onChange={(e) => { bumpRev('accept_new'); setConfirm(e.target.value); }} />
          </div></> : null}

          <div className="flex items-start gap-2">
            <Checkbox id="consent" checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
            <Label htmlFor="consent" className="text-sm font-normal leading-5">
              {t('invite.consent')}
              {policies.terms?.document_url ? (
                <> — <a className="underline" href={policies.terms.document_url} target="_blank" rel="noreferrer">
                  {t('invite.terms')}
                </a></>
              ) : null}
              {policies.privacy?.document_url ? (
                <> · <a className="underline" href={policies.privacy.document_url} target="_blank" rel="noreferrer">
                  {t('invite.privacy')}
                </a></>
              ) : null}
            </Label>
          </div>

          {!policies.terms || !policies.privacy ? (
            <p className="text-xs text-destructive">
              {t('invite.policiesMissing')}
            </p>
          ) : null}

          {errorCode ? (
            <p className="text-xs text-destructive" role="alert">{t(invitationErrorKey(errorCode))}</p>
          ) : null}

          <Button
            className="w-full"
            disabled={state === 'accepting' || !consent || !policies.terms || !policies.privacy}
            onClick={existingContinuation ? acceptExisting : acceptNew}
          >
            {state === 'accepting'
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : t('invite.accept')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
