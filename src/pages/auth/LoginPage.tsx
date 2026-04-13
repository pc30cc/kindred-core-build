import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { logClientSecurityEvent } from '@/hooks/useSecurity';

export default function LoginPage() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failCount, setFailCount] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error: err } = await signIn({ email, password });
    if (err) {
      const newCount = failCount + 1;
      setFailCount(newCount);
      setError(err.message);
      setLoading(false);

      // Log failed login attempt
      logClientSecurityEvent('login_failed', newCount >= 5 ? 'error' : 'warn', {
        email,
        failCount: newCount,
      });

      // After 5 failures, show progressive warning
      if (newCount >= 5) {
        setError('Too many failed attempts. Please wait before trying again.');
      }
    } else {
      setFailCount(0);
      navigate('/app');
    }
  };

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('auth.loginTitle')}</CardTitle>
        <CardDescription>{t('auth.loginSubtitle')}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {failCount >= 3 && (
            <p className="text-sm text-yellow-500">
              ⚠ {failCount} failed attempts detected. Account may be temporarily locked after continued failures.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
          </div>
          <div className="text-end">
            <Link to="/auth/forgot-password" className="text-sm text-primary hover:underline">
              {t('auth.forgotPassword')}
            </Link>
          </div>
        </CardContent>
        <CardFooter className="flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('common.loading') : t('auth.login')}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link to="/auth/signup" className="text-primary hover:underline">{t('auth.signup')}</Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
