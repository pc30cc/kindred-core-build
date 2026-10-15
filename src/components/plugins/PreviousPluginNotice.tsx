/**
 * Shown in the RESPOK build when a connected store still runs the previous
 * (Iran-named) build of the plugin (`plugin_edition: 'previous'` from the
 * connections API). That build keeps working, but receives no updates from
 * this platform: the owner installs this platform's plugin, which can sit
 * beside the old one, and pairs again. The Iran build never shows it (there
 * the previous build is the current one).
 */
import { AlertTriangle, Download } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useBrandTokens } from '@/lib/brand';
import { SHIPS_IRAN_KIT } from '../../../shared/buildBrand';

export function PreviousPluginNotice({ pluginEdition, downloadPath }: { pluginEdition?: string | null; downloadPath: string }) {
  const { t, locale } = useTranslation();
  const { brand } = useBrandTokens(locale);
  if (SHIPS_IRAN_KIT || pluginEdition !== 'previous') return null;
  return (
    <Alert data-previous-plugin-notice="">
      <AlertTriangle className="h-4 w-4" aria-hidden />
      <AlertTitle>{t('plugins.previousEdition.title', { brand })}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t('plugins.previousEdition.body', { brand })}</p>
        <Button asChild size="sm" variant="outline">
          <a href={downloadPath} download>
            <Download className="me-2 h-4 w-4" aria-hidden />
            {t('plugins.previousEdition.download', { brand })}
          </a>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
