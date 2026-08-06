/**
 * SmartRulePreviewStudio — the dedicated simulator for Smart Engagement.
 *
 * This is deliberately NOT the generic widget preview used by the other tabs:
 * a smart action is a *scenario*, so the operator needs to see the surface on
 * a simulated visitor page, switch the conditions that decide whether it fires
 * (device, language, team availability, visitor type, page URL) and read a
 * plain explanation of the engine's verdict.
 *
 * The verdict comes from the very same evaluator the visitor's browser runs
 * (`src/lib/widget/smartEngine.ts` → `public/widget/smart-engine.js`), so the
 * explanation can never drift from production behaviour.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Monitor, Smartphone, RotateCcw, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WidgetLivePreview, type PreviewView } from '@/components/app/widget/WidgetLivePreview';
import {
  evaluateSmartRule,
  resolveSmartContent,
  type SmartEvalContext,
  type SmartRule,
} from '@/lib/widget/smartEngine';
import type { SmartRuleDraft } from '@/lib/widget/smartRules';

export interface SmartRulePreviewStudioProps {
  draft: SmartRuleDraft;
  settings: Record<string, any> | null | undefined;
  brandName: string;
  locale: string;
  locales: string[];
  localeLabels: Record<string, string>;
  kbArticles?: { title: string; excerpt?: string | null; content?: string | null }[];
  kbCategories?: { name: string; description?: string | null }[];
}

/** Presentation mode → which widget screen the surface belongs to. */
function viewForMode(mode: string): PreviewView {
  if (mode === 'chat_message') return 'chat';
  return 'home';
}

export function SmartRulePreviewStudio({
  draft, settings, brandName, locale, locales, localeLabels, kbArticles, kbCategories,
}: SmartRulePreviewStudioProps) {
  const { t, dir } = useTranslation();

  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [previewLocale, setPreviewLocale] = useState(locale);
  const [online, setOnline] = useState(true);
  const [returning, setReturning] = useState(false);
  const [pageUrl, setPageUrl] = useState('https://example.com/pricing?utm_source=google');
  /** Set to true to pretend the trigger's waiting period has already elapsed. */
  const [triggerFired, setTriggerFired] = useState(true);

  const mode = draft.presentation_config?.mode || 'launcher_nudge';

  const content = useMemo(
    () => resolveSmartContent(draft.content_config as any, previewLocale),
    [draft.content_config, previewLocale],
  );

  const surface = useMemo(() => {
    if (!content || !content.body) return null;
    return {
      mode,
      title: content.title,
      body: content.body,
      ctaLabel: content.cta_label,
      dismissible: draft.presentation_config?.dismissible !== false,
    };
  }, [content, mode, draft.presentation_config?.dismissible]);

  const verdict = useMemo(() => {
    let parsed: URL | null = null;
    try { parsed = new URL(pageUrl); } catch { parsed = null; }
    const query: Record<string, string> = {};
    if (parsed) parsed.searchParams.forEach((v, k) => { query[k.toLowerCase()] = v; });

    const trigger = draft.trigger_config || { type: 'page_load' as const };
    const seconds = Number((trigger as any).seconds) || 0;
    const percent = Number((trigger as any).percent) || 0;

    const ctx: SmartEvalContext = {
      masterEnabled: true,
      mode: 'preview',
      page: {
        url: pageUrl,
        path: parsed?.pathname || '/',
        hostname: parsed?.hostname || 'example.com',
        title: 'Pricing',
        query,
      },
      referrer: '',
      utm: { source: query.utm_source, medium: query.utm_medium, campaign: query.utm_campaign },
      device,
      browser: 'Chrome',
      os: device === 'mobile' ? 'Android' : 'macOS',
      locale: previewLocale,
      visitor: { isReturning: returning, sessionPageCount: returning ? 4 : 1 },
      availability: { online },
      interaction: {},
      signals: {
        elapsedMs: triggerFired ? (seconds + 5) * 1000 : 0,
        scrollPercent: triggerFired ? Math.max(percent, 100) : 0,
        inactiveMs: triggerFired ? (seconds + 5) * 1000 : 0,
        exitIntent: triggerFired,
        pageHidden: false,
      },
      frequency: {},
      msSinceLastSurface: null,
    };
    return evaluateSmartRule(draft as unknown as SmartRule, ctx, new Date());
  }, [draft, pageUrl, device, previewLocale, returning, online, triggerFired]);

  const outcomeTone =
    verdict.outcome === 'matched' ? 'success'
      : verdict.outcome === 'waiting' ? 'warning'
        : 'destructive';

  const OutcomeIcon =
    verdict.outcome === 'matched' ? CheckCircle2
      : verdict.outcome === 'waiting' ? Clock
        : XCircle;

  const previewSettings = useMemo(
    () => ({ ...(settings || {}), widget_language: previewLocale }),
    [settings, previewLocale],
  );

  return (
    <div className="space-y-3" dir={dir}>
      {/* Scenario controls */}
      <Card className="card-elevated">
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.device')}</Label>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
              {([['desktop', Monitor], ['mobile', Smartphone]] as const).map(([key, Icon]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={device === key ? 'default' : 'ghost'}
                  className="h-7 gap-1.5 px-2.5 text-[11px]"
                  onClick={() => setDevice(key)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(`widgetPage.smart.studio.${key}` as any)}
                </Button>
              ))}
            </div>
          </div>

          {locales.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.message.localeTab')}</Label>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
                {locales.map((l) => (
                  <Button
                    key={l}
                    size="sm"
                    variant={previewLocale === l ? 'default' : 'ghost'}
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => setPreviewLocale(l)}
                  >
                    {localeLabels[l] || l}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.page')}</Label>
            <Input
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
              className="h-8 text-[12px]"
              dir="ltr"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={online} onCheckedChange={setOnline} />
            <span className="text-[11px]">{t('widgetPage.smart.studio.online')}</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={returning} onCheckedChange={setReturning} />
            <span className="text-[11px]">{t('widgetPage.smart.studio.returning')}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-[11px]"
            onClick={() => setTriggerFired((v) => !v)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {triggerFired
              ? t('widgetPage.smart.studio.simulateWaiting')
              : t('widgetPage.smart.studio.simulateFired')}
          </Button>
        </CardContent>
      </Card>

      {/* Verdict */}
      <Card className="card-elevated">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center gap-2">
            <OutcomeIcon
              className={cn(
                'h-4 w-4',
                outcomeTone === 'success' && 'text-success',
                outcomeTone === 'warning' && 'text-warning',
                outcomeTone === 'destructive' && 'text-destructive',
              )}
            />
            <p className="text-sm font-semibold">
              {t(`widgetPage.smart.studio.outcome.${verdict.outcome}` as any)}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {verdict.reasons.map((r, i) => (
              <Badge
                key={`${r.code}-${i}`}
                variant="outline"
                className={cn(
                  'text-[10px] font-normal',
                  r.state === 'pass' && 'border-success/40 bg-success/10 text-success',
                  r.state === 'pending' && 'border-warning/40 bg-warning/10 text-warning',
                  r.state === 'fail' && 'border-destructive/40 bg-destructive/10 text-destructive',
                )}
              >
                {t(`widgetPage.smart.studio.reason.${r.code}` as any, { defaultValue: r.code })}
                {r.detail
                  ? ` (${Object.entries(r.detail).map(([k, v]) => `${k}: ${v}`).join(', ')})`
                  : ''}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Simulated visitor page */}
      <div className="overflow-hidden rounded-xl border border-border bg-[linear-gradient(135deg,hsl(var(--muted))_0%,hsl(var(--secondary))_100%)] p-4">
        <div
          className="mx-auto transition-all"
          style={{
            width: device === 'mobile' ? 380 : '100%',
            maxWidth: device === 'mobile' ? 380 : 720,
            height: 620,
          }}
        >
          <WidgetLivePreview
            settings={previewSettings}
            brandName={brandName}
            view={viewForMode(mode)}
            kbArticles={kbArticles}
            kbCategories={kbCategories}
            smartPreview={verdict.outcome === 'matched' ? (surface as any) : null}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.hint')}</p>
    </div>
  );
}
