import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const { resetPasswordRequest } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await resetPasswordRequest(email);
    if (err) setError(err.message);
    else setSent(true);
    setLoading(false);
  };

  if (sent) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.checkEmail')}</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t('auth.forgotTitle')}</CardTitle>
        <CardDescription>{t('auth.forgotSubtitle')}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
        </CardContent>
        <CardFooter className="flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('common.loading') : t('auth.resetPassword')}
          </Button>
          <Link to="/auth/login" className="text-sm text-primary hover:underline">{t('auth.login')}</Link>
        </CardFooter>
      </form>
    </Card>
  );
}
