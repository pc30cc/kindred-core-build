/**
 * SmartRulePreviewStudio — the scenario simulator for Smart Engagement.
 *
 * This is deliberately NOT the generic widget preview used by the other tabs.
 * A smart action is a *scenario*, so the operator drives a simulated visitor
 * session (signals, interaction state, frequency history, schedule clock) and
 * watches the real widget react. The verdict comes from the very same evaluator
 * the visitor's browser runs (`src/lib/widget/smartEngine.ts` →
 * `public/widget/smart-engine.js`), so the explanation can never drift from
 * production behaviour.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Monitor, Smartphone, Tablet, RotateCcw, CheckCircle2, Clock, XCircle,
  Play, Pause, Zap, Languages,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  WidgetLivePreview,
  type SmartPreviewPhase,
  type SmartPreviewScenario,
} from '@/components/app/widget/WidgetLivePreview';
import {
  evaluateSmartRule,
  resolveSmartContent,
  type SmartEvalContext,
  type SmartReason,
} from '@/lib/widget/smartEngine';
import { draftToSmartRule, type SmartRuleDraft } from '@/lib/widget/smartRules';

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

/** One tick of simulated time, in milliseconds. */
const TICK_MS = 250;

/** Ordered lifecycle used by the timeline. */
const TIMELINE: SmartPreviewPhase[] = [
  'idle', 'waiting', 'matched', 'surface_shown', 'widget_opened', 'cta_clicked',
];

export function SmartRulePreviewStudio({
  draft, settings, brandName, locale, locales, localeLabels, kbArticles, kbCategories,
}: SmartRulePreviewStudioProps) {
  const { t, dir } = useTranslation();

  /* ── Scenario: environment ─────────────────────────────────────────── */
  const [device, setDevice] = useState<'desktop' | 'mobile' | 'tablet'>('desktop');
  const [previewLocale, setPreviewLocale] = useState(locale);
  const [rtlOverride, setRtlOverride] = useState<boolean | null>(null);
  const [online, setOnline] = useState(true);
  const [returning, setReturning] = useState(false);
  const [pageUrl, setPageUrl] = useState('https://example.com/pricing?utm_source=google');
  const [referrer, setReferrer] = useState('https://www.google.com/');
  const [simulatedNow, setSimulatedNow] = useState<string>('');

  /* ── Scenario: live signals ────────────────────────────────────────── */
  const [playing, setPlaying] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [inactiveMs, setInactiveMs] = useState(0);
  const [scrollPercent, setScrollPercent] = useState(0);
  const [exitIntent, setExitIntent] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);

  /* ── Scenario: widget interaction state ────────────────────────────── */
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const [visitorTyping, setVisitorTyping] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [prechatOpen, setPrechatOpen] = useState(false);
  const [anotherRuleShowing, setAnotherRuleShowing] = useState(false);

  /* ── Scenario: frequency history ───────────────────────────────────── */
  const [dismissedBefore, setDismissedBefore] = useState(false);
  const [ctaClickedBefore, setCtaClickedBefore] = useState(false);
  const [shownInSession, setShownInSession] = useState(0);
  const [shownTotal, setShownTotal] = useState(0);

  /* ── Lifecycle latches (what the visitor already did *this* run) ────── */
  const [terminal, setTerminal] = useState<'dismissed' | 'cta_clicked' | null>(null);
  const [visited, setVisited] = useState<SmartPreviewPhase[]>(['idle']);

  const mode = draft.presentation_config?.mode || 'launcher_nudge';
  const triggerType = draft.trigger_config?.type || 'page_load';

  /* Simulated clock. */
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setElapsedMs((v) => v + TICK_MS);
      setInactiveMs((v) => v + TICK_MS);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const content = useMemo(
    () => resolveSmartContent(draftToSmartRule(draft), previewLocale),
    [draft, previewLocale],
  );

  const verdict = useMemo(() => {
    let parsed: URL | null = null;
    try { parsed = new URL(pageUrl); } catch { parsed = null; }
    const query: Record<string, string> = {};
    if (parsed) parsed.searchParams.forEach((v, k) => { query[k.toLowerCase()] = v; });

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
      referrer,
      utm: { source: query.utm_source, medium: query.utm_medium, campaign: query.utm_campaign },
      device,
      browser: 'Chrome',
      os: device === 'desktop' ? 'macOS' : device === 'tablet' ? 'iPadOS' : 'Android',
      locale: previewLocale,
      visitor: {
        isReturning: returning,
        visitCount: returning ? 4 : 1,
        sessionPageCount: returning ? 4 : 1,
      },
      availability: { online },
      interaction: {
        widgetOpen,
        conversationActive,
        visitorTyping,
        callActive,
        prechatOpen,
        anotherRuleShowing,
      },
      signals: { elapsedMs, scrollPercent, inactiveMs, exitIntent, pageHidden },
      frequency: {
        dismissed: dismissedBefore,
        ctaClicked: ctaClickedBefore,
        shownInSession,
        shownTotal,
        shownToday: shownTotal,
        shownThisWeek: shownTotal,
        lastShownAt: shownTotal > 0 ? Date.now() - 60_000 : null,
      },
      msSinceLastSurface: shownTotal > 0 ? 60_000 : null,
    };
    const now = simulatedNow ? new Date(simulatedNow) : new Date();
    return evaluateSmartRule(draftToSmartRule(draft), ctx, isNaN(now.getTime()) ? new Date() : now);
  }, [
    draft, pageUrl, referrer, device, previewLocale, returning, online, elapsedMs, inactiveMs,
    scrollPercent, exitIntent, pageHidden, widgetOpen, conversationActive, visitorTyping,
    callActive, prechatOpen, anotherRuleShowing, dismissedBefore, ctaClickedBefore,
    shownInSession, shownTotal, simulatedNow,
  ]);

  /* Phase is derived from the verdict plus what the visitor already did. */
  const phase: SmartPreviewPhase = useMemo(() => {
    if (terminal) return terminal;
    if (verdict.outcome === 'matched') {
      return mode === 'open_widget' ? 'widget_opened' : 'surface_shown';
    }
    if (verdict.outcome === 'waiting') return elapsedMs > 0 ? 'waiting' : 'idle';
    return 'suppressed';
  }, [terminal, verdict.outcome, mode, elapsedMs]);

  useEffect(() => {
    setVisited((prev) => (prev[prev.length - 1] === phase ? prev : [...prev, phase]));
  }, [phase]);

  const handleSmartEvent = useCallback((type: 'dismiss' | 'cta' | 'widget-opened' | 'widget-closed') => {
    if (type === 'dismiss') setTerminal('dismissed');
    if (type === 'cta') setTerminal('cta_clicked');
    if (type === 'widget-opened') setWidgetOpen(true);
    if (type === 'widget-closed') setWidgetOpen(false);
  }, []);

  const reset = () => {
    setPlaying(true);
    setElapsedMs(0); setInactiveMs(0); setScrollPercent(0);
    setExitIntent(false); setPageHidden(false);
    setWidgetOpen(false); setConversationActive(false); setVisitorTyping(false);
    setCallActive(false); setPrechatOpen(false); setAnotherRuleShowing(false);
    setTerminal(null);
    setVisited(['idle']);
  };

  /** Force the configured trigger to be satisfied right now. */
  const fireTrigger = () => {
    const cfg: any = draft.trigger_config || {};
    const seconds = Number(cfg.seconds) || 0;
    const percent = Number(cfg.percent) || 0;
    if (triggerType === 'time_on_page') setElapsedMs((seconds + 1) * 1000);
    else if (triggerType === 'scroll_depth') setScrollPercent(Math.max(percent, scrollPercent, 1));
    else if (triggerType === 'inactivity') setInactiveMs((seconds + 1) * 1000);
    else if (triggerType === 'exit_intent') setExitIntent(true);
    else setElapsedMs((v) => Math.max(v, TICK_MS));
    setPlaying(false);
  };

  const scenario = useMemo<SmartPreviewScenario>(() => ({
    rule: draft,
    content: content && content.body
      ? { title: content.title, body: content.body, ctaLabel: content.cta_label }
      : null,
    verdict,
    phase,
    device: device === 'desktop' ? 'desktop' : 'mobile',
    locale: previewLocale,
    rtl: rtlOverride === null ? previewLocale === 'fa' : rtlOverride,
  }), [draft, content, verdict, phase, device, previewLocale, rtlOverride, t]);

  const previewSettings = useMemo(
    () => ({ ...(settings || {}), widget_language: previewLocale }),
    [settings, previewLocale],
  );

  const outcomeTone =
    verdict.outcome === 'matched' ? 'success'
      : verdict.outcome === 'waiting' ? 'warning'
        : 'destructive';

  const OutcomeIcon =
    verdict.outcome === 'matched' ? CheckCircle2
      : verdict.outcome === 'waiting' ? Clock
        : XCircle;

  /** Human sentence for a reason, using the numbers the evaluator reported. */
  const explain = (r: SmartReason) => {
    const detail = (r.detail || {}) as Record<string, any>;
    const label = t(`widgetPage.smart.studio.reason.${r.code}` as any);
    if (r.code === 'WAITING_FOR_DELAY' && detail.requiredMs != null) {
      return `${label} — ${t('widgetPage.smart.studio.detail.elapsedOf', {
        elapsed: Math.round((detail.elapsedMs ?? elapsedMs) / 1000),
        required: Math.round(Number(detail.requiredMs) / 1000),
      } as any)}`;
    }
    if (r.code === 'SCROLL_NOT_REACHED' && detail.required != null) {
      return `${label} — ${t('widgetPage.smart.studio.detail.scrollOf', {
        current: Math.round(detail.current ?? scrollPercent),
        required: Math.round(Number(detail.required)),
      } as any)}`;
    }
    if (r.code === 'FREQUENCY_LIMITED' && detail.cap != null) {
      return `${label} — ${t('widgetPage.smart.studio.detail.shownOf', {
        shown: detail.shown ?? shownTotal,
        cap: detail.cap,
      } as any)}`;
    }
    const rest = Object.entries(detail)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    return rest ? `${label} (${rest})` : label;
  };

  const toggles: { key: string; value: boolean; set: (v: boolean) => void }[] = [
    { key: 'online', value: online, set: setOnline },
    { key: 'returning', value: returning, set: setReturning },
    { key: 'exitIntent', value: exitIntent, set: setExitIntent },
    { key: 'pageHidden', value: pageHidden, set: setPageHidden },
    { key: 'conversationActive', value: conversationActive, set: setConversationActive },
    { key: 'visitorTyping', value: visitorTyping, set: setVisitorTyping },
    { key: 'callActive', value: callActive, set: setCallActive },
    { key: 'prechatOpen', value: prechatOpen, set: setPrechatOpen },
    { key: 'anotherRuleShowing', value: anotherRuleShowing, set: setAnotherRuleShowing },
    { key: 'dismissedBefore', value: dismissedBefore, set: setDismissedBefore },
    { key: 'ctaClickedBefore', value: ctaClickedBefore, set: setCtaClickedBefore },
  ];

  return (
    <div className="space-y-3" dir={dir}>
      {/* ── Scenario controls ── */}
      <Card className="card-elevated">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.device')}</Label>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
                {([['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([key, Icon]) => (
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
                      onClick={() => { setPreviewLocale(l); setRtlOverride(null); }}
                    >
                      {localeLabels[l] || l}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.direction')}</Label>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-[11px]"
                onClick={() => setRtlOverride(!(rtlOverride === null ? previewLocale === 'fa' : rtlOverride))}
              >
                <Languages className="h-3.5 w-3.5" />
                {(rtlOverride === null ? previewLocale === 'fa' : rtlOverride) ? 'RTL' : 'LTR'}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.page')}</Label>
              <Input value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} className="h-8 text-[12px]" dir="ltr" />
            </div>
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.referrer')}</Label>
              <Input value={referrer} onChange={(e) => setReferrer(e.target.value)} className="h-8 text-[12px]" dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.simulatedTime')}</Label>
              <Input
                type="datetime-local"
                value={simulatedNow}
                onChange={(e) => setSimulatedNow(e.target.value)}
                className="h-8 text-[12px]"
                dir="ltr"
              />
            </div>
          </div>

          {/* Signals */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t('widgetPage.smart.studio.timeOnPage')}: {Math.round(elapsedMs / 1000)}s
              </Label>
              <Slider value={[Math.round(elapsedMs / 1000)]} min={0} max={180} step={1}
                onValueChange={([v]) => setElapsedMs(v * 1000)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t('widgetPage.smart.studio.scroll')}: {scrollPercent}%
              </Label>
              <Slider value={[scrollPercent]} min={0} max={100} step={1}
                onValueChange={([v]) => setScrollPercent(v)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t('widgetPage.smart.studio.inactivity')}: {Math.round(inactiveMs / 1000)}s
              </Label>
              <Slider value={[Math.round(inactiveMs / 1000)]} min={0} max={180} step={1}
                onValueChange={([v]) => setInactiveMs(v * 1000)} />
            </div>
          </div>

          {/* Frequency history */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t('widgetPage.smart.studio.shownInSession')}: {shownInSession}
              </Label>
              <Slider value={[shownInSession]} min={0} max={10} step={1}
                onValueChange={([v]) => setShownInSession(v)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t('widgetPage.smart.studio.shownTotal')}: {shownTotal}
              </Label>
              <Slider value={[shownTotal]} min={0} max={20} step={1}
                onValueChange={([v]) => setShownTotal(v)} />
            </div>
          </div>

          {/* State toggles */}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {toggles.map((tg) => (
              <label key={tg.key} className="flex items-center gap-2">
                <Switch checked={tg.value} onCheckedChange={tg.set} />
                <span className="text-[11px]">{t(`widgetPage.smart.studio.${tg.key}` as any)}</span>
              </label>
            ))}
          </div>

          {/* Transport */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => setPlaying((v) => !v)}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {t(playing ? 'widgetPage.smart.studio.pause' : 'widgetPage.smart.studio.play')}
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={fireTrigger}>
              <Zap className="h-3.5 w-3.5" />
              {t('widgetPage.smart.studio.fireTrigger')}
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={reset}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('widgetPage.smart.studio.reset')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Verdict + timeline ── */}
      <Card className="card-elevated">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <OutcomeIcon
              className={cn(
                'h-4 w-4',
                outcomeTone === 'success' && 'text-success',
                outcomeTone === 'warning' && 'text-warning',
                outcomeTone === 'destructive' && 'text-destructive',
              )}
            />
            <p className="text-sm font-semibold">{t(`widgetPage.smart.studio.outcome.${verdict.outcome}` as any)}</p>
          </div>

          {/* Real lifecycle transitions, not a static checklist. */}
          <ol className="flex flex-wrap items-center gap-1.5">
            {TIMELINE.map((step) => {
              const reached = visited.includes(step);
              const current = phase === step;
              return (
                <li
                  key={step}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px]',
                    current && 'border-primary bg-primary/10 font-semibold text-primary',
                    !current && reached && 'border-success/40 bg-success/10 text-success',
                    !reached && 'border-border text-muted-foreground',
                  )}
                >
                  {t(`widgetPage.smart.studio.timeline.${step}` as any)}
                </li>
              );
            })}
            {terminal === 'dismissed' && (
              <li className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive">
                {t('widgetPage.smart.studio.timeline.dismissed')}
              </li>
            )}
          </ol>

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
                {explain(r)}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Simulated visitor page ── */}
      <div className="overflow-hidden rounded-xl border border-border bg-[linear-gradient(135deg,hsl(var(--muted))_0%,hsl(var(--secondary))_100%)] p-4">
        <div
          className="mx-auto transition-all"
          style={{
            width: device === 'mobile' ? 380 : device === 'tablet' ? 560 : '100%',
            maxWidth: device === 'mobile' ? 380 : device === 'tablet' ? 560 : 720,
            height: 820,
          }}
        >
          <WidgetLivePreview
            settings={previewSettings}
            workspaceName={brandName}
            platformName={brandName}
            view={mode === 'chat_message' ? 'chat' : 'home'}
            kbArticles={kbArticles}
            kbCategories={kbCategories}
            previewMode="smart"
            smartScenario={scenario}
            onSmartEvent={handleSmartEvent}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('widgetPage.smart.studio.hint')}</p>
    </div>
  );
}
