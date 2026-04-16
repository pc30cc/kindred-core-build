import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { TranslationKeys } from "@/i18n/locales/en";
import { ProviderContextProvider } from "@/providers";
import { AuthContextProvider } from "@/features/auth/AuthContext";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { RequireAdmin } from "@/features/admin/RequireAdmin";
import { BrandingGate } from "@/features/branding/BrandingGate";
import { PlatformBrandingGate } from "@/features/branding/PlatformBrandingGate";
import { WorkspaceRedirect } from "@/features/workspace/WorkspaceRedirect";

import { AuthLayout } from "@/components/layout/AuthLayout";
import { AppLayout } from "@/components/layout/AppLayout";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { SettingsLayout } from "@/components/layout/SettingsLayout";

import LoginPage from "@/pages/auth/LoginPage";
import SignupPage from "@/pages/auth/SignupPage";
import ForgotPasswordPage from "@/pages/auth/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/auth/ResetPasswordPage";
import VerifyEmailPage from "@/pages/auth/VerifyEmailPage";
import CheckEmailPage from "@/pages/auth/CheckEmailPage";
import EmailConfirmedPage from "@/pages/auth/EmailConfirmedPage";
import InvitePage from "@/pages/auth/InvitePage";

import OverviewPage from "@/pages/app/OverviewPage";
import InboxPage from "@/pages/app/InboxPage";
import ContactsPage from "@/pages/app/ContactsPage";
import VisitorsPage from "@/pages/app/VisitorsPage";
import KnowledgeBasePage from "@/pages/app/KnowledgeBasePage";
import WidgetPage from "@/pages/app/WidgetPage";
import AIPage from "@/pages/app/AIPage";
import EmailPage from "@/pages/app/EmailPage";
import TeamPage from "@/pages/app/TeamPage";
import BillingPage from "@/pages/app/BillingPage";
import SettingsGeneralPage from "@/pages/app/settings/GeneralPage";
import SettingsBrandingPage from "@/pages/app/settings/BrandingPage";
import SettingsDomainsPage from "@/pages/app/settings/DomainsPage";
import SettingsProvidersPage from "@/pages/app/settings/ProvidersPage";
import SettingsTranslationsPage from "@/pages/app/settings/TranslationsPage";
import SettingsProfilePage from "@/pages/app/settings/ProfilePage";

import AdminDashboardPage from "@/pages/admin/DashboardPage";
import AdminUsersPage from "@/pages/admin/UsersPage";
import AdminWorkspacesPage from "@/pages/admin/WorkspacesPage";
import AdminProvidersPage from "@/pages/admin/ProvidersPage";
import AdminSystemPage from "@/pages/admin/SystemPage";
import AdminFeatureFlagsPage from "@/pages/admin/FeatureFlagsPage";
import AdminBrandingPage from "@/pages/admin/BrandingPage";
import AdminDomainsPage from "@/pages/admin/DomainsPage";
import AdminAuditLogsPage from "@/pages/admin/AuditLogsPage";
import AdminBillingPage from "@/pages/admin/BillingPage";
import AdminPlansPage from "@/pages/admin/PlansPage";
import AdminSecurityPage from "@/pages/admin/SecurityPage";
import AdminDatabasePage from "@/pages/admin/DatabasePage";
import AdminBootstrapPage from "@/pages/admin/BootstrapPage";

import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

interface AppProps {
  initialLocale?: Locale;
  initialTranslations?: TranslationKeys;
}

const App = ({ initialLocale, initialTranslations }: AppProps) => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider initialLocale={initialLocale} initialTranslations={initialTranslations}>
      <ProviderContextProvider>
        <AuthContextProvider>
          <PlatformBrandingGate>
          <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              {/* Root redirects to app */}
              <Route path="/" element={<Navigate to="/app" replace />} />

              {/* Auth */}
              <Route element={<AuthLayout />}>
                <Route path="/auth/login" element={<LoginPage />} />
                <Route path="/auth/signup" element={<SignupPage />} />
                <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
                <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
                <Route path="/auth/check-email" element={<CheckEmailPage />} />
                <Route path="/auth/email-confirmed" element={<EmailConfirmedPage />} />
                <Route path="/auth/invite" element={<InvitePage />} />
              </Route>

              {/* Admin Bootstrap */}
              <Route path="/admin/bootstrap" element={
                <RequireAuth><AdminBootstrapPage /></RequireAuth>
              } />

              {/* Global Super Admin */}
              <Route element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
                <Route path="/admin" element={<AdminDashboardPage />} />
                <Route path="/admin/users" element={<AdminUsersPage />} />
                <Route path="/admin/workspaces" element={<AdminWorkspacesPage />} />
                <Route path="/admin/providers" element={<AdminProvidersPage />} />
                <Route path="/admin/system" element={<AdminSystemPage />} />
                <Route path="/admin/feature-flags" element={<AdminFeatureFlagsPage />} />
                <Route path="/admin/branding" element={<AdminBrandingPage />} />
                <Route path="/admin/domains" element={<AdminDomainsPage />} />
                <Route path="/admin/audit-logs" element={<AdminAuditLogsPage />} />
                <Route path="/admin/billing" element={<AdminBillingPage />} />
                <Route path="/admin/plans" element={<AdminPlansPage />} />
                <Route path="/admin/database" element={<AdminDatabasePage />} />
                <Route path="/admin/security" element={<AdminSecurityPage />} />
              </Route>

              {/* /app → redirect to first workspace */}
              <Route path="/app" element={
                <RequireAuth><WorkspaceRedirect /></RequireAuth>
              } />

              {/* Workspace-scoped app (route-based active workspace) */}
              <Route path="/app/w/:slug" element={<RequireAuth><BrandingGate><AppLayout /></BrandingGate></RequireAuth>}>
                <Route index element={<OverviewPage />} />
                <Route path="inbox" element={<InboxPage />} />
                <Route path="contacts" element={<ContactsPage />} />
                <Route path="visitors" element={<VisitorsPage />} />
                <Route path="knowledge-base" element={<KnowledgeBasePage />} />
                <Route path="widget" element={<WidgetPage />} />
                <Route path="ai" element={<AIPage />} />
                <Route path="email" element={<EmailPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="billing" element={<BillingPage />} />
                <Route path="settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="general" replace />} />
                  <Route path="general" element={<SettingsGeneralPage />} />
                  <Route path="branding" element={<SettingsBrandingPage />} />
                  <Route path="domains" element={<SettingsDomainsPage />} />
                  <Route path="providers" element={<SettingsProvidersPage />} />
                  <Route path="translations" element={<SettingsTranslationsPage />} />
                  <Route path="profile" element={<SettingsProfilePage />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
          </TooltipProvider>
          </PlatformBrandingGate>
        </AuthContextProvider>
      </ProviderContextProvider>
    </I18nProvider>
  </QueryClientProvider>
);

export default App;
