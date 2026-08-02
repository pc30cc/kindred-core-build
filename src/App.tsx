import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
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
import ContactDetailPage from "@/pages/app/ContactDetailPage";
import VisitorsPage from "@/pages/app/VisitorsPage";
import KnowledgeBasePage from "@/pages/app/KnowledgeBasePage";
import { WorkspaceKnowledgeBaseRedirect } from "@/features/workspace/WorkspaceKnowledgeBaseRedirect";
import { PlanAccessGate } from "@/components/plan/PlanAccessGate";
import WidgetPage from "@/pages/app/WidgetPage";
import { PlanLockedOverlay } from "@/components/plan/PlanLockedOverlay";
// AI Agent (Phase 1 foundation)
import { AiAgentLayout } from "@/components/layout/AiAgentLayout";
import AiAgentSettingsPage from "@/pages/app/ai-agent/SettingsPage";
import AiAgentActivationPage from "@/pages/app/ai-agent/ActivationPage";
import AiAgentPlaygroundPage from "@/pages/app/ai-agent/PlaygroundPage";
import AiAgentAnalyticsPage from "@/pages/app/ai-agent/AnalyticsPage";
import AiAgentBillingPage from "@/pages/app/ai-agent/BillingPage";
import AiAgentRoutingPage from "@/pages/app/ai-agent/RoutingPage";
import AiAgentInstructionsPage from "@/pages/app/ai-agent/InstructionsPage";
import AiAgentQnaPage from "@/pages/app/ai-agent/QnaPage";
import AiAgentLearningCandidatesPage from "@/pages/app/ai-agent/LearningCandidatesPage";
import AiAgentWebPagesPage from "@/pages/app/ai-agent/WebPagesPage";
import AiAgentFilesPage from "@/pages/app/ai-agent/FilesPage";
import AiAgentTopicsPage from "@/pages/app/ai-agent/TopicsPage";
import AiAgentWorkflowPage from "@/pages/app/ai-agent/WorkflowPage";
import AiAgentTriggersPage from "@/pages/app/ai-agent/TriggersPage";
import AiAgentIntegrationsPage from "@/pages/app/ai-agent/IntegrationsPage";
import AiAgentGuidancePage from "@/pages/app/ai-agent/GuidancePage";
import AiAgentOverviewPage from "@/pages/app/ai-agent/OverviewPage";
import AiAgentTrainPage from "@/pages/app/ai-agent/TrainPage";
import AiAgentRunInspectorPage from "@/pages/app/ai-agent/RunInspectorPage";
import AiAgentRetrievalDebuggerPage from "@/pages/app/ai-agent/RetrievalDebuggerPage";
import AiAgentSourceHealthPage from "@/pages/app/ai-agent/SourceHealthPage";
import AiAgentTestCasesPage from "@/pages/app/ai-agent/TestCasesPage";
import AiAgentTestRunDetailPage from "@/pages/app/ai-agent/TestRunDetailPage";
import AiAgentOperatorAssistAnalyticsPage from "@/pages/app/ai-agent/OperatorAssistAnalyticsPage";
import AiAgentSuggestedTestsPage from "@/pages/app/ai-agent/SuggestedTestsPage";
import AiAgentRegressionRunsPage from "@/pages/app/ai-agent/RegressionRunsPage";
import AiAgentKnowledgePage from "@/pages/app/ai-agent/KnowledgePage";
import AiAgentBehaviorPage from "@/pages/app/ai-agent/BehaviorPage";
import AiAgentOperatorAssistPage from "@/pages/app/ai-agent/OperatorAssistPage";
import AiAgentActivityPage from "@/pages/app/ai-agent/ActivityPage";
import { AdvancedAiAgentGuard } from "@/features/ai-agent/AdvancedAiAgentGuard";
import EmailPage from "@/pages/app/EmailPage";
import BillingPage from "@/pages/app/BillingPage";
import SettingsGeneralPage from "@/pages/app/settings/GeneralPage";
import SettingsIntegrationsPage from "@/pages/app/settings/IntegrationsPage";
import SettingsBrandingPage from "@/pages/app/settings/BrandingPage";
import SettingsDomainsPage from "@/pages/app/settings/DomainsPage";
import SettingsProvidersPage from "@/pages/app/settings/ProvidersPage";
import SettingsTranslationsPage from "@/pages/app/settings/TranslationsPage";
import SettingsProfilePage from "@/pages/app/settings/ProfilePage";
import SettingsNotificationsPage from "@/pages/app/settings/NotificationsPage";
import SettingsAvailabilityPage from "@/pages/app/settings/AvailabilityPage";
import SettingsSecurityPage from "@/pages/app/settings/SecurityPage";
import SettingsCannedResponsesPage from "@/pages/app/settings/CannedResponsesPage";
import SettingsPrivacyPage from "@/pages/app/settings/PrivacyPage";
import SettingsInterfacePage from "@/pages/app/settings/InterfacePage";
import TeamDepartmentsPage from "@/pages/app/settings/TeamDepartmentsPage";
import StaffAccessPage from "@/pages/app/settings/StaffAccessPage";
import PrivacyRequestsPage from "@/pages/app/PrivacyRequestsPage";

import AdminDashboardPage from "@/pages/admin/DashboardPage";
import AdminUsersPage from "@/pages/admin/UsersPage";
import AdminWorkspacesPage from "@/pages/admin/WorkspacesPage";
import AdminProvidersPage from "@/pages/admin/ProvidersPage";
import AdminSystemPage from "@/pages/admin/SystemPage";
import AdminObservabilityPage from "@/pages/admin/ObservabilityPage";
import AdminFeatureFlagsPage from "@/pages/admin/FeatureFlagsPage";
import AdminBrandingPage from "@/pages/admin/BrandingPage";
import AdminDomainsPage from "@/pages/admin/DomainsPage";
import AdminAuditLogsPage from "@/pages/admin/AuditLogsPage";
import AdminBillingPage from "@/pages/admin/BillingPage";
import AdminPlansPage from "@/pages/admin/PlansPage";
import AdminSecurityPage from "@/pages/admin/SecurityPage";
import AdminDatabasePage from "@/pages/admin/DatabasePage";
import AdminBootstrapPage from "@/pages/admin/BootstrapPage";
import AdminWidgetSettingsPage from "@/pages/admin/WidgetSettingsPage";
import AdminMapGeoPage from "@/pages/admin/MapGeoPage";
import AdminVoiceVideoPage from "@/pages/admin/VoiceVideoPage";
import AdminAiAgentControlPage from "@/pages/admin/AiAgentControlPage";
import AdminCallCenterPage from "@/pages/admin/CallCenterPage";

import { CallCenterLayout } from "@/components/layout/CallCenterLayout";
import CallCenterOverviewPage from "@/pages/app/call-center/OverviewPage";
import CallCenterLiveQueuePage from "@/pages/app/call-center/LiveQueuePage";
import CallCenterCallsPage from "@/pages/app/call-center/CallsPage";
import CallCenterCallbacksPage from "@/pages/app/call-center/CallbacksPage";
import CallCenterInstallPage from "@/pages/app/call-center/InstallPage";
import CallCenterSettingsPage from "@/pages/app/call-center/SettingsPage";
import CallCenterRecordingsPage from "@/pages/app/call-center/RecordingsPage";
// CC-2G-UI-Architecture-Fix — Departments are unified under
// /settings/team-departments. The old /call-center/departments URL is kept
// only as a redirect; the standalone CallCenterDepartmentsPage is no
// longer mounted as a usable route.

import NotFound from "@/pages/NotFound";

// Public Knowledge Base — SPA hydration on top of SSR-rendered first paint.
import HelpIndexPage from "@/pages/public/kb/HelpIndexPage";
import HelpCategoryPage from "@/pages/public/kb/HelpCategoryPage";
import HelpArticlePage from "@/pages/public/kb/HelpArticlePage";
import HelpSearchPage from "@/pages/public/kb/HelpSearchPage";

const queryClient = new QueryClient();

interface AppProps {
  initialLocale?: Locale;
  initialTranslations?: TranslationKeys;
}

const App = ({ initialLocale, initialTranslations }: AppProps) => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider initialLocale={initialLocale} initialTranslations={initialTranslations}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey="app-theme"
        disableTransitionOnChange
      >
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

              {/* Public Knowledge Base — SSR (Express) is the source of truth
                  for first paint at /help/:locale/...; these client routes
                  hydrate that paint and handle subsequent client-side nav. */}
              <Route path="/help" element={<Navigate to="/help/en" replace />} />
              <Route path="/help/:locale" element={<HelpIndexPage />} />
              <Route path="/help/:locale/c/:slug" element={<HelpCategoryPage />} />
              <Route path="/help/:locale/a/:slug" element={<HelpArticlePage />} />
              <Route path="/help/:locale/search" element={<HelpSearchPage />} />

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
                <Route path="/admin/map-geo" element={<AdminMapGeoPage />} />
                <Route path="/admin/widget-settings" element={<AdminWidgetSettingsPage />} />
                <Route path="/admin/voice-video" element={<AdminVoiceVideoPage />} />
                <Route path="/admin/ai-agent" element={<AdminAiAgentControlPage />} />
                <Route path="/admin/call-center" element={<AdminCallCenterPage />} />
                {/* Legacy Advanced Routing page replaced by Widget Settings → Advanced Routing tab. */}
                <Route
                  path="/admin/advanced-routing"
                  element={<Navigate to="/admin/widget-settings" replace />}
                />
                <Route path="/admin/system" element={<AdminSystemPage />} />
                <Route path="/admin/observability" element={<AdminObservabilityPage />} />
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
                <Route path="contacts" element={<PlanLockedOverlay moduleKey="contacts"><ContactsPage /></PlanLockedOverlay>} />
                <Route path="contacts/:id" element={<ContactDetailPage />} />
                <Route path="visitors" element={<PlanLockedOverlay moduleKey="visitor_tracking"><VisitorsPage /></PlanLockedOverlay>} />
                <Route path="widget" element={<WidgetPage />} />
                <Route path="email" element={<EmailPage />} />
                <Route path="billing" element={<BillingPage />} />
                {/* Phase 6-S5-R4 — Knowledge Base is a CORE workspace product.
                    It is ALWAYS available: no plan gate, no AI dependency, no
                    upgrade screen. Only authentication + workspace membership
                    (the parent layout) protect it. It must never be nested
                    under AiAgentLayout and must never be wrapped in an
                    entitlement gate. */}
                <Route path="knowledge-base" element={<KnowledgeBasePage />} />
                {/* Legacy KB URL — declared OUTSIDE AiAgentLayout so the
                    redirect still works while AI Agent is disabled. */}
                <Route path="ai-agent/articles" element={<WorkspaceKnowledgeBaseRedirect />} />
                <Route path="call-center" element={<CallCenterLayout />}>
                  <Route index element={<CallCenterOverviewPage />} />
                  <Route path="queue" element={<CallCenterLiveQueuePage />} />
                  <Route path="calls" element={<CallCenterCallsPage />} />
                  <Route path="callbacks" element={<CallCenterCallbacksPage />} />
                  <Route path="recordings" element={<CallCenterRecordingsPage />} />
                  {/* Legacy URL — redirect to canonical Team & Departments. */}
                  <Route path="departments" element={<Navigate to="../../settings/team-departments" replace />} />
                  <Route path="install" element={<CallCenterInstallPage />} />
                  <Route path="settings" element={<CallCenterSettingsPage />} />
                </Route>
                <Route path="settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="general" replace />} />
                  <Route path="general" element={<SettingsGeneralPage />} />
                  <Route path="integrations" element={<SettingsIntegrationsPage />} />
                  <Route path="branding" element={<SettingsBrandingPage />} />
                  <Route path="domains" element={<SettingsDomainsPage />} />
                  <Route path="providers" element={<SettingsProvidersPage />} />
                  <Route path="translations" element={<SettingsTranslationsPage />} />
                  <Route path="profile" element={<SettingsProfilePage />} />
                  <Route path="notifications" element={<SettingsNotificationsPage />} />
                  <Route path="availability" element={<SettingsAvailabilityPage />} />
                  <Route path="security" element={<SettingsSecurityPage />} />
                  <Route path="canned-responses" element={<SettingsCannedResponsesPage />} />
                  <Route path="privacy" element={<SettingsPrivacyPage />} />
                  <Route path="interface" element={<SettingsInterfacePage />} />
                  {/* Legacy IA routes — redirect to the new Team & Departments
                      / Staff Access surfaces so old bookmarks keep working. */}
                  <Route path="team" element={<Navigate to="../team-departments" replace />} />
                  <Route path="departments" element={<Navigate to="../team-departments" replace />} />
                  <Route path="access-profiles" element={<Navigate to="../staff-access" replace />} />
                  <Route path="team-departments" element={<TeamDepartmentsPage />} />
                  <Route path="staff-access" element={<StaffAccessPage />} />
                  <Route path="privacy-requests" element={<PrivacyRequestsPage />} />
                  {/* Legacy settings entry → canonical Knowledge Base route. */}
                  <Route path="knowledge-base" element={<WorkspaceKnowledgeBaseRedirect />} />
                </Route>
                {/* AI Agent — Phase 1 foundation. Separate layout with its own sidebar. */}
                <Route path="ai-agent" element={<AiAgentLayout />}>
                  <Route index element={<Navigate to="overview" replace />} />
                  <Route path="overview" element={<AiAgentOverviewPage />} />
                  <Route path="knowledge" element={<AiAgentKnowledgePage />} />
                  <Route path="behavior" element={<AiAgentBehaviorPage />} />
                  <Route path="operator-assist" element={<AiAgentOperatorAssistPage />} />
                  <Route path="activity" element={<AiAgentActivityPage />} />
                  <Route path="settings" element={<AiAgentSettingsPage />} />
                  {/* Advanced / internal QA / debug routes — guarded.
                      Customer workspaces never see these in the sidebar; direct
                      URL access is blocked unless the user is a platform admin
                      (or a dev override is enabled). */}
                  <Route path="guidance" element={<AdvancedAiAgentGuard><AiAgentGuidancePage /></AdvancedAiAgentGuard>} />
                  <Route path="playground" element={<AdvancedAiAgentGuard><AiAgentPlaygroundPage /></AdvancedAiAgentGuard>} />
                  <Route path="analytics" element={<AdvancedAiAgentGuard><AiAgentAnalyticsPage /></AdvancedAiAgentGuard>} />
                  <Route path="activation" element={<AdvancedAiAgentGuard><AiAgentActivationPage /></AdvancedAiAgentGuard>} />
                  <Route path="billing" element={<AdvancedAiAgentGuard><AiAgentBillingPage /></AdvancedAiAgentGuard>} />
                  <Route path="routing" element={<AdvancedAiAgentGuard><AiAgentRoutingPage /></AdvancedAiAgentGuard>} />
                  <Route path="instructions" element={<AdvancedAiAgentGuard><AiAgentInstructionsPage /></AdvancedAiAgentGuard>} />
                  <Route path="qna" element={<AdvancedAiAgentGuard><AiAgentQnaPage /></AdvancedAiAgentGuard>} />
                  <Route path="learning-candidates" element={<AdvancedAiAgentGuard><AiAgentLearningCandidatesPage /></AdvancedAiAgentGuard>} />
                  <Route path="train" element={<AdvancedAiAgentGuard><AiAgentTrainPage /></AdvancedAiAgentGuard>} />
                  <Route path="web-pages" element={<AdvancedAiAgentGuard><AiAgentWebPagesPage /></AdvancedAiAgentGuard>} />
                  <Route path="files" element={<AdvancedAiAgentGuard><AiAgentFilesPage /></AdvancedAiAgentGuard>} />
                  <Route path="topics" element={<AdvancedAiAgentGuard><AiAgentTopicsPage /></AdvancedAiAgentGuard>} />
                  <Route path="workflow" element={<AdvancedAiAgentGuard><AiAgentWorkflowPage /></AdvancedAiAgentGuard>} />
                  <Route path="triggers" element={<AdvancedAiAgentGuard><AiAgentTriggersPage /></AdvancedAiAgentGuard>} />
                  <Route path="integrations" element={<AdvancedAiAgentGuard><AiAgentIntegrationsPage /></AdvancedAiAgentGuard>} />
                  <Route path="runs/:id" element={<AdvancedAiAgentGuard><AiAgentRunInspectorPage /></AdvancedAiAgentGuard>} />
                  <Route path="debug/retrieval" element={<AdvancedAiAgentGuard><AiAgentRetrievalDebuggerPage /></AdvancedAiAgentGuard>} />
                  <Route path="source-health" element={<AdvancedAiAgentGuard><AiAgentSourceHealthPage /></AdvancedAiAgentGuard>} />
                  <Route path="test-cases" element={<AdvancedAiAgentGuard><AiAgentTestCasesPage /></AdvancedAiAgentGuard>} />
                  <Route path="test-runs/:id" element={<AdvancedAiAgentGuard><AiAgentTestRunDetailPage /></AdvancedAiAgentGuard>} />
                  <Route path="operator-assist-analytics" element={<AdvancedAiAgentGuard><AiAgentOperatorAssistAnalyticsPage /></AdvancedAiAgentGuard>} />
                  <Route path="suggested-tests" element={<AdvancedAiAgentGuard><AiAgentSuggestedTestsPage /></AdvancedAiAgentGuard>} />
                  <Route path="regression-runs" element={<AdvancedAiAgentGuard><AiAgentRegressionRunsPage /></AdvancedAiAgentGuard>} />
                </Route>
                {/* Backwards-compat redirects: legacy URLs → settings */}
                <Route path="team" element={<Navigate to="../settings/team-departments" replace />} />
                <Route path="privacy-requests" element={<Navigate to="../settings/privacy-requests" replace />} />
                <Route path="ai" element={<Navigate to="../settings/ai" replace />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
          </TooltipProvider>
          </PlatformBrandingGate>
        </AuthContextProvider>
        </ProviderContextProvider>
      </ThemeProvider>
    </I18nProvider>
  </QueryClientProvider>
);

export default App;
