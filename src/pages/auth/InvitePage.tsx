import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle, Building2 } from 'lucide-react';

export default function InvitePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [info, setInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<any>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError('No invitation token provided');
      return;
    }
    supabase.rpc('get_invitation_info', { _token: token })
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setInfo(data);
        setLoading(false);
      });
  }, [token]);

  const handleAccept = async () => {
    if (!token || !user) return;
    setAccepting(true);
    try {
      const { data, error: err } = await supabase.rpc('accept_workspace_invitation', { _token: token });
      if (err) throw new Error(err.message);
      setSuccess(data);
      toast.success(`Joined ${(data as any)?.workspace_name}`);
    } catch (err: any) {
      toast.error(err.message);
      setError(err.message);
    } finally {
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <h2 className="text-xl font-bold">Invitation Accepted!</h2>
            <p className="text-muted-foreground">
              You joined <strong>{success.workspace_name}</strong> as <Badge variant="secondary">{success.role}</Badge>
            </p>
            <Button onClick={() => navigate('/')} className="w-full">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <XCircle className="h-12 w-12 text-destructive mx-auto" />
            <h2 className="text-xl font-bold">Invalid Invitation</h2>
            <p className="text-muted-foreground">{error || 'This invitation link is not valid.'}</p>
            <Button variant="outline" onClick={() => navigate('/auth/login')}>
              Go to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isExpired = info.expired;
  const isExhausted = info.exhausted;
  const canAccept = !isExpired && !isExhausted && !!user;

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-2">
            <Building2 className="h-7 w-7 text-primary" />
          </div>
          <CardTitle>{t('auth.inviteTitle') || 'Workspace Invitation'}</CardTitle>
          <CardDescription>
            You've been invited to join <strong>{info.workspace_name}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Workspace</span>
              <span className="font-medium">{info.workspace_name}</span>
            </div>
            <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Role</span>
              <Badge variant="secondary">{info.role}</Badge>
            </div>
            <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Expires</span>
              <span className="font-medium">{new Date(info.expires_at).toLocaleDateString()}</span>
            </div>
          </div>

          {isExpired && (
            <p className="text-center text-sm text-destructive">This invitation has expired.</p>
          )}
          {isExhausted && (
            <p className="text-center text-sm text-destructive">This invitation has been fully used.</p>
          )}
          {!user && (
            <div className="text-center space-y-2">
              <p className="text-sm text-muted-foreground">Please log in to accept this invitation.</p>
              <Button onClick={() => navigate(`/auth/login?redirect=/invite?token=${token}`)} className="w-full">
                Log in to Accept
              </Button>
            </div>
          )}
          {canAccept && (
            <Button onClick={handleAccept} disabled={accepting} className="w-full gap-2">
              {accepting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('auth.acceptInvite') || 'Accept Invitation'}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
