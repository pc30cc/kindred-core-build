import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import GetStartedWizard from '@/components/app/GetStartedWizard';

export default function OverviewPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();

  return (
    <div className="max-w-4xl mx-auto py-8 px-6 animate-fade-in">
      <GetStartedWizard />

      {/* Empty state brand logo — shown when no conversation selected, like Crisp */}
      <div className="mt-16 flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
          <span className="text-2xl font-black text-primary">{(platformName || 'A').charAt(0)}</span>
        </div>
        <h2 className="text-xl font-semibold text-foreground">{platformName}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('dashboard.welcomeBack')}{workspace ? ` — ${workspace.name}` : ''}
        </p>
      </div>
    </div>
  );
}
