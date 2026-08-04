import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { API_BASE } from '@/lib/api';
import { toast } from '@/lib/toast';
import {
  Loader2, CheckCircle2, XCircle, Building2, LogIn, UserPlus,
  Clock, ShieldAlert, AlertTriangle, ArrowRight,
} from 'lucide-react';

type InviteState =
  | 'loading'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'login_required'
  | 'wrong_account'
  | 'already_member'
  | 'ready'
  | 'accepting'
  | 'accepted';

interface InviteInfo {
  workspace_name: string;
  workspace_slug: string;
  workspace_id: string;
  role: string;
  expires_at: string | null;
  expired: boolean;
  revoked: boolean;
  invited_email: string | null;
  inviter_name: string;
  inviter_email: string;
  email_match: boolean | null;
  already_member: boolean;
}

// Use `tt` as untyped accessor since invite keys are dynamic
const tt = (t: any, key: string, fallback: string) => {
  const val = t(key);
  return val === key ? fallback : val;
};

export default function InvitePage() {
  const { t } = useTranslation();
  const { user, isLoading: authLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [state, setState] = useState<InviteState>('loading');
  const [acceptResult, setAcceptResult] = useState<any>(null);

  const inviteRedirectUrl = `/auth/invite?token=${encodeURIComponent(token || '')}`;

  const resolveState = useCallback((data: InviteInfo | null, hasUser: boolean): InviteState => {
    if (!data) return 'invalid';
    if (data.revoked) return 'revoked';
    if (data.expired) return 'expired';
    if (!hasUser) return 'login_required';
    if (data.email_match === false) return 'wrong_account';
    if (data.already_member) return 'already_member';
    return 'ready';
  }, []);

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    if (authLoading) return;

    supabase.rpc('get_invitation_info', { _token: token })
      .then(({ data, error }) => {
        if (error || !data) { setState('invalid'); return; }
        const inviteData = data as unknown as InviteInfo;
        setInfo(inviteData);
        setState(resolveState(inviteData, !!user));
      });
  }, [token, user, authLoading, resolveState]);

  const handleAccept = useCallback(async () => {
    if (!token || !user) return;
    setState('accepting');
    try {
      // Canonical seat-creation boundary lives in the Express server
      // (POST /api/workspace-members/accept-invitation). The server
      // forwards the user's JWT into a scoped Supabase client so the
      // existing `accept_workspace_invitation` SECURITY DEFINER RPC
      // sees the same `auth.uid()`. See docs/MAX_AGENTS_POLICY.md.
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error('Not authenticated');
      const res = await fetch(`${API_BASE}/api/workspace-members/accept-invitation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ token }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(result?.error || `Request failed (${res.status})`);
      }
      setAcceptResult(result);
      if (result.already_member) {
        setState('already_member');
        toast.info(tt(t, 'invite.alreadyMember', 'You are already a member of this workspace'));
      } else {
        setState('accepted');
        toast.success(tt(t, 'invite.accepted', `Joined ${result.workspace_name}`));
      }
    } catch (err: any) {
      toast.error(err.message);
      setState('ready');
    }
  }, [token, user, t]);

  // Auto-accept after login redirect
  useEffect(() => {
    if (state === 'ready' && user && token && sessionStorage.getItem('invite_auto_accept') === token) {
      sessionStorage.removeItem('invite_auto_accept');
      handleAccept();
    }
  }, [state, user, token, handleAccept]);

  const goToWorkspace = () => {
    const slug = acceptResult?.workspace_slug || info?.workspace_slug;
    if (slug) navigate(`/app/w/${slug}`);
    else navigate('/app');
  };

  const handleLoginRedirect = () => {
    if (token) sessionStorage.setItem('invite_auto_accept', token);
    navigate(`/auth/login?redirect=${encodeURIComponent(inviteRedirectUrl)}`);
  };

  const handleSignupRedirect = () => {
    if (token) sessionStorage.setItem('invite_auto_accept', token);
    navigate(`/auth/signup?redirect=${encodeURIComponent(inviteRedirectUrl)}`);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate(`/auth/login?redirect=${encodeURIComponent(inviteRedirectUrl)}`);
  };

  if (state === 'loading' || authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (state === 'accepted') {
    return (
      <div className="flex items-center justify-center min-h-[60vh] px-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <h2 className="text-xl font-bold">{tt(t, 'invite.successTitle', 'Invitation Accepted!')}</h2>
            <p className="text-muted-foreground">
              {tt(t, 'invite.joinedAs', 'You joined')}{' '}
              <strong>{acceptResult?.workspace_name}</strong>{' '}
              {tt(t, 'invite.asRole', 'as')}{' '}
              <Badge variant="secondary">{acceptResult?.role}</Badge>
            </p>
            <Button onClick={goToWorkspace} className="w-full gap-2">
              <ArrowRight className="w-4 h-4" />
              {tt(t, 'invite.goToWorkspace', 'Go to Workspace')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'already_member') {
    return (
      <div className="flex items-center justify-center min-h-[60vh] px-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <h2 className="text-xl font-bold">{tt(t, 'invite.alreadyMemberTitle', 'Already a Member')}</h2>
            <p className="text-muted-foreground">
              {tt(t, 'invite.alreadyMemberDesc', 'You are already a member of')}{' '}
              <strong>{info?.workspace_name}</strong>
            </p>
            <Button onClick={goToWorkspace} className="w-full gap-2">
              <ArrowRight className="w-4 h-4" />
              {tt(t, 'invite.openWorkspace', 'Open Workspace')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'invalid' || state === 'expired' || state === 'revoked') {
    const icon = state === 'expired' ? <Clock className="h-12 w-12 text-amber-500 mx-auto" /> :
                 state === 'revoked' ? <ShieldAlert className="h-12 w-12 text-destructive mx-auto" /> :
                 <XCircle className="h-12 w-12 text-destructive mx-auto" />;
    const title = state === 'expired' ? tt(t, 'invite.expiredTitle', 'Invitation Expired') :
                  state === 'revoked' ? tt(t, 'invite.revokedTitle', 'Invitation Revoked') :
                  tt(t, 'invite.invalidTitle', 'Invalid Invitation');
    const desc = state === 'expired' ? tt(t, 'invite.expiredDesc', 'This invitation has expired.') :
                 state === 'revoked' ? tt(t, 'invite.revokedDesc', 'This invitation has been revoked.') :
                 tt(t, 'invite.invalidDesc', 'This invitation link is not valid.');

    return (
      <div className="flex items-center justify-center min-h-[60vh] px-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            {icon}
            <h2 className="text-xl font-bold">{title}</h2>
            <p className="text-muted-foreground">{desc}</p>
            <Button variant="outline" onClick={() => navigate('/auth/login')}>
              {tt(t, 'invite.goToLogin', 'Go to Login')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'wrong_account') {
    return (
      <div className="flex items-center justify-center min-h-[60vh] px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <AlertTriangle className="h-12 w-12 text-amber-500 mx-auto mb-2" />
            <CardTitle>{tt(t, 'invite.wrongAccountTitle', 'Wrong Account')}</CardTitle>
            <CardDescription>
              {tt(t, 'invite.wrongAccountDesc', 'This invitation is for a different email address.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">{tt(t, 'invite.invitedEmail', 'Invited Email')}</span>
                <span className="font-medium">{info?.invited_email}</span>
              </div>
              <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">{tt(t, 'invite.loggedInAs', 'Logged in as')}</span>
                <span className="font-medium">{user?.email}</span>
              </div>
            </div>
            <Button onClick={handleLogout} variant="outline" className="w-full gap-2">
              <LogIn className="w-4 h-4" />
              {tt(t, 'invite.switchAccount', 'Log in with another account')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'login_required') {
    return (
      <div className="flex items-center justify-center min-h-[60vh] px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-2">
              <Building2 className="h-7 w-7 text-primary" />
            </div>
            <CardTitle>{tt(t, 'invite.title', 'Workspace Invitation')}</CardTitle>
            <CardDescription>
              {tt(t, 'invite.invitedTo', "You've been invited to join")}{' '}
              <strong>{info?.workspace_name}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {info && <InviteDetails info={info} />}
            <div className="space-y-2">
              <p className="text-center text-sm text-muted-foreground">
                {tt(t, 'invite.loginRequired', 'Please log in or sign up to accept this invitation.')}
              </p>
              <Button onClick={handleLoginRedirect} className="w-full gap-2">
                <LogIn className="w-4 h-4" />
                {tt(t, 'invite.loginToAccept', 'Log in to Accept')}
              </Button>
              <Button onClick={handleSignupRedirect} variant="outline" className="w-full gap-2">
                <UserPlus className="w-4 h-4" />
                {tt(t, 'invite.signupToAccept', 'Sign up to Accept')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── Ready to Accept / Accepting ───
  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-2">
            <Building2 className="h-7 w-7 text-primary" />
          </div>
          <CardTitle>{tt(t, 'invite.title', 'Workspace Invitation')}</CardTitle>
          <CardDescription>
            {tt(t, 'invite.invitedTo', "You've been invited to join")}{' '}
            <strong>{info?.workspace_name}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {info && <InviteDetails info={info} />}
          <Button
            onClick={handleAccept}
            disabled={state === 'accepting'}
            className="w-full gap-2"
          >
            {state === 'accepting' && <Loader2 className="h-4 w-4 animate-spin" />}
            {tt(t, 'invite.accept', 'Accept Invitation')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function InviteDetails({ info }: { info: InviteInfo }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
        <span className="text-muted-foreground">Workspace</span>
        <span className="font-medium">{info.workspace_name}</span>
      </div>
      <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
        <span className="text-muted-foreground">Role</span>
        <Badge variant="secondary">{info.role}</Badge>
      </div>
      {(info.inviter_name || info.inviter_email) && (
        <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-muted-foreground">Invited by</span>
          <span className="font-medium">{info.inviter_name || info.inviter_email}</span>
        </div>
      )}
      {info.expires_at ? (
        <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-muted-foreground">Expires</span>
          <span className="font-medium flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {new Date(info.expires_at).toLocaleDateString()}
          </span>
        </div>
      ) : (
        <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
          <span className="text-muted-foreground">Expires</span>
          <span className="font-medium text-emerald-500">No expiration</span>
        </div>
      )}
    </div>
  );
}
