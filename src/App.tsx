import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { shouldRetryQuery } from "@/lib/queryRetry";
import { BrowserRouter, Route, Routes, Navigate, useParams, useLocation } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { UiPreferencesProvider } from "@/features/ui-preferences/UiPreferencesContext";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/i18n";
import type { Locale } from "@/i18n/config";
import type { TranslationKeys } from "@/i18n/locales/en";
import { ProviderContextProvider } from "@/providers";
import { AuthContextProvider, useAuth } from "@/features/auth/AuthContext";
import { IdentityCacheBoundary } from "@/features/auth/IdentityCacheBoundary";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { RequireAdmin } from "@/features/admin/RequireAdmin";
import { RequireWorkspaceAdmin } from "@/features/auth/RequireWorkspaceAdmin";
import { BrandingGate } from "@/features/branding/BrandingGate";
import { PlatformBrandingGate } from "@/features/branding/PlatformBrandingGate";
import { WorkspaceRedirect } from "@/features/workspace/WorkspaceRedirect";
import { WorkspaceKnowledgeBaseRedirect } from "@/features/workspace/WorkspaceKnowledgeBaseRedirect";
import { WorkspaceQnaRedirect } from "@/features/workspace/WorkspaceQnaRedirect";
import { WorkspaceFilesRedirect } from "@/features/workspace/WorkspaceFilesRedirect";
import { PlanLockedOverlay } from "@/components/plan/PlanLockedOverlay";
import { AdvancedAiAgentGuard } from "@/features/ai-agent/AdvancedAiAgentGuard";
import { isNativePlatform } from "@/lib/native";
import { lazyPage, type Preloadable } from "@/lib/perf/lazyPage";
import { afterLoadWhenIdle, canPrefetch, installLinkPrefetch, warmServiceWorkerCache } from "@/lib/perf/prefetch";
import { trackMediaCapture } from "@/lib/perf/chunkReload";
import { LEGACY_BILLING_ENABLED } from "../shared/billingMode";
import RetiredV2PaymentRoute from "@/pages/app/billing/RetiredV2PaymentRoute";

// Layouts and frames stay in the main bundle: they are what remains on screen
// while a page's own code loads.
import { AuthLayout } from "@/components/layout/AuthLayout";
import { AppLayout } from "@/components/layout/AppLayout";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { SettingsLayout } from "@/components/layout/SettingsLayout";
import { AiAgentLayout } from "@/components/layout/AiAgentLayout";
import { CallCenterLayout } from "@/components/layout/CallCenterLayout";

// The SAME bundle powers web and the Capacitor iOS shell; only the native
// shell gets the reduced mobile route table.
const isNativeApp = isNativePlatform();

// ─── Pages ───────────────────────────────────────────────────────────────
// Every page is its own chunk (src/lib/perf/lazyPage.tsx), so the first
// visit downloads the app frame plus the one page being opened, not all of
// them. The route table below is unchanged: same paths, guards and order.

// Native (iOS) route table — never downloaded by the web app.
const MobileRoutes = lazyPage(
  () => import("@/mobile/MobileRoutes").then((m) => ({ default: m.MobileRoutes })),
  { fallback: "blank" },
);

const LoginPage = lazyPage(() => import("@/pages/auth/LoginPage"), { fallback: "blank" });
const SignupPage = lazyPage(() => import("@/pages/auth/SignupPage"), { fallback: "blank" });
const ForgotPasswordPage = lazyPage(() => import("@/pages/auth/ForgotPasswordPage"), { fallback: "blank" });
const ResetPasswordPage = lazyPage(() => import("@/pages/auth/ResetPasswordPage"), { fallback: "blank" });
const VerifyEmailPage = lazyPage(() => import("@/pages/auth/VerifyEmailPage"), { fallback: "blank" });
const CheckEmailPage = lazyPage(() => import("@/pages/auth/CheckEmailPage"), { fallback: "blank" });
const EmailConfirmedPage = lazyPage(() => import("@/pages/auth/EmailConfirmedPage"), { fallback: "blank" });
const VerifyOtpPage = lazyPage(() => import("@/pages/auth/VerifyOtpPage"), { fallback: "blank" });

const InvitePage = lazyPage(() => import("@/pages/auth/InvitePage"), { fallback: "blank" });

const OverviewPage = lazyPage(() => import("@/pages/app/OverviewPage"));
const InboxPage = lazyPage(() => import("@/pages/app/InboxPage"), { fallback: "inset" });
const ContactsPage = lazyPage(() => import("@/pages/app/ContactsPage"));
const TeamPage = lazyPage(() => import("@/pages/app/TeamPage"));
const ContactDetailPage = lazyPage(() => import("@/pages/app/ContactDetailPage"));
const VisitorsPage = lazyPage(() => import("@/pages/app/VisitorsPage"));
const KnowledgeBasePage = lazyPage(() => import("@/pages/app/KnowledgeBasePage"));
const KnowledgeArticleEditorPage = lazyPage(() => import("@/pages/app/knowledge/ArticleEditorPage"));
const KnowledgeAiBuilderPage = lazyPage(() => import("@/pages/app/knowledge/AiBuilderPage"));
const WidgetPage = lazyPage(() => import("@/pages/app/WidgetPage"));
const PluginsPage = lazyPage(() => import("@/pages/app/PluginsPage"));
const PluginDetailPage = lazyPage(() => import("@/pages/app/PluginDetailPage"));
// AI Agent (Phase 1 foundation)
const AiAgentSettingsPage = lazyPage(() => import("@/pages/app/ai-agent/SettingsPage"));
const AiAgentActivationPage = lazyPage(() => import("@/pages/app/ai-agent/ActivationPage"));
const AiAgentPlaygroundPage = lazyPage(() => import("@/pages/app/ai-agent/PlaygroundPage"));
const AiAgentAnalyticsPage = lazyPage(() => import("@/pages/app/ai-agent/AnalyticsPage"));
const AiAgentBillingPage = lazyPage(() => import("@/pages/app/ai-agent/BillingPage"));
const AiAgentRoutingPage = lazyPage(() => import("@/pages/app/ai-agent/RoutingPage"));
const AiAgentInstructionsPage = lazyPage(() => import("@/pages/app/ai-agent/InstructionsPage"));
const AiAgentLearningCandidatesPage = lazyPage(() => import("@/pages/app/ai-agent/LearningCandidatesPage"));
const AiAgentWebPagesPage = lazyPage(() => import("@/pages/app/ai-agent/WebPagesPage"));
const AiAgentTopicsPage = lazyPage(() => import("@/pages/app/ai-agent/TopicsPage"));
const AiAgentWorkflowPage = lazyPage(() => import("@/pages/app/ai-agent/WorkflowPage"));
const AiAgentTriggersPage = lazyPage(() => import("@/pages/app/ai-agent/TriggersPage"));
const AiAgentIntegrationsPage = lazyPage(() => import("@/pages/app/ai-agent/IntegrationsPage"));
const AiAgentGuidancePage = lazyPage(() => import("@/pages/app/ai-agent/GuidancePage"));
const AiAgentOverviewPage = lazyPage(() => import("@/pages/app/ai-agent/OverviewPage"));
const AiAgentTrainPage = lazyPage(() => import("@/pages/app/ai-agent/TrainPage"));
const AiAgentRunInspectorPage = lazyPage(() => import("@/pages/app/ai-agent/RunInspectorPage"));
const AiAgentRetrievalDebuggerPage = lazyPage(() => import("@/pages/app/ai-agent/RetrievalDebuggerPage"));
const AiAgentSourceHealthPage = lazyPage(() => import("@/pages/app/ai-agent/SourceHealthPage"));
const AiAgentTestCasesPage = lazyPage(() => import("@/pages/app/ai-agent/TestCasesPage"));
const AiAgentTestRunDetailPage = lazyPage(() => import("@/pages/app/ai-agent/TestRunDetailPage"));
const AiAgentOperatorAssistAnalyticsPage = lazyPage(() => import("@/pages/app/ai-agent/OperatorAssistAnalyticsPage"));
const AiAgentSuggestedTestsPage = lazyPage(() => import("@/pages/app/ai-agent/SuggestedTestsPage"));
const AiAgentRegressionRunsPage = lazyPage(() => import("@/pages/app/ai-agent/RegressionRunsPage"));
const AiAgentKnowledgePage = lazyPage(() => import("@/pages/app/ai-agent/KnowledgePage"));
const AiAgentBehaviorPage = lazyPage(() => import("@/pages/app/ai-agent/BehaviorPage"));
const AiAgentOperatorAssistPage = lazyPage(() => import("@/pages/app/ai-agent/OperatorAssistPage"));
const AiAgentActivityPage = lazyPage(() => import("@/pages/app/ai-agent/ActivityPage"));
const BillingPage = lazyPage(() => import("@/pages/app/BillingPage"));
const BillingPaymentPage = lazyPage(() => import("@/pages/app/billing/PaymentPage"));
const BillingReceiptPage = lazyPage(() => import("@/pages/app/billing/account/ReceiptPage"));
const SeoPage = lazyPage(() => import("@/pages/app/seo/SeoPage"));
const WebAnalyticsPage = lazyPage(() => import("@/pages/app/analytics/WebAnalyticsPage"));
const EmailInboxPage = lazyPage(() => import("@/pages/app/email/EmailInboxPage"), { fallback: "inset" });
const SettingsGeneralPage = lazyPage(() => import("@/pages/app/settings/GeneralPage"));
const SettingsIntegrationsPage = lazyPage(() => import("@/pages/app/settings/IntegrationsPage"));
const SettingsCommercePage = lazyPage(() => import("@/pages/app/settings/CommercePage"));
const CommerceAuthorizePage = lazyPage(() => import("@/pages/CommerceAuthorizePage"), { fallback: "blank" });
const SettingsDomainsPage = lazyPage(() => import("@/pages/app/settings/DomainsPage"));
const SettingsProvidersPage = lazyPage(() => import("@/pages/app/settings/ProvidersPage"));
const SettingsTranslationsPage = lazyPage(() => import("@/pages/app/settings/TranslationsPage"));
const SettingsProfilePage = lazyPage(() => import("@/pages/app/settings/ProfilePage"));
const SettingsNotificationsPage = lazyPage(() => import("@/pages/app/settings/NotificationsPage"));
const SettingsAvailabilityPage = lazyPage(() => import("@/pages/app/settings/AvailabilityPage"));
const SettingsSecurityPage = lazyPage(() => import("@/pages/app/settings/SecurityPage"));
const SettingsCannedResponsesPage = lazyPage(() => import("@/pages/app/settings/CannedResponsesPage"));
const SettingsPrivacyPage = lazyPage(() => import("@/pages/app/settings/PrivacyPage"));
const SettingsInterfacePage = lazyPage(() => import("@/pages/app/settings/InterfacePage"));
const TeamDepartmentsPage = lazyPage(() => import("@/pages/app/settings/TeamDepartmentsPage"));
const StaffAccessPage = lazyPage(() => import("@/pages/app/settings/StaffAccessPage"));
const OperatorActivityPage = lazyPage(() => import("@/pages/app/settings/OperatorActivityPage"));
const PrivacyRequestsPage = lazyPage(() => import("@/pages/app/PrivacyRequestsPage"));

const AdminDashboardPage = lazyPage(() => import("@/pages/admin/DashboardPage"));
const AdminUsersPage = lazyPage(() => import("@/pages/admin/UsersPage"));
const AdminWorkspacesPage = lazyPage(() => import("@/pages/admin/WorkspacesPage"));
const AdminProvidersPage = lazyPage(() => import("@/pages/admin/ProvidersPage"));
const AdminSystemPage = lazyPage(() => import("@/pages/admin/SystemPage"));
const AdminRetentionPage = lazyPage(() => import("@/pages/admin/RetentionPage"));
const AdminBackupPage = lazyPage(() => import("@/pages/admin/BackupPage"));
const AdminObservabilityPage = lazyPage(() => import("@/pages/admin/ObservabilityPage"));
const AdminFeatureFlagsPage = lazyPage(() => import("@/pages/admin/FeatureFlagsPage"));
const AdminBrandingPage = lazyPage(() => import("@/pages/admin/BrandingPage"));
const AdminDomainsPage = lazyPage(() => import("@/pages/admin/DomainsPage"));
const AdminPlansPage = lazyPage(() => import("@/pages/admin/PlansPage"));
const AdminPluginsPage = lazyPage(() => import("@/pages/admin/PluginsPage"));
const AdminPluginDetailPage = lazyPage(() => import("@/pages/admin/PluginDetailPage"));
const AdminSecurityPage = lazyPage(() => import("@/pages/admin/SecurityPage"));
const AdminVerificationPage = lazyPage(() => import("@/pages/admin/VerificationPage"));
const AdminCoreSettingsPage = lazyPage(() => import("@/pages/admin/CoreSettingsPage"));
const AdminPanelThemePage = lazyPage(() => import("@/pages/admin/PanelThemePage"));
const AdminDatabasePage = lazyPage(() => import("@/pages/admin/DatabasePage"));
const AdminBootstrapPage = lazyPage(() => import("@/pages/admin/BootstrapPage"), { fallback: "blank" });
const AdminWidgetSettingsPage = lazyPage(() => import("@/pages/admin/WidgetSettingsPage"));
const AdminMapGeoPage = lazyPage(() => import("@/pages/admin/MapGeoPage"));
const AdminVoiceVideoPage = lazyPage(() => import("@/pages/admin/VoiceVideoPage"));
const AdminAiAgentControlPage = lazyPage(() => import("@/pages/admin/AiAgentControlPage"));
const AdminCallCenterPage = lazyPage(() => import("@/pages/admin/CallCenterPage"));
const AdminSeoIntegrationsPage = lazyPage(() => import("@/pages/admin/SeoIntegrationsPage"));
const AdminFinancePage = lazyPage(() => import("@/pages/admin/FinancePage"));
const AdminMobileAppPage = lazyPage(() => import("@/pages/admin/MobileAppPage"));
const AdminDesktopAppPage = lazyPage(() => import("@/pages/admin/DesktopAppPage"));
const AdminMacosAppPage = lazyPage(() => import("@/pages/admin/MacosAppPage"));
const AdminNotificationsPage = lazyPage(() => import("@/pages/admin/NotificationsPage"));

const CallCenterOverviewPage = lazyPage(() => import("@/pages/app/call-center/OverviewPage"));
const CallCenterLiveQueuePage = lazyPage(() => import("@/pages/app/call-center/LiveQueuePage"));
const CallCenterCallsPage = lazyPage(() => import("@/pages/app/call-center/CallsPage"));
const CallCenterCallbacksPage = lazyPage(() => import("@/pages/app/call-center/CallbacksPage"));
const CallCenterInstallPage = lazyPage(() => import("@/pages/app/call-center/InstallPage"));
const CallCenterSettingsPage = lazyPage(() => import("@/pages/app/call-center/SettingsPage"));
const CallCenterRecordingsPage = lazyPage(() => import("@/pages/app/call-center/RecordingsPage"));
// CC-2G-UI-Architecture-Fix — Departments are unified under
// /settings/team-departments. The old /call-center/departments URL is kept
// only as a redirect; the standalone CallCenterDepartmentsPage is no
// longer mounted as a usable route.

const NotFound = lazyPage(() => import("@/pages/NotFound"), { fallback: "blank" });

// Public Knowledge Base — SPA hydration on top of SSR-rendered first paint.
const HelpIndexPage = lazyPage(() => import("@/pages/public/kb/HelpIndexPage"), { fallback: "blank" });
const LegalPage = lazyPage(() => import("@/pages/public/legal/LegalPage"), { fallback: "blank" });
const ContactPage = lazyPage(() => import("@/pages/public/legal/ContactPage"), { fallback: "blank" });
const HelpCategoryPage = lazyPage(() => import("@/pages/public/kb/HelpCategoryPage"), { fallback: "blank" });
const HelpArticlePage = lazyPage(() => import("@/pages/public/kb/HelpArticlePage"), { fallback: "blank" });
const HelpSearchPage = lazyPage(() => import("@/pages/public/kb/HelpSearchPage"), { fallback: "blank" });

// ─── Prefetch ────────────────────────────────────────────────────────────
// Which page a URL opens, for downloading it early: the current URL at
// start-up (in parallel with the session and workspace requests instead of
// after them), the most used pages once the app is idle, and any page whose
// link is pointed at. Only ever a download hint: a URL missing here still
// loads normally when it is opened.

const AUTH_PAGES: Record<string, Preloadable> = {
  login: LoginPage,
  signup: SignupPage,
  "forgot-password": ForgotPasswordPage,
  "reset-password": ResetPasswordPage,
  "verify-email": VerifyEmailPage,
  "check-email": CheckEmailPage,
  "email-confirmed": EmailConfirmedPage,
  "verify-otp": VerifyOtpPage,
  invite: InvitePage,
};

const ADMIN_PAGES: Record<string, Preloadable> = {
  "": AdminDashboardPage,
  users: AdminUsersPage,
  workspaces: AdminWorkspacesPage,
  providers: AdminProvidersPage,
  "map-geo": AdminMapGeoPage,
  "widget-settings": AdminWidgetSettingsPage,
  "voice-video": AdminVoiceVideoPage,
  "ai-agent": AdminAiAgentControlPage,
  "call-center": AdminCallCenterPage,
  "seo-integrations": AdminSeoIntegrationsPage,
  "mobile-app": AdminMobileAppPage,
  "desktop-app": AdminDesktopAppPage,
  "macos-app": AdminMacosAppPage,
  notifications: AdminNotificationsPage,
  system: AdminSystemPage,
  observability: AdminObservabilityPage,
  retention: AdminRetentionPage,
  backup: AdminBackupPage,
  "feature-flags": AdminFeatureFlagsPage,
  branding: AdminBrandingPage,
  domains: AdminDomainsPage,
  finance: AdminFinancePage,
  plans: AdminPlansPage,
  plugins: AdminPluginsPage,
  database: AdminDatabasePage,
  security: AdminSecurityPage,
  verification: AdminVerificationPage,
  "core-settings": AdminCoreSettingsPage,
  "panel-theme": AdminPanelThemePage,
  bootstrap: AdminBootstrapPage,
};

const WORKSPACE_PAGES: Record<string, Preloadable> = {
  "": OverviewPage,
  inbox: InboxPage,
  contacts: ContactsPage,
  visitors: VisitorsPage,
  widget: WidgetPage,
  plugins: PluginsPage,
  billing: BillingPage,
  seo: SeoPage,
  analytics: WebAnalyticsPage,
  email: EmailInboxPage,
  "knowledge-base": KnowledgeBasePage,
  team: TeamPage,
};

const SETTINGS_PAGES: Record<string, Preloadable> = {
  general: SettingsGeneralPage,
  integrations: SettingsIntegrationsPage,
  commerce: SettingsCommercePage,
  domains: SettingsDomainsPage,
  providers: SettingsProvidersPage,
  translations: SettingsTranslationsPage,
  profile: SettingsProfilePage,
  notifications: SettingsNotificationsPage,
  availability: SettingsAvailabilityPage,
  security: SettingsSecurityPage,
  "canned-responses": SettingsCannedResponsesPage,
  privacy: SettingsPrivacyPage,
  interface: SettingsInterfacePage,
  "team-departments": TeamDepartmentsPage,
  "staff-access": StaffAccessPage,
  "operator-activity": OperatorActivityPage,
  "privacy-requests": PrivacyRequestsPage,
};

const AI_AGENT_PAGES: Record<string, Preloadable> = {
  overview: AiAgentOverviewPage,
  knowledge: AiAgentKnowledgePage,
  behavior: AiAgentBehaviorPage,
  "operator-assist": AiAgentOperatorAssistPage,
  activity: AiAgentActivityPage,
  settings: AiAgentSettingsPage,
  guidance: AiAgentGuidancePage,
  playground: AiAgentPlaygroundPage,
  analytics: AiAgentAnalyticsPage,
  activation: AiAgentActivationPage,
  billing: AiAgentBillingPage,
  routing: AiAgentRoutingPage,
  instructions: AiAgentInstructionsPage,
  "learning-candidates": AiAgentLearningCandidatesPage,
  train: AiAgentTrainPage,
  "web-pages": AiAgentWebPagesPage,
  topics: AiAgentTopicsPage,
  workflow: AiAgentWorkflowPage,
  triggers: AiAgentTriggersPage,
  integrations: AiAgentIntegrationsPage,
  "operator-assist-analytics": AiAgentOperatorAssistAnalyticsPage,
  runs: AiAgentRunInspectorPage,
  debug: AiAgentRetrievalDebuggerPage,
  "source-health": AiAgentSourceHealthPage,
  "test-cases": AiAgentTestCasesPage,
  "test-runs": AiAgentTestRunDetailPage,
  "suggested-tests": AiAgentSuggestedTestsPage,
  "regression-runs": AiAgentRegressionRunsPage,
};

const CALL_CENTER_PAGES: Record<string, Preloadable> = {
  "": CallCenterOverviewPage,
  queue: CallCenterLiveQueuePage,
  calls: CallCenterCallsPage,
  callbacks: CallCenterCallbacksPage,
  recordings: CallCenterRecordingsPage,
  install: CallCenterInstallPage,
  settings: CallCenterSettingsPage,
};

/** The pages almost every workspace session opens, fetched once idle. */
const COMMON_WORKSPACE_PAGES: readonly Preloadable[] = [InboxPage, ContactsPage, OverviewPage];

const own = (table: Record<string, Preloadable>, key: string): Preloadable[] =>
  Object.prototype.hasOwnProperty.call(table, key) ? [table[key]] : [];

function workspacePagesFor(section: string, sub: string): Preloadable[] {
  switch (section) {
    case "contacts": return [sub ? ContactDetailPage : ContactsPage];
    case "plugins": return [sub ? PluginDetailPage : PluginsPage];
    case "billing": return [sub === "pay" && LEGACY_BILLING_ENABLED ? BillingPaymentPage : sub === "receipts" ? BillingReceiptPage : BillingPage];
    case "knowledge-base":
      if (sub === "articles") return [KnowledgeArticleEditorPage];
      if (sub === "ai-builder") return [KnowledgeAiBuilderPage];
      return [KnowledgeBasePage];
    case "settings": return own(SETTINGS_PAGES, sub || "general");
    case "ai-agent": return own(AI_AGENT_PAGES, sub || "overview");
    case "call-center": return own(CALL_CENTER_PAGES, sub);
    default: return own(WORKSPACE_PAGES, section);
  }
}

/** The page(s) a pathname opens, for prefetching. */
function pagesForPath(pathname: string): Preloadable[] {
  const segments = pathname.split("/").filter(Boolean);
  const [first = "", second = "", third = ""] = segments;
  switch (first) {
    // "/" and "/app" lead a signed-in user to the dashboard and anyone else
    // to sign-in: RoutePrefetcher fetches the dashboard once that is known.
    case "": return [];
    case "app":
      if (second === "w") return workspacePagesFor(segments[3] ?? "", segments[4] ?? "");
      return second ? workspacePagesFor(second, third) : [];
    case "auth": return own(AUTH_PAGES, second);
    case "invite": return [InvitePage];
    case "commerce": return second === "authorize" ? [CommerceAuthorizePage] : [];
    case "privacy":
    case "terms": return [LegalPage];
    case "contact": return [ContactPage];
    case "help":
      if (!second) return [];
      if (third === "c") return [HelpCategoryPage];
      if (third === "a") return [HelpArticlePage];
      if (third === "search") return [HelpSearchPage];
      return third ? [] : [HelpIndexPage];
    case "admin":
      if (second === "plugins" && third) return [AdminPluginDetailPage];
      return own(ADMIN_PAGES, second);
    default: return workspacePagesFor(second, third); // "/<workspace-slug>/…"
  }
}

function preloadPath(pathname: string): void {
  for (const page of pagesForPath(pathname)) void page.preload();
}

// Start downloading the page being opened right now, alongside the app's
// own start-up, rather than after sign-in and the workspace have resolved.
// trackMediaCapture: a missing page file never reloads the tab under a live
// call (src/lib/perf/chunkReload.ts).
if (typeof window !== "undefined") {
  if (isNativeApp) void MobileRoutes.preload();
  else {
    trackMediaCapture();
    preloadPath(window.location.pathname);
  }
}

/** URLs that send a signed-in user on to the workspace dashboard. */
const DASHBOARD_ENTRY_PATHS = new Set(["/", "/app", "/app/"]);
/** Sign-in and public pages: their visitors may never open the panel. */
const OUTSIDE_PANEL = /^\/(auth|invite|help|privacy|terms|contact|commerce)(\/|$)/;

/** Idle and link-intent prefetching (src/lib/perf/prefetch.ts). Renders nothing. */
function RoutePrefetcher() {
  const { user, isLoading } = useAuth();
  const { pathname } = useLocation();
  const signedIn = !isLoading && !!user;

  useEffect(() => installLinkPrefetch(pagesForPath), []);

  // "/" and "/app": the dashboard, as soon as the session shows a user,
  // while the workspace list is still loading.
  const toDashboard = signedIn && DASHBOARD_ENTRY_PATHS.has(pathname);
  useEffect(() => {
    if (toDashboard) void OverviewPage.preload();
  }, [toDashboard]);

  // Once idle, for a signed-in user inside the panel only: the most used
  // pages, then the rest of this build into the service worker's cache.
  const idleWork = signedIn && !OUTSIDE_PANEL.test(pathname);
  useEffect(() => {
    if (!idleWork || !canPrefetch()) return undefined;
    return afterLoadWhenIdle(() => {
      for (const page of COMMON_WORKSPACE_PAGES) void page.preload();
      warmServiceWorkerCache();
    });
  }, [idleWork]);

  return null;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetryQuery } },
});

/**
 * Legacy URL shape `/app/w/<slug>/<rest>` → short URL `/<slug>/<rest>`.
 * Kept permanently so bookmarks, emails and gateway callbacks never 404.
 */
const LegacyWorkspaceUrlRedirect = () => {
  const params = useParams();
  const location = useLocation();
  const rest = params['*'] ? `/${params['*']}` : '';
  return <Navigate to={`/${params.slug}${rest}${location.search}${location.hash}`} replace />;
};

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
          <UiPreferencesProvider>
          <IdentityCacheBoundary>
          <PlatformBrandingGate>

          <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            {!isNativeApp && <RoutePrefetcher />}
            {isNativeApp ? <MobileRoutes /> : (
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

              {/* The privacy policy, terms of use and contact page, public
                  and in English: what the mobile apps and their store records
                  link to. `/privacy/:locale` only sends an old link to
                  `/privacy`. */}
              <Route path="/privacy" element={<LegalPage doc="privacy" />} />
              <Route path="/privacy/:locale" element={<LegalPage doc="privacy" />} />
              <Route path="/terms" element={<LegalPage doc="terms" />} />
              <Route path="/terms/:locale" element={<LegalPage doc="terms" />} />
              <Route path="/contact" element={<ContactPage />} />

              {/* Auth */}
              <Route element={<AuthLayout />}>
                <Route path="/auth/login" element={<LoginPage />} />
                <Route path="/auth/signup" element={<SignupPage />} />
                <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
                <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
                <Route path="/auth/check-email" element={<CheckEmailPage />} />
                <Route path="/auth/email-confirmed" element={<EmailConfirmedPage />} />
                <Route path="/auth/verify-otp" element={<VerifyOtpPage />} />
              </Route>

              {/* Invitation acceptance uses its own full-width split-screen shell */}
              <Route path="/auth/invite" element={<InvitePage />} />
              <Route path="/invite" element={<InvitePage />} />


              {/* Admin Bootstrap */}
              <Route path="/admin/bootstrap" element={
                <RequireAuth><AdminBootstrapPage /></RequireAuth>
              } />

              {/* Commerce pairing consent screen (docs/commerce/SECURITY.md §Pairing) */}
              <Route path="/commerce/authorize" element={
                <RequireAuth><CommerceAuthorizePage /></RequireAuth>
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
                <Route path="/admin/seo-integrations" element={<AdminSeoIntegrationsPage />} />
                <Route path="/admin/ai-billing" element={<Navigate to="/admin/finance?tab=ai" replace />} />
                {/* Legacy Advanced Routing page replaced by Widget Settings → Advanced Routing tab. */}
                <Route
                  path="/admin/advanced-routing"
                  element={<Navigate to="/admin/widget-settings" replace />}
                />
                <Route path="/admin/mobile-app" element={<AdminMobileAppPage />} />
                <Route path="/admin/desktop-app" element={<AdminDesktopAppPage />} />
                <Route path="/admin/macos-app" element={<AdminMacosAppPage />} />
                <Route path="/admin/notifications" element={<AdminNotificationsPage />} />
                <Route path="/admin/system" element={<AdminSystemPage />} />
                <Route path="/admin/observability" element={<AdminObservabilityPage />} />
                <Route path="/admin/retention" element={<AdminRetentionPage />} />
                <Route path="/admin/backup" element={<AdminBackupPage />} />
                <Route path="/admin/feature-flags" element={<AdminFeatureFlagsPage />} />
                <Route path="/admin/branding" element={<AdminBrandingPage />} />
                <Route path="/admin/domains" element={<AdminDomainsPage />} />
                <Route path="/admin/finance" element={<AdminFinancePage />} />
                <Route path="/admin/audit-logs" element={<Navigate to="/admin/finance?tab=audit" replace />} />
                <Route path="/admin/billing" element={<Navigate to="/admin/finance?tab=billing" replace />} />
                <Route path="/admin/plans" element={<AdminPlansPage />} />
                <Route path="/admin/plugins" element={<AdminPluginsPage />} />
                <Route path="/admin/plugins/:pluginId" element={<AdminPluginDetailPage />} />
                <Route path="/admin/database" element={<AdminDatabasePage />} />
                <Route path="/admin/security" element={<AdminSecurityPage />} />
                <Route path="/admin/verification" element={<AdminVerificationPage />} />
                <Route path="/admin/core-settings" element={<AdminCoreSettingsPage />} />
                <Route path="/admin/panel-theme" element={<AdminPanelThemePage />} />
              </Route>

              {/* /app → redirect to first workspace */}
              <Route path="/app" element={
                <RequireAuth><WorkspaceRedirect /></RequireAuth>
              } />
              {/* Legacy / slug-less app URLs (e.g. payment gateway callbacks
                  returning to /app/billing) — resolve the active workspace and
                  forward to the workspace-scoped route, keeping the query. */}
              <Route path="/app/*" element={
                <RequireAuth><WorkspaceRedirect /></RequireAuth>
              } />

              {/* Legacy workspace URLs: /app/w/<slug>/... → /<slug>/... */}
              <Route path="/app/w/:slug/*" element={<LegacyWorkspaceUrlRedirect />} />
              <Route path="/app/w/:slug" element={<LegacyWorkspaceUrlRedirect />} />

              {/* Workspace-scoped app (route-based active workspace).
                  Short URLs: /<workspace-slug>/<page>. Declared after every
                  static top-level route so /admin, /auth, /help keep priority
                  (React Router ranks static segments above dynamic ones). */}
              <Route path="/:slug" element={<RequireAuth><BrandingGate><AppLayout /></BrandingGate></RequireAuth>}>
                <Route index element={<OverviewPage />} />
                <Route path="inbox" element={<InboxPage />} />
                <Route path="contacts" element={<PlanLockedOverlay moduleKey="contacts"><ContactsPage /></PlanLockedOverlay>} />
                <Route path="contacts/:id" element={<PlanLockedOverlay moduleKey="contacts"><ContactDetailPage /></PlanLockedOverlay>} />
                <Route path="visitors" element={<PlanLockedOverlay moduleKey="visitor_tracking"><VisitorsPage /></PlanLockedOverlay>} />
                <Route path="widget" element={<RequireWorkspaceAdmin><PlanLockedOverlay channelKey="chat_widget"><WidgetPage /></PlanLockedOverlay></RequireWorkspaceAdmin>} />
                <Route path="plugins" element={<RequireWorkspaceAdmin><PluginsPage /></RequireWorkspaceAdmin>} />
                <Route path="plugins/:pluginId" element={<RequireWorkspaceAdmin><PluginDetailPage /></RequireWorkspaceAdmin>} />
                <Route path="billing" element={<RequireWorkspaceAdmin><BillingPage /></RequireWorkspaceAdmin>} />
                {/* Billing v2's payment page; while v2 is retired
                    (shared/billingMode.ts) it stays only for a bank's return
                    of a payment started before, and any other link lands on
                    the workspace's billing page. */}
                <Route path="billing/pay/:kind/:id" element={LEGACY_BILLING_ENABLED ? <RequireWorkspaceAdmin><BillingPaymentPage /></RequireWorkspaceAdmin> : <RetiredV2PaymentRoute page={<RequireWorkspaceAdmin><BillingPaymentPage /></RequireWorkspaceAdmin>} />} />
                <Route path="billing/receipts/:ledgerId" element={<RequireWorkspaceAdmin><BillingReceiptPage /></RequireWorkspaceAdmin>} />
                {/* Every plan-gated section is gated at its route too (the
                    sidebar only hides the link): PlanLockedOverlay never
                    mounts the page unless the plan snapshot says so. */}
                <Route path="seo" element={<RequireWorkspaceAdmin><PlanLockedOverlay moduleKey="seo"><SeoPage /></PlanLockedOverlay></RequireWorkspaceAdmin>} />
                <Route path="seo/:section" element={<RequireWorkspaceAdmin><PlanLockedOverlay moduleKey="seo"><SeoPage /></PlanLockedOverlay></RequireWorkspaceAdmin>} />
                <Route path="seo/:section/:subsection" element={<RequireWorkspaceAdmin><PlanLockedOverlay moduleKey="seo"><SeoPage /></PlanLockedOverlay></RequireWorkspaceAdmin>} />
                {/* Web Analytics — generic site-traffic/behavior reporting, split out
                    of the SEO suite into its own main-menu item (it isn't search-specific
                    like the tools under /seo). Plan-gated inside WebAnalyticsSection itself
                    (moduleKey="web_analytics"), same as it was when nested under /seo. */}
                <Route path="analytics" element={<RequireWorkspaceAdmin><WebAnalyticsPage /></RequireWorkspaceAdmin>} />
                <Route path="analytics/:subsection" element={<RequireWorkspaceAdmin><WebAnalyticsPage /></RequireWorkspaceAdmin>} />
                {/* Email Inbox — a dedicated, real email client (Gmail today), NOT
                    the unified chat Inbox. See server/services/email/inbox.ts's
                    header comment for why it is intentionally separate. */}
                <Route path="email" element={<RequireWorkspaceAdmin><PlanLockedOverlay moduleKey="email_inbox"><EmailInboxPage /></PlanLockedOverlay></RequireWorkspaceAdmin>} />
                <Route path="email/:threadId" element={<RequireWorkspaceAdmin><PlanLockedOverlay moduleKey="email_inbox"><EmailInboxPage /></PlanLockedOverlay></RequireWorkspaceAdmin>} />
                {/* Phase 6-S5-R4 — Knowledge Base is a CORE workspace product.
                    It is ALWAYS available: no plan gate, no AI dependency, no
                    upgrade screen. Only authentication + workspace membership
                    (the parent layout) protect it. It must never be nested
                    under AiAgentLayout and must never be wrapped in an
                    entitlement gate. */}
                <Route path="knowledge-base" element={<KnowledgeBasePage />} />
                {/* Dedicated pages: create/edit an article, and the AI
                    website-scan builder. Same "always available" rule as
                    the parent route — the AI builder page gates itself
                    internally via EntitlementAccessGate, never at the
                    route level. */}
                <Route path="knowledge-base/articles/new" element={<KnowledgeArticleEditorPage />} />
                <Route path="knowledge-base/articles/:id" element={<KnowledgeArticleEditorPage />} />
                <Route path="knowledge-base/ai-builder" element={<KnowledgeAiBuilderPage />} />
                {/* Legacy KB URL — declared OUTSIDE AiAgentLayout so the
                    redirect still works while AI Agent is disabled. */}
                <Route path="ai-agent/articles" element={<WorkspaceKnowledgeBaseRedirect />} />
                <Route path="call-center" element={<CallCenterLayout />}>
                  <Route index element={<CallCenterOverviewPage />} />
                  <Route path="queue" element={<PlanLockedOverlay featureKey="call_queue"><CallCenterLiveQueuePage /></PlanLockedOverlay>} />
                  <Route path="calls" element={<CallCenterCallsPage />} />
                  <Route path="callbacks" element={<PlanLockedOverlay featureKey="call_callbacks"><CallCenterCallbacksPage /></PlanLockedOverlay>} />
                  <Route path="recordings" element={<PlanLockedOverlay featureKey="call_recording"><CallCenterRecordingsPage /></PlanLockedOverlay>} />
                  {/* Legacy URL — redirect to canonical Team & Departments. */}
                  <Route path="departments" element={<Navigate to="../../settings/team-departments" replace />} />
                  <Route path="install" element={<CallCenterInstallPage />} />
                  <Route path="settings" element={<CallCenterSettingsPage />} />
                </Route>
                <Route path="settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="general" replace />} />
                  <Route path="general" element={<RequireWorkspaceAdmin><SettingsGeneralPage /></RequireWorkspaceAdmin>} />
                  <Route path="integrations" element={<RequireWorkspaceAdmin><SettingsIntegrationsPage /></RequireWorkspaceAdmin>} />
                  <Route path="commerce" element={<RequireWorkspaceAdmin><SettingsCommercePage /></RequireWorkspaceAdmin>} />
                  <Route path="branding" element={<Navigate to="../general" replace />} />
                  <Route path="domains" element={<RequireWorkspaceAdmin><SettingsDomainsPage /></RequireWorkspaceAdmin>} />
                  <Route path="providers" element={<RequireWorkspaceAdmin><SettingsProvidersPage /></RequireWorkspaceAdmin>} />
                  <Route path="translations" element={<RequireWorkspaceAdmin><SettingsTranslationsPage /></RequireWorkspaceAdmin>} />
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
                  <Route path="team-departments" element={<RequireWorkspaceAdmin><TeamDepartmentsPage /></RequireWorkspaceAdmin>} />
                  <Route path="staff-access" element={<RequireWorkspaceAdmin><StaffAccessPage /></RequireWorkspaceAdmin>} />
                  <Route path="operator-activity" element={<RequireWorkspaceAdmin><OperatorActivityPage /></RequireWorkspaceAdmin>} />
                  <Route path="privacy-requests" element={<RequireWorkspaceAdmin><PrivacyRequestsPage /></RequireWorkspaceAdmin>} />
                  {/* Legacy settings entry → canonical Knowledge Base route. */}
                  <Route path="knowledge-base" element={<WorkspaceKnowledgeBaseRedirect />} />
                </Route>
                {/* AI Agent — Phase 1 foundation. Separate layout with its own sidebar. */}
                <Route path="ai-agent" element={<RequireWorkspaceAdmin><AiAgentLayout /></RequireWorkspaceAdmin>}>
                  <Route index element={<Navigate to="overview" replace />} />
                  <Route path="overview" element={<AiAgentOverviewPage />} />
                  <Route path="knowledge" element={<AiAgentKnowledgePage />} />
                  <Route path="behavior" element={<AiAgentBehaviorPage />} />
                  <Route path="operator-assist" element={<AiAgentOperatorAssistPage />} />
                  <Route path="activity" element={<AiAgentActivityPage />} />
                  <Route path="settings" element={<AiAgentSettingsPage />} />
                  {/* Customer configuration / member-level AI Agent surfaces.
                      Backend already scopes these to workspace membership,
                      and owner/admin where required (authorizeMember +
                      isOwnerOrAdmin) — see the individual domain routers.
                      No global-admin gate belongs here. */}
                  <Route path="guidance" element={<AiAgentGuidancePage />} />
                  <Route path="playground" element={<AiAgentPlaygroundPage />} />
                  <Route path="analytics" element={<AiAgentAnalyticsPage />} />
                  <Route path="activation" element={<AiAgentActivationPage />} />
                  <Route path="billing" element={<AdvancedAiAgentGuard><AiAgentBillingPage /></AdvancedAiAgentGuard>} />
                  <Route path="routing" element={<AiAgentRoutingPage />} />
                  <Route path="instructions" element={<AiAgentInstructionsPage />} />
                  {/* Q&A authoring moved to the unified Knowledge Base page
                      (Articles / Q&A tabs) — this legacy URL redirects there. */}
                  <Route path="qna" element={<WorkspaceQnaRedirect />} />
                  <Route path="learning-candidates" element={<AiAgentLearningCandidatesPage />} />
                  <Route path="train" element={<AiAgentTrainPage />} />
                  <Route path="web-pages" element={<AiAgentWebPagesPage />} />
                  {/* File authoring moved to the unified Knowledge Base page
                      (Articles / Q&A / Files tabs) — this legacy URL
                      redirects there. */}
                  <Route path="files" element={<WorkspaceFilesRedirect />} />
                  <Route path="topics" element={<AiAgentTopicsPage />} />
                  <Route path="workflow" element={<AiAgentWorkflowPage />} />
                  <Route path="triggers" element={<AiAgentTriggersPage />} />
                  <Route path="integrations" element={<AiAgentIntegrationsPage />} />
                  <Route path="operator-assist-analytics" element={<AiAgentOperatorAssistAnalyticsPage />} />
                  {/* Advanced / internal QA / debug routes — guarded.
                      Customer workspaces never see these in the sidebar; direct
                      URL access is blocked unless the user is a platform admin
                      (or a dev override is enabled). */}
                  <Route path="runs/:id" element={<AdvancedAiAgentGuard><AiAgentRunInspectorPage /></AdvancedAiAgentGuard>} />
                  <Route path="debug/retrieval" element={<AdvancedAiAgentGuard><AiAgentRetrievalDebuggerPage /></AdvancedAiAgentGuard>} />
                  <Route path="source-health" element={<AdvancedAiAgentGuard><AiAgentSourceHealthPage /></AdvancedAiAgentGuard>} />
                  <Route path="test-cases" element={<AdvancedAiAgentGuard><AiAgentTestCasesPage /></AdvancedAiAgentGuard>} />
                  <Route path="test-runs/:id" element={<AdvancedAiAgentGuard><AiAgentTestRunDetailPage /></AdvancedAiAgentGuard>} />
                  <Route path="suggested-tests" element={<AdvancedAiAgentGuard><AiAgentSuggestedTestsPage /></AdvancedAiAgentGuard>} />
                  <Route path="regression-runs" element={<AdvancedAiAgentGuard><AiAgentRegressionRunsPage /></AdvancedAiAgentGuard>} />
                </Route>
                {/* Backwards-compat redirects: legacy URLs → settings */}
                {/* Team: owners are redirected to settings inside the page;
                    operators get the read-only member directory. */}
                <Route path="team" element={<TeamPage />} />
                <Route path="privacy-requests" element={<Navigate to="../settings/privacy-requests" replace />} />
                <Route path="ai" element={<Navigate to="../settings/ai" replace />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
            )}
          </BrowserRouter>
          </TooltipProvider>
          </PlatformBrandingGate>
          </IdentityCacheBoundary>
          </UiPreferencesProvider>
        </AuthContextProvider>
        </ProviderContextProvider>
      </ThemeProvider>
    </I18nProvider>
  </QueryClientProvider>
);

export default App;
