/**
 * The "new version available" toast's text (src/lib/pwa.ts). Each part reads
 * the page's current language through useI18n, so the toast follows the page:
 * it stays on screen for a whole shift, and a language switch meanwhile now
 * changes it too, instead of leaving it in the language it was raised in.
 */
import { ToastAction } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

export function AppUpdateTitle() {
  const { t } = useI18n();
  return <>{t('appUpdate.title')}</>;
}

export function AppUpdateDescription() {
  const { t } = useI18n();
  return <>{t('appUpdate.description')}</>;
}

export function AppUpdateAction({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const label = t('appUpdate.refresh');
  return <ToastAction altText={label} onClick={onClick}>{label}</ToastAction>;
}
