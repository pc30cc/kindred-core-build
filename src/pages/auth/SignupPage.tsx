import { useState, useMemo } from 'react';
import { AuthHeroPanel } from '@/components/auth/AuthHeroPanel';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { toast } from '@/lib/toast';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import SignupStepAccount from '@/components/auth/SignupStepAccount';
import SignupStepCompany from '@/components/auth/SignupStepCompany';
import { fetchSignupPolicy } from '@/lib/emailOtp';


const TOTAL_STEPS = 2;

export default function SignupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t, locale, dir } = useTranslation();
  const { signUp, signIn } = useAuth();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';

  const [step, setStep] = useState(1);

  // Step 1 fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // Step 2 fields
  const [companyName, setCompanyName] = useState('');
  const [websiteDomain, setWebsiteDomain] = useState('');

  const [loading, setLoading] = useState(false);

  const brandName = useMemo(() => brand?.platform_name || 'App', [brand]);

  // Step 1: validate & go to step 2
  const handleStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedTerms) {
      toast.error(t('auth.mustAcceptTerms'));
      return;
    }
    if (password.length < 6) {
      toast.error(t('auth.passwordMinLength'));
      return;
    }
    setStep(2);
  };

  // Step 2: register + create workspace
  const handleStep2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;

    setLoading(true);
    const trimmedEmail = email.trim().toLowerCase();
    const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
    try {
      const { error } = await signUp({
        email: trimmedEmail,
        password,
        fullName: fullName || undefined,
        website: websiteDomain.trim(),
        locale,
        metadata: { locale, companyName: companyName.trim(), websiteDomain: websiteDomain.trim() },
      });
      if (error) {
        // Generic by design: the backend never reveals whether an existing
        // account has a password set yet (see server/routes/auth.ts) — an
        // unauthenticated signup attempt is not the place to disambiguate
        // that. Every "account already exists" case routes to the same
        // sign-in-or-reset message; a legitimate migrated user who then
        // tries to log in is correctly routed to password setup by /login.
        if (error.message.toLowerCase().includes('already exists')) {
          toast.error(t('auth.accountExists'), { description: t('auth.accountExistsHint') });
        } else {
          toast.error(t('auth.signupFailed'), { description: error.message });
        }
        return;
      }

      const { error: signInError } = await signIn({ email: trimmedEmail, password });
      if (signInError) {
        console.warn('[signup] Auto-login failed, retrying...', signInError.message);
        await new Promise(r => setTimeout(r, 500));
        const { error: retryError } = await signIn({ email: trimmedEmail, password });
        if (retryError) {
          console.error('[signup] Auto-login retry failed:', retryError.message);
          toast.error(t('auth.signupSuccess'), { description: 'Please log in manually.' });
          navigate('/auth/login');
          return;
        }
      }

      toast.success(t('auth.signupSuccess'));

      // WHERE the new user lands is the operator's choice, resolved
      // server-side (Super Admin → Branding → Settings):
      //   otp    → the 6-digit code screen (no link is ever mailed).
      //   after  → straight into the app; the existing bottom banner
      //            keeps asking them to verify.
      //   before → the classic "check your inbox" screen, because no
      //            workspace can exist until the link is clicked.
      const policy = await fetchSignupPolicy();
      if (policy.gate === 'after') {
        // Gate `after` always lands in the workspace; the bottom banner
        // drives verification (code dialog in OTP mode, resend in link mode).
        navigate('/app');
      } else if (policy.method === 'otp') {
        navigate('/auth/verify-otp');
      } else {
        navigate(`/auth/check-email?email=${encodeURIComponent(trimmedEmail)}`);
      }

    } catch (err: any) {
      toast.error(t('auth.signupFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  const stepTitle = step === 1
    ? t('auth.signupStep1Title')
    : t('auth.signupStep2Title');

  const stepSubtitle = step === 1
    ? t('auth.signupStep1Subtitle')
    : t('auth.signupStep2Subtitle');

  return (
    <div className="fixed inset-0 flex" dir={dir}>
      {/* Left side — Form */}
      <div className={`auth-aurora flex-1 flex flex-col overflow-y-auto ${isRtl ? 'order-2' : 'order-1'}`}>
        {/* Top bar */}
        <div className="flex items-center justify-between px-8 py-5 shrink-0">
          <div className="flex items-center gap-3">
            <BrandLogo className="w-9 h-9 rounded-lg" />
            <span className="text-lg font-semibold text-foreground">{brandName}</span>
          </div>
          <LanguageSelector />
        </div>

        {/* Form area */}
        <div className="flex-1 flex items-center justify-center px-6 pb-12">
          <div className="glass beam-border w-full max-w-[460px] space-y-7 rounded-3xl p-7 shadow-glow sm:p-9">
            {/* Step indicator */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary bg-primary/10 px-3 py-1 rounded-full">
                  {t('auth.signupStep')} {step}{t('auth.signupStepOf')}{TOTAL_STEPS}
                </span>
              </div>

              {/* Step progress bar */}
              <div className="flex gap-1.5">
                {Array.from({ length: TOTAL_STEPS }, (_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                      i < step ? 'bg-brand' : 'bg-border'
                    }`}
                  />
                ))}
              </div>

              <div className="space-y-2">
                <h1 className="text-3xl font-bold text-foreground tracking-tight">{stepTitle}</h1>
                <p className="text-muted-foreground">{stepSubtitle}</p>
              </div>
            </div>

            {step === 1 && (
              <>
                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="rounded-full bg-card px-3 text-muted-foreground">{t('auth.orContinueWith')}</span>
                  </div>
                </div>

                <SignupStepAccount
                  firstName={firstName} setFirstName={setFirstName}
                  lastName={lastName} setLastName={setLastName}
                  email={email} setEmail={setEmail}
                  password={password} setPassword={setPassword}
                  acceptedTerms={acceptedTerms} setAcceptedTerms={setAcceptedTerms}
                  loading={false} onSubmit={handleStep1} isRtl={isRtl}
                />

                <div className="pt-1 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('auth.hasAccount')}{' '}
                    <Link to="/auth/login" className="text-primary hover:underline font-semibold">
                      {t('auth.login')}
                    </Link>
                  </p>
                </div>
              </>
            )}

            {step === 2 && (
              <SignupStepCompany
                companyName={companyName} setCompanyName={setCompanyName}
                websiteDomain={websiteDomain} setWebsiteDomain={setWebsiteDomain}
                loading={loading} onSubmit={handleStep2} brandName={brandName}
              />
            )}
          </div>
        </div>
      </div>

      <AuthHeroPanel
        title={t('auth.signupPromoTitle')}
        subtitle={t('auth.signupPromoSubtitle')}
        className={`w-[44%] xl:w-[46%] ${isRtl ? 'order-1' : 'order-2'}`}
      />
    </div>
  );
}
