import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ArrowRight, Loader2, Building2, Globe, Target } from 'lucide-react';

const GOAL_KEYS = [
  'centralizeEmail',
  'buildChatbot',
  'buildAIAgent',
  'integrateMessaging',
  'chatWithVisitors',
  'justCurious',
] as const;

const GOAL_ICONS: Record<string, React.ReactNode> = {
  centralizeEmail: <span>📧</span>,
  buildChatbot: <span>🤖</span>,
  buildAIAgent: <span>🧠</span>,
  integrateMessaging: <span>💬</span>,
  chatWithVisitors: <span>👥</span>,
  justCurious: <span>👀</span>,
};

interface SignupStepCompanyProps {
  companyName: string;
  setCompanyName: (v: string) => void;
  websiteDomain: string;
  setWebsiteDomain: (v: string) => void;
  mainGoal: string;
  setMainGoal: (v: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  brandName: string;
}

export default function SignupStepCompany({
  companyName, setCompanyName, websiteDomain, setWebsiteDomain,
  mainGoal, setMainGoal, loading, onSubmit, brandName,
}: SignupStepCompanyProps) {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Company Name */}
      <div className="space-y-2">
        <Label htmlFor="companyName" className="text-foreground flex items-center gap-2">
          <Building2 className="w-4 h-4 text-muted-foreground" />
          {t('auth.companyNameLabel')}
        </Label>
        <Input
          id="companyName"
          type="text"
          placeholder={t('auth.companyNamePlaceholder')}
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className="h-12 bg-background border-border"
          required
          maxLength={100}
        />
      </div>

      {/* Website Domain */}
      <div className="space-y-2">
        <Label htmlFor="websiteDomain" className="text-foreground flex items-center gap-2">
          <Globe className="w-4 h-4 text-muted-foreground" />
          {t('auth.websiteDomainLabel')}
        </Label>
        <Input
          id="websiteDomain"
          type="text"
          placeholder={t('auth.websiteDomainPlaceholder')}
          value={websiteDomain}
          onChange={(e) => setWebsiteDomain(e.target.value)}
          dir="ltr"
          className="h-12 text-left bg-background border-border"
          maxLength={255}
        />
        <p className="text-xs text-muted-foreground">{t('auth.websiteDomainHint')}</p>
      </div>

      {/* Main Goal */}
      <div className="space-y-3">
        <Label className="text-foreground flex items-center gap-2">
          <Target className="w-4 h-4 text-muted-foreground" />
          {t('auth.mainGoalLabel', { brand: brandName })}
        </Label>
        <div className="grid grid-cols-1 gap-2">
          {GOAL_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMainGoal(key)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all text-start ${
                mainGoal === key
                  ? 'border-primary bg-primary/5 text-foreground ring-2 ring-primary/20'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-accent/50'
              }`}
            >
              <span className="text-lg">{GOAL_ICONS[key]}</span>
              {t(`auth.goal_${key}`)}
            </button>
          ))}
        </div>
      </div>

      <Button type="submit" className="w-full h-12 text-base font-semibold gap-2" disabled={loading || !companyName.trim()}>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            {t('auth.continue')}
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </Button>
    </form>
  );
}
