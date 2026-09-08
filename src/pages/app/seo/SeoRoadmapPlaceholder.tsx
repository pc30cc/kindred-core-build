import { Construction } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/i18n';

/**
 * Shared placeholder for every SEO nav leaf that is on the roadmap but not
 * built yet (see `built: false` in seoNavTree.ts). Never fabricates data —
 * says plainly that the report is planned, not "coming soon" with a fake
 * preview.
 */
export function SeoRoadmapPlaceholder({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <Card className="overflow-hidden">
      <CardContent className="relative flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/5 to-transparent" />
        <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-lg">
          <Construction className="h-6 w-6" />
        </span>
        <h3 className="relative text-lg font-semibold">{label}</h3>
        <p className="relative max-w-md text-sm text-muted-foreground">{t('seo.nav.roadmapDescription' as any)}</p>
      </CardContent>
    </Card>
  );
}
