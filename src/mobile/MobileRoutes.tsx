/**
 * Route table for the native (Capacitor/iOS) app.
 *
 * Deliberately tiny: login (no sign-up) and four operator screens —
 * Inbox, Contacts, Visitors, Settings. Everything else in the product stays
 * web-only until it is explicitly added here.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { BrandingGate } from '@/features/branding/BrandingGate';
import { WorkspaceRedirect } from '@/features/workspace/WorkspaceRedirect';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';

import MobileLoginPage from './MobileLoginPage';
import MobileSettingsPage from './MobileSettingsPage';
import { MobileLayout } from './MobileLayout';

import ForgotPasswordPage from '@/pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '@/pages/auth/ResetPasswordPage';
import MobileInboxPage from './MobileInboxPage';
import MobileConversationPage from './MobileConversationPage';
import MobileContactsPage from './MobileContactsPage';
import MobileVisitorsPage from './MobileVisitorsPage';
import MobileContactDetailPage from './MobileContactDetailPage';
import MobileSettingsSubRoute from './MobileSettingsSubRoute';

export function MobileRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />

      <Route path="/auth/login" element={<MobileLoginPage />} />
      <Route path="/auth/signup" element={<Navigate to="/auth/login" replace />} />
      <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/reset-password" element={<ResetPasswordPage />} />

      <Route path="/app" element={<RequireAuth><WorkspaceRedirect /></RequireAuth>} />
      <Route path="/app/*" element={<RequireAuth><WorkspaceRedirect /></RequireAuth>} />

      <Route
        path="/:slug"
        element={
          <RequireAuth>
            <BrandingGate>
              <MobileLayout />
            </BrandingGate>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="inbox" replace />} />
        <Route path="inbox" element={<MobileInboxPage />} />
        <Route path="inbox/:conversationId" element={<MobileConversationPage />} />
        <Route
          path="contacts"
          element={
            <PlanLockedOverlay moduleKey="contacts">
              <MobileContactsPage />
            </PlanLockedOverlay>
          }
        />
        <Route path="contacts/:id" element={<MobileContactDetailPage />} />
        <Route
          path="visitors"
          element={
            <PlanLockedOverlay moduleKey="visitor_tracking">
              <MobileVisitorsPage />
            </PlanLockedOverlay>
          }
        />
        <Route path="settings" element={<MobileSettingsPage />} />
        <Route path="settings/:section" element={<MobileSettingsSubRoute />} />
        <Route path="*" element={<Navigate to="inbox" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
