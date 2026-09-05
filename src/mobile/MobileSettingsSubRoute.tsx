/**
 * Native (iOS) settings sub-screens.
 *
 * Each section reuses the SAME surface as the web panel (profile,
 * notifications, availability, canned-response shortcuts) inside the phone
 * shell, so operator settings can never drift between web and app.
 */
import { Navigate, useParams } from 'react-router-dom';

import { useTranslation } from '@/i18n';
import { MobileSubScreen } from './MobileSubScreen';

import ProfilePage from '@/pages/app/settings/ProfilePage';
import NotificationsPage from '@/pages/app/settings/NotificationsPage';
import AvailabilityPage from '@/pages/app/settings/AvailabilityPage';
import CannedResponsesPage from '@/pages/app/settings/CannedResponsesPage';

export default function MobileSettingsSubRoute() {
  const { section, slug } = useParams<{ section: string; slug: string }>();
  const { t } = useTranslation();

  switch (section) {
    case 'profile':
      return (
        <MobileSubScreen title={t('account.title')}>
          <ProfilePage />
        </MobileSubScreen>
      );
    case 'notifications':
      return (
        <MobileSubScreen title={t('notifications.title')}>
          <NotificationsPage />
        </MobileSubScreen>
      );
    case 'availability':
      return (
        <MobileSubScreen title={t('availabilityPage.title')}>
          <AvailabilityPage />
        </MobileSubScreen>
      );
    case 'shortcuts':
      return (
        <MobileSubScreen title={t('canned.title')}>
          <CannedResponsesPage />
        </MobileSubScreen>
      );
    default:
      return <Navigate to={`/${slug}/settings`} replace />;
  }
}
