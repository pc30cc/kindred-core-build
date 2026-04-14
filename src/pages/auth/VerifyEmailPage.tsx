import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'verifying' | 'success' | 'error' | 'no-token'>('verifying');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = searchParams.get('token') || searchParams.get('token_hash');
    const type = searchParams.get('type') || 'signup';

    if (!token) {
      setStatus('no-token');
      return;
    }

    fetch(`${API_BASE}/api/auth-email/verify-email?token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`, {
      credentials: 'include',
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setStatus('success');
          setMessage(data.message || 'Email verified successfully.');
        } else {
          setStatus('error');
          setMessage(data.error || 'Verification failed.');
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('An error occurred during verification.');
      });
  }, [searchParams]);

  if (status === 'verifying') {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.verifyEmail')}</CardTitle>
          <CardDescription>{t('common.loading')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (status === 'no-token') {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.verifyEmail')}</CardTitle>
          <CardDescription>{t('auth.checkEmail')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center space-y-4">
        <CardTitle>{status === 'success' ? '✓' : '✗'} {t('auth.verifyEmail')}</CardTitle>
        <CardDescription>{message}</CardDescription>
        {status === 'success' && (
          <Link to="/auth/login">
            <Button className="mt-4">{t('auth.login')}</Button>
          </Link>
        )}
      </CardHeader>
    </Card>
  );
}
