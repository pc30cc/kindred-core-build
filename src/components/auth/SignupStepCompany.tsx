import { useTranslation } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ArrowRight, Loader2, Building2, Globe } from 'lucide-react';

interface SignupStepCompanyProps {
  companyName: string;
  setCompanyName: (v: string) => void;
  websiteDomain: string;
  setWebsiteDomain: (v: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  brandName: string;
}

export default function SignupStepCompany({
  companyName, setCompanyName, websiteDomain, setWebsiteDomain,
  loading, onSubmit,
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
