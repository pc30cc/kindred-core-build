import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/i18n";
import { AuthContextProvider } from "@/features/auth/AuthContext";
import { RequireAuth } from "@/features/auth/RequireAuth";

// Layouts
import { PublicLayout } from "@/components/layout/PublicLayout";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { AppLayout } from "@/components/layout/AppLayout";

// Public pages
import HomePage from "@/pages/public/HomePage";
import FeaturesPage from "@/pages/public/FeaturesPage";
import PricingPage from "@/pages/public/PricingPage";
import ContactPage from "@/pages/public/ContactPage";

// Auth pages
import LoginPage from "@/pages/auth/LoginPage";
import SignupPage from "@/pages/auth/SignupPage";
import ForgotPasswordPage from "@/pages/auth/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/auth/ResetPasswordPage";
import VerifyEmailPage from "@/pages/auth/VerifyEmailPage";
import InvitePage from "@/pages/auth/InvitePage";

// App pages
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

import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <AuthContextProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              {/* Public routes */}
              <Route element={<PublicLayout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/features" element={<FeaturesPage />} />
                <Route path="/pricing" element={<PricingPage />} />
                <Route path="/contact" element={<ContactPage />} />
              </Route>

              {/* Auth routes */}
              <Route element={<AuthLayout />}>
                <Route path="/auth/login" element={<LoginPage />} />
                <Route path="/auth/signup" element={<SignupPage />} />
                <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
                <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
                <Route path="/auth/invite" element={<InvitePage />} />
              </Route>

              {/* App routes (protected) */}
              <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route path="/app" element={<OverviewPage />} />
                <Route path="/app/inbox" element={<InboxPage />} />
                <Route path="/app/contacts" element={<ContactsPage />} />
                <Route path="/app/visitors" element={<VisitorsPage />} />
                <Route path="/app/knowledge-base" element={<KnowledgeBasePage />} />
                <Route path="/app/widget" element={<WidgetPage />} />
                <Route path="/app/ai" element={<AIPage />} />
                <Route path="/app/email" element={<EmailPage />} />
                <Route path="/app/team" element={<TeamPage />} />
                <Route path="/app/billing" element={<BillingPage />} />
                <Route path="/app/settings/general" element={<SettingsGeneralPage />} />
                <Route path="/app/settings/branding" element={<SettingsBrandingPage />} />
                <Route path="/app/settings/domains" element={<SettingsDomainsPage />} />
                <Route path="/app/settings/providers" element={<SettingsProvidersPage />} />
                <Route path="/app/settings/translations" element={<SettingsTranslationsPage />} />
                <Route path="/app/settings/profile" element={<SettingsProfilePage />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AuthContextProvider>
    </I18nProvider>
  </QueryClientProvider>
);

export default App;
