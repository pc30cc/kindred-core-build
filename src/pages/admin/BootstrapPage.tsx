import { BrandLoaderScreen } from '@/components/brand/BrandLoader';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin, useBootstrapAdmin } from '@/hooks/useAdmin';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Navigate } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { Shield } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';

export default function AdminBootstrapPage() {
  const { t } = useTranslation();
  const { user, isLoading: authLoading } = useAuth();
  const { data: isAdmin, isLoading: roleLoading } = useIsGlobalAdmin();
  const bootstrap = useBootstrapAdmin();

  if (authLoading || roleLoading) {
    return <BrandLoaderScreen />;
  }

  if (!user) return <Navigate to="/auth/login" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;

  const handleBootstrap = async () => {
    try {
      const result = await bootstrap.mutateAsync();
      if (result) {
        toast.success(t('admin.bootstrap.success' as TranslationKey));
      } else {
        toast.error(t('admin.bootstrap.alreadyExists' as TranslationKey));
      }
    } catch (err: unknown) {
      const messages: Record<string, string> = {
        bootstrap_not_configured: t('admin.bootstrap.notConfigured' as TranslationKey),
        email_verification_required: t('admin.bootstrap.verifyEmail' as TranslationKey),
        not_authorized: t('admin.bootstrap.notAuthorized' as TranslationKey),
      };
      toast.error(messages[err instanceof Error ? err.message : ''] || t('admin.bootstrap.failed' as TranslationKey));
    }
  };

  return (
    <div className="admin-scope flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full bg-card border-border">
        <CardHeader className="text-center">
          <Shield className="h-12 w-12 mx-auto text-red-400 mb-2" />
          <CardTitle className="text-foreground text-xl">{t('admin.bootstrap.title' as TranslationKey)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-muted-foreground text-sm">
            {t('admin.bootstrap.intro' as TranslationKey)} <strong className="text-foreground">{user.email}</strong>
          </p>
          <p className="text-muted-foreground/70 text-xs">
            {t('admin.bootstrap.warning' as TranslationKey)}
          </p>
          <Button
            onClick={handleBootstrap}
            disabled={bootstrap.isPending}
            className="w-full bg-red-600 hover:bg-red-700"
          >
            {bootstrap.isPending ? t('admin.bootstrap.working' as TranslationKey) : t('admin.bootstrap.claim' as TranslationKey)}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
