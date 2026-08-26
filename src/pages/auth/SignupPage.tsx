import { useState, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { toast } from '@/lib/toast';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import SignupStepAccount from '@/components/auth/SignupStepAccount';
import SignupStepCompany from '@/components/auth/SignupStepCompany';
import SignupStepAI from '@/components/auth/SignupStepAI';
import signupIllustration from '@/assets/signup-illustration.jpg';

const TOTAL_STEPS = 3;

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
  const [mainGoal, setMainGoal] = useState('');
  const [aiMode, setAiMode] = useState<'ai_first' | 'human_first' | ''>('');

  const [loading, setLoading] = useState(false);

  const brandName = useMemo(() => brand?.platform_name || 'App', [brand]);
  const brandLetter = useMemo(() => brandName.charAt(0), [brandName]);

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

  // Step 2: validate & go to step 3
  const handleStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;
    setStep(3);
  };

  // Step 3: register + create workspace
  const handleStep3 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiMode) return;

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
        metadata: { locale, companyName: companyName.trim(), websiteDomain: websiteDomain.trim(), mainGoal, aiMode },
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
      navigate(params.get('redirect') || '/app');
    } catch (err: any) {
      toast.error(t('auth.signupFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  const stepTitle = step === 1
    ? t('auth.signupStep1Title')
    : step === 2
    ? t('auth.signupStep2Title')
    : t('auth.signupStep3Title');

  const stepSubtitle = step === 1
    ? t('auth.signupStep1Subtitle', { brand: brandName })
    : step === 2
    ? t('auth.signupStep2Subtitle')
    : t('auth.step3Subtitle');

  return (
    <div className="fixed inset-0 flex" dir={dir}>
      {/* Left side — Form */}
      <div className={`flex-1 flex flex-col bg-background overflow-y-auto ${isRtl ? 'order-2' : 'order-1'}`}>
        {/* Top bar */}
        <div className="flex items-center justify-between px-8 py-5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-sm font-black text-primary-foreground">{brandLetter}</span>
            </div>
            <span className="text-lg font-semibold text-foreground">{brandName}</span>
          </div>
          <LanguageSelector />
        </div>

        {/* Form area */}
        <div className="flex-1 flex items-center justify-center px-6 pb-12">
          <div className="w-full max-w-[420px] space-y-7">
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
                      i < step ? 'bg-primary' : 'bg-border'
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
                    <span className="bg-background px-3 text-muted-foreground">{t('auth.orContinueWith')}</span>
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
                mainGoal={mainGoal} setMainGoal={setMainGoal}
                loading={false} onSubmit={handleStep2} brandName={brandName}
              />
            )}

            {step === 3 && (
              <SignupStepAI
                aiMode={aiMode} setAiMode={setAiMode}
                loading={loading} onSubmit={handleStep3} brandName={brandName}
              />
            )}
          </div>
        </div>
      </div>

      {/* Right side — Illustration panel */}
      <div className={`hidden lg:flex w-[42%] xl:w-[45%] relative overflow-hidden ${isRtl ? 'order-1' : 'order-2'}`}
        style={{ background: 'linear-gradient(135deg, hsl(250 80% 55%), hsl(280 70% 50%), hsl(250 80% 45%))' }}
      >
        <div className="absolute -top-24 -right-24 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute bottom-0 -left-20 w-[500px] h-[500px] rounded-full bg-white/5 blur-2xl" />
        <div className="absolute top-1/3 right-16 w-48 h-48 rounded-full bg-white/8 blur-xl" />

        <div className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        <div className="relative z-10 flex flex-col justify-center items-center p-12 text-center w-full">
          <div className="space-y-5 max-w-md">
            <h2 className="text-3xl xl:text-4xl font-bold text-white leading-tight">
              {t('auth.signupPromoTitle')}
            </h2>
            <p className="text-white/70 text-base leading-relaxed">
              {t('auth.signupPromoSubtitle')}
            </p>
          </div>

          <div className="mt-10 w-full max-w-md rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 transform hover:scale-[1.02] transition-transform duration-500">
            <img
              src={signupIllustration}
              alt="Team collaboration"
              className="w-full h-auto object-cover"
              width={960}
              height={1080}
            />
          </div>

          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {['Free Forever', 'No Credit Card', 'Setup in 2 min', 'Secure'].map((badge) => (
              <span key={badge} className="px-3 py-1.5 text-xs font-medium text-white/90 bg-white/10 rounded-full backdrop-blur-sm border border-white/10">
                ✓ {badge}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
