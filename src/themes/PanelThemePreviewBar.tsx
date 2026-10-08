import { Link } from 'react-router-dom';
import { Eye, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { panelThemeLabel } from './registry';
import type { PanelThemeSelection } from '../../shared/panelThemes';

/**
 * Floats over the workspace panel while this tab previews a theme (or a
 * layout / colour scheme of it) the Super Admin has not activated yet (Super
 * Admin → Panel theme → Preview). Only this tab wears it; ending the preview
 * returns to the platform's theme.
 */
export function PanelThemePreviewBar({ preview, onEnd }: { preview: PanelThemeSelection; onEnd: () => void }) {
  const { t } = useTranslation();
  const name = panelThemeLabel(t, preview);

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 md:bottom-6"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border bg-popover/95 py-1.5 pe-1.5 ps-3 text-sm text-popover-foreground shadow-lg backdrop-blur">
        <Eye className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 truncate">{t('admin.panelThemes.preview.banner', { name })}</span>
        <Button asChild size="sm" variant="ghost" className="h-8 shrink-0 rounded-full px-3">
          <Link to="/admin/panel-theme">{t('admin.panelThemes.preview.settings')}</Link>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 shrink-0 gap-1.5 rounded-full px-3"
          onClick={onEnd}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          {t('admin.panelThemes.preview.end')}
        </Button>
      </div>
    </div>
  );
}
