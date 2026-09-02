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
}

interface PolicyVersion {
  id: string;
  version: string;
  document_url: string | null;
}

const tt = (t: any, key: string, fallback: string) => {
  const val = t(key);
  return val === key ? fallback : val;
};

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

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data } as const;
}

export default function InvitePage() {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();
  /**
   * Stable, in-memory request ids (v5.1 B.1). Never persisted; a transport
   * retry of the same logical action reuses the id, a new action mints one.
   */
  const requestIds = useRequestIdBook();
  const otpDeliveredRef = useRef(false);
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
    const { ok, data } = await postJson('/api/workspace-invitations/accept-existing', {
      requestId: requestIds.get('accept_existing', `${policies.terms.id}|${policies.privacy.id}|${locale}`),
      consent: true,
      termsVersionId: policies.terms.id,
      privacyVersionId: policies.privacy.id,
      locale,
    });
    if (!ok) {
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
    const { ok, status } = await postJson('/api/workspace-invitations/otp/request', {
      requestId: requestIds.get('otp_request'),
      token: tokenRef.current,
      purpose: purposeRef.current,
    });
    setOtpSending(false);
    if (!ok) {
      toast.error(status === 429
        ? tt(t, 'invite.otpRateLimited', 'Too many requests. Try again shortly.')
        : tt(t, 'invite.otpFailed', 'Could not send the code.'));
      return;
    }
    otpDeliveredRef.current = true;
    toast.success(tt(t, 'invite.otpSent', 'Verification code sent to your email.'));
  };

  const verifyOtp = async () => {
    if (!tokenRef.current) return;
    const { ok, status } = await postJson('/api/workspace-invitations/otp/verify', {
      requestId: requestIds.get('otp_verify', otpCode),
      token: tokenRef.current,
      purpose: purposeRef.current,
      code: otpCode,
    });
    if (!ok) {
      toast.error(status === 429
        ? tt(t, 'invite.otpRateLimited', 'Too many attempts. Try again later.')
        : tt(t, 'invite.otpInvalid', 'Invalid or expired code.'));
      return;
    }
    setOtpCode('');
    setState('ready');
  };

  const goToLogin = async () => {
    if (!tokenRef.current) return;
    // The token is exchanged for a short-lived HttpOnly context cookie; the
    // redirect URL below carries no invitation secret at all.
    const { ok, data } = await postJson('/api/workspace-invitations/login-context', {
      requestId: requestIds.get('login_context'),
      token: tokenRef.current,
      purpose: purposeRef.current,
    });
    tokenRef.current = null;
    if (!ok) { setState('invalid'); return; }
    navigate(String(data?.loginPath || '/auth/login?invited=1'));
  };

  const acceptNew = async () => {
    if (!tokenRef.current || !policies.terms || !policies.privacy) return;
    if (password.length < 10 || password !== confirm) {
      toast.error(tt(t, 'invite.passwordMismatch', 'Passwords must match and be at least 10 characters.'));
      return;
    }
    setState('accepting');
    const { ok, data } = await postJson('/api/workspace-invitations/accept-new', {
      requestId: requestIds.get(
        'accept_new',
        // Intent = token + password + consent versions. Changing any of them is
        // a new logical action, so the server must not replay the old one.
        `${tokenRef.current}|${password}|${policies.terms.id}|${policies.privacy.id}|${purposeRef.current}`,
      ),
      token: tokenRef.current,
      purpose: purposeRef.current,
      password,
      consent: true,
      termsVersionId: policies.terms.id,
      privacyVersionId: policies.privacy.id,
      locale,
    });
    setPassword('');
    setConfirm('');

    if (!ok) {
      const code = String(data?.error || 'INVITATION_NOT_FOUND');
      setErrorCode(code);
      if (code === 'ACCOUNT_EXISTS_LOGIN_REQUIRED') setState('account_exists_login_required');
      else if (code === 'SEAT_LIMIT_REACHED') setState('seat_limit_reached');
      else if (code === 'ENTITLEMENT_UNAVAILABLE') setState('entitlement_unavailable');
      else if (code === 'EMAIL_PROOF_REQUIRED') setState('otp_required');
      else setState('invalid');
      return;
    }

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
      tt(t, 'invite.loading', 'Checking your invitation…'), '');
  }

  if (state === 'invalid') {
    return card(<XCircle className="h-8 w-8 text-destructive" />,
      tt(t, 'invite.invalidTitle', 'Invitation unavailable'),
      tt(t, 'invite.invalidBody', 'This invitation link is invalid, expired, revoked or already used. Ask your workspace administrator for a new invitation.'));
  }

  if (state === 'seat_limit_reached') {
    return card(<ShieldAlert className="h-8 w-8 text-destructive" />,
      tt(t, 'invite.seatLimitTitle', 'No seats available'),
      tt(t, 'invite.seatLimitBody', 'This workspace has reached its member limit. Your invitation is still valid — ask an administrator to free a seat or upgrade the plan.'));
  }

  if (state === 'entitlement_unavailable') {
    return card(<ShieldAlert className="h-8 w-8 text-destructive" />,
      tt(t, 'invite.entitlementTitle', 'Temporarily unavailable'),
      tt(t, 'invite.entitlementBody', 'Membership limits cannot be verified right now. Please try again shortly.'));
  }

  if (state === 'account_exists_login_required') {
    return card(<LogIn className="h-8 w-8 text-primary" />,
      tt(t, 'invite.loginTitle', 'Sign in to accept'),
      tt(t, 'invite.loginBody', 'An account already exists for this email address. Sign in and you will be returned here to accept the invitation.'),
      <Button className="w-full" onClick={goToLogin}>{tt(t, 'invite.goToLogin', 'Continue to sign in')}</Button>);
  }

  if (state === 'wrong_account') {
    return card(<ShieldAlert className="h-8 w-8 text-destructive" />,
      tt(t, 'invite.wrongAccountTitle', 'This invitation belongs to another account'),
      tt(t, 'invite.wrongAccountBody', 'Sign out and use the email address shown on the invitation.'));
  }

  if (state === 'session_failed_login_required') {
    return card(<CheckCircle2 className="h-8 w-8 text-primary" />,
      tt(t, 'invite.sessionFailedTitle', 'Membership created'),
      tt(t, 'invite.sessionFailedBody', 'Your membership is active but the session could not be started. Please sign in.'),
      <Button className="w-full" onClick={() => navigate('/auth/login')}>{tt(t, 'invite.goToLogin', 'Continue to sign in')}</Button>);
  }

  if (state === 'accepted') {
    return card(<CheckCircle2 className="h-8 w-8 text-emerald-500" />,
      tt(t, 'invite.acceptedTitle', 'Welcome aboard'),
      tt(t, 'invite.acceptedBody', 'Your membership is active. Taking you to the workspace…'));
  }

  const header = (
    <CardHeader className="space-y-3">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-primary" />
        <div>
          <CardTitle>{preview?.workspace_name}</CardTitle>
          <CardDescription>
            {tt(t, 'invite.invitedAs', 'Invited as')} <Badge variant="secondary">{preview?.role}</Badge>
          </CardDescription>
        </div>
      </div>
      <div className="text-sm text-muted-foreground space-y-1">
        <div>{preview?.first_name} {preview?.last_name}</div>
        <div>{preview?.masked_email}</div>
        {preview?.expires_at ? (
          <div className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {tt(t, 'invite.expiresAt', 'Expires')}: {new Date(preview.expires_at).toLocaleString(locale)}
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
              {tt(t, 'invite.otpBody', 'To continue, verify the email address on this invitation with a one-time code.')}
            </p>
            <Button variant="outline" className="w-full" onClick={requestOtp} disabled={otpSending}>
              {otpSending ? <Loader2 className="h-4 w-4 animate-spin" /> : tt(t, 'invite.sendCode', 'Send code')}
            </Button>
            <div className="space-y-2">
              <Label htmlFor="otp">{tt(t, 'invite.code', 'Verification code')}</Label>
              <Input id="otp" inputMode="numeric" maxLength={6} value={otpCode}
                     onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))} />
            </div>
            <Button className="w-full" disabled={otpCode.length !== 6} onClick={verifyOtp}>
              {tt(t, 'invite.verify', 'Verify')}
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
            <Label htmlFor="pw">{tt(t, 'invite.password', 'Create a password')}</Label>
            <Input id="pw" type="password" value={password} autoComplete="new-password"
                   onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw2">{tt(t, 'invite.confirmPassword', 'Confirm password')}</Label>
            <Input id="pw2" type="password" value={confirm} autoComplete="new-password"
                   onChange={(e) => setConfirm(e.target.value)} />
          </div></> : null}

          <div className="flex items-start gap-2">
            <Checkbox id="consent" checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
            <Label htmlFor="consent" className="text-sm font-normal leading-5">
              {tt(t, 'invite.consent', 'I accept the Terms of Service and the Privacy Policy')}
              {policies.terms?.document_url ? (
                <> — <a className="underline" href={policies.terms.document_url} target="_blank" rel="noreferrer">
                  {tt(t, 'invite.terms', 'Terms')}
                </a></>
              ) : null}
              {policies.privacy?.document_url ? (
                <> · <a className="underline" href={policies.privacy.document_url} target="_blank" rel="noreferrer">
                  {tt(t, 'invite.privacy', 'Privacy')}
                </a></>
              ) : null}
            </Label>
          </div>

          {!policies.terms || !policies.privacy ? (
            <p className="text-xs text-destructive">
              {tt(t, 'invite.policiesMissing', 'Legal policy versions are not published yet. Contact your administrator.')}
            </p>
          ) : null}

          {errorCode ? <p className="text-xs text-destructive">{errorCode}</p> : null}

          <Button
            className="w-full"
            disabled={state === 'accepting' || !consent || !policies.terms || !policies.privacy}
            onClick={existingContinuation ? acceptExisting : acceptNew}
          >
            {state === 'accepting'
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : tt(t, 'invite.accept', 'Accept invitation')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
