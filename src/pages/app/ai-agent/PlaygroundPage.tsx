import { useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings } from '@/hooks/useAiAgent';
import { aiAgentApi, type PlaygroundResult, type TestRunResult } from '@/lib/ai-agent-api';
import { useTranslation, type TranslationKey } from '@/i18n';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { contentLocaleFor } from '@/lib/region';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Beaker, Loader2, AlertTriangle, Bot, ArrowRight, Microscope } from 'lucide-react';

type Translate = ReturnType<typeof useTranslation>['t'];

// The codes the server sends, shown as words; a code not listed here shows as it is.
const ACTION: Record<string, TranslationKey> = {
  answer: 'aiAgent.playground.action.answer',
  handoff: 'aiAgent.playground.action.handoff',
  no_answer: 'aiAgent.playground.action.no_answer',
  blocked: 'aiAgent.playground.action.blocked',
};
const REASON: Record<string, TranslationKey> = {
  human_request: 'aiAgent.playground.reason.human_request',
  no_kb_match: 'aiAgent.playground.reason.no_kb_match',
  no_sources: 'aiAgent.playground.reason.no_sources',
  low_confidence: 'aiAgent.playground.reason.low_confidence',
  routing_handoff: 'aiAgent.playground.reason.routing_handoff',
};
const KIND: Record<string, TranslationKey> = {
  qna: 'aiAgent.playground.kind.qna',
  kb_article: 'aiAgent.playground.kind.kb_article',
};
const LANGUAGE: Record<string, TranslationKey> = {
  en: 'aiAgent.playground.lang.en',
  fa: 'aiAgent.playground.lang.fa',
  tr: 'aiAgent.playground.lang.tr',
  ar: 'aiAgent.playground.lang.ar',
  unknown: 'aiAgent.playground.lang.unknown',
};
// The dry run's warnings by code; another code shows the server's message.
const WARNING: Record<string, TranslationKey> = {
  no_sources: 'aiAgent.playground.warning.no_sources',
  language_low_confidence: 'aiAgent.playground.warning.language_low_confidence',
};
const ERROR: Record<string, TranslationKey> = {
  playground_rate_limited: 'aiAgent.playground.error.playground_rate_limited',
  playground_failed: 'aiAgent.playground.error.playground_failed',
  test_run_failed: 'aiAgent.playground.error.test_run_failed',
  invalid_params: 'aiAgent.playground.error.invalid_params',
  network_error: 'aiAgent.playground.error.network_error',
};

function keyFor(map: Record<string, TranslationKey>, code: string | null | undefined): TranslationKey | undefined {
  return code && Object.prototype.hasOwnProperty.call(map, code) ? map[code] : undefined;
}

function codeLabel(t: Translate, map: Record<string, TranslationKey>, code: string): string {
  const key = keyFor(map, code);
  return key ? t(key) : code;
}

/** A failed test's message: the server's code, in words when it is a known one. */
function failureText(t: Translate, e: unknown): string {
  const message = (e as { message?: string } | null)?.message;
  return (message && codeLabel(t, ERROR, message)) || t('aiAgent.playground.failed');
}

const percent = (value: number) => (value * 100).toFixed(0);

export default function PlaygroundPage() {
  const { workspace } = useActiveWorkspace();
  const { t, locale: uiLocale } = useTranslation();
  // The test plays a VISITOR's question, so it is answered in a visitors'
  // language (usePlatformRegion().allowedLocales; Iran: Persian only): the
  // dashboard's own when visitors have it (RESPOK: en and tr, as before),
  // else the first. The dashboard may be English or Turkish on WebYar while
  // its visitors stay Persian (shared/panelLanguages.ts).
  const { allowedLocales } = usePlatformRegion();
  const replyLocale = contentLocaleFor(uiLocale, allowedLocales);
  const { data: settingsData } = useAiAgentSettings(workspace?.id);
  const settings = settingsData?.settings;
  const [question, setQuestion] = useState('');
  const [guidance, setGuidance] = useState<'conservative' | 'balanced' | 'creative' | 'auto'>('auto');
  const [model, setModel] = useState<string>('auto');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'reply' | 'analysis'>('reply');
  const [dryLoading, setDryLoading] = useState(false);
  const [dryResult, setDryResult] = useState<TestRunResult | null>(null);
  const [dryError, setDryError] = useState<string | null>(null);

  const onTest = async () => {
    if (!workspace?.id || !question.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await aiAgentApi.playground({
        workspaceId: workspace.id,
        question,
        locale: replyLocale,
        guidanceOverride: guidance === 'auto' ? undefined : guidance,
        modelOverride: model === 'auto' ? undefined : model,
      });
      setResult(r);
    } catch (e) {
      setError(failureText(t, e));
    } finally {
      setLoading(false);
    }
  };

  const onDryRun = async () => {
    if (!workspace?.id || !question.trim()) return;
    setDryLoading(true);
    setDryError(null);
    setDryResult(null);
    try {
      const r = await aiAgentApi.testRun({ workspaceId: workspace.id, message: question, visitorLocale: replyLocale });
      setDryResult(r);
    } catch (e) {
      setDryError(failureText(t, e));
    } finally { setDryLoading(false); }
  };

  const actionBadge = (a: string) => {
    const map: Record<string, string> = {
      answer: 'bg-success/15 text-success border-success/30',
      handoff: 'bg-warning/15 text-warning border-warning/30',
      no_answer: 'bg-muted text-muted-foreground',
      blocked: 'bg-destructive/15 text-destructive border-destructive/30',
    };
    return map[a] || 'bg-muted';
  };

  const none = <span className="text-xs text-muted-foreground">{t('aiAgent.playground.analysis.none')}</span>;

  return (
    <div className="space-y-6 animate-fade-in">
      <AiPageHeader icon={Beaker} accent="violet" title={t('aiAgent.playground.title')} subtitle={t('aiAgent.playground.subtitle')} />

      {settings && !settings.enabled && (
        <div className="flex items-start gap-2.5 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p>{t('aiAgent.playground.disabled')}</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="reply"><Bot className="h-3.5 w-3.5 me-1.5" />{t('aiAgent.playground.tabReply')}</TabsTrigger>
          <TabsTrigger value="analysis"><Microscope className="h-3.5 w-3.5 me-1.5" />{t('aiAgent.playground.tabAnalysis')}</TabsTrigger>
        </TabsList>

        <TabsContent value="reply" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">{t('aiAgent.playground.reply.title')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>{t('aiAgent.playground.reply.model')}</Label>
                    <Select value={model} onValueChange={setModel}>
                      {/* Model names keep their Latin digits in Persian. */}
                      <SelectTrigger data-latin-digits=""><SelectValue /></SelectTrigger>
                      <SelectContent data-latin-digits="">
                        <SelectItem value="auto">{t('aiAgent.playground.reply.modelAuto')}</SelectItem>
                        <SelectItem value="gpt-5-nano">gpt-5-nano</SelectItem>
                        <SelectItem value="gpt-5-mini">gpt-5-mini</SelectItem>
                        <SelectItem value="gpt-5">gpt-5</SelectItem>
                        <SelectItem value="gpt-4o-mini">gpt-4o-mini</SelectItem>
                        <SelectItem value="gpt-4o">gpt-4o</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t('aiAgent.playground.reply.guidance')}</Label>
                    <Select value={guidance} onValueChange={(v) => setGuidance(v as typeof guidance)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t('aiAgent.playground.reply.guidanceAuto')}</SelectItem>
                        <SelectItem value="conservative">{t('aiAgent.playground.reply.guidanceConservative')}</SelectItem>
                        <SelectItem value="balanced">{t('aiAgent.playground.reply.guidanceBalanced')}</SelectItem>
                        <SelectItem value="creative">{t('aiAgent.playground.reply.guidanceCreative')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label>{t('aiAgent.playground.reply.question')}</Label>
                  <Textarea rows={5} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('aiAgent.playground.reply.questionPlaceholder')} />
                </div>
                <Button onClick={onTest} disabled={loading || !question.trim()} className="w-full">
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <ArrowRight className="h-3.5 w-3.5 me-1.5 rtl:rotate-180" />}
                  {t('aiAgent.playground.reply.run')}
                </Button>
                {error && <p className="text-sm text-destructive">{error}</p>}
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-primary/5 to-primary/0 border-primary/20">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{t('aiAgent.playground.result.title')}</CardTitle>
                  {result && <Badge variant="outline" className={actionBadge(result.action)}>{codeLabel(t, ACTION, result.action)}</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {!result && <p className="text-sm text-muted-foreground">{t('aiAgent.playground.result.empty')}</p>}
                {result && (
                  <>
                    <div className="rounded-xl bg-background border p-4">
                      <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                        <Bot className="h-3.5 w-3.5" /> {settings?.agent_name || t('aiAgent.playground.result.assistant')}
                      </div>
                      <p className="text-sm whitespace-pre-wrap">
                        {result.answer || result.fallbackMessage}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md border p-2">
                        <p className="text-muted-foreground">{t('aiAgent.playground.result.confidence')}</p>
                        <p className="font-mono">{t('aiAgent.playground.format.percent', { value: percent(result.confidence) })}</p>
                      </div>
                      <div className="rounded-md border p-2">
                        <p className="text-muted-foreground">{t('aiAgent.playground.result.providerModel')}</p>
                        <p className="font-mono truncate" data-latin-digits="">{result.provider || '—'} / {result.model || '—'}</p>
                      </div>
                    </div>
                    {result.retrievedArticles.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-2">{t('aiAgent.playground.result.sources')}</p>
                        <div className="space-y-1.5">
                          {result.retrievedArticles.map((a) => (
                            <div key={a.id} className="flex items-center justify-between gap-2 text-xs rounded-md border px-2.5 py-1.5">
                              <span className="truncate">{a.title}</span>
                              <Badge variant="secondary" className="shrink-0 text-[10px]">{t('aiAgent.playground.format.scoreBullet', { label: codeLabel(t, KIND, a.kind), value: percent(a.score) })}</Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analysis" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('aiAgent.playground.analysis.title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>{t('aiAgent.playground.analysis.message')}</Label>
                  <Textarea rows={5} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('aiAgent.playground.analysis.placeholder')} />
                </div>
                <p className="text-xs text-muted-foreground">{t('aiAgent.playground.analysis.note')}</p>
                <Button onClick={onDryRun} disabled={dryLoading || !question.trim()} className="w-full">
                  {dryLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <Microscope className="h-3.5 w-3.5 me-1.5" />}
                  {t('aiAgent.playground.analysis.run')}
                </Button>
                {dryError && <p className="text-sm text-destructive">{dryError}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">{t('aiAgent.playground.analysis.resultTitle')}</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {!dryResult && <p className="text-muted-foreground">{t('aiAgent.playground.analysis.empty')}</p>}
                {dryResult && (
                  <>
                    <Section title={t('aiAgent.playground.analysis.detectedLanguage')}>
                      <Badge variant="outline">{codeLabel(t, LANGUAGE, dryResult.language.detected)}</Badge>
                      <span className="text-xs text-muted-foreground ms-2">{t('aiAgent.playground.analysis.languageConfidence', { value: percent(dryResult.language.confidence) })}</span>
                    </Section>
                    <Section title={t('aiAgent.playground.analysis.topics')}>
                      {dryResult.topics.detectedTopics.length === 0 ? (
                        <span className="text-xs text-muted-foreground">{t('aiAgent.playground.analysis.noTopic')}</span>
                      ) : dryResult.topics.detectedTopics.map((topic) => (
                        <Badge key={topic.id} variant="secondary" className="me-1.5 mb-1.5">{t('aiAgent.playground.format.scoreDot', { label: topic.name, value: percent(topic.confidence) })}</Badge>
                      ))}
                    </Section>
                    <Section title={t('aiAgent.playground.analysis.sources')}>
                      {dryResult.selectedSources.length === 0 ? none : (
                        <div className="space-y-1">
                          {dryResult.selectedSources.map((s) => (
                            <div key={s.id} className="flex items-center justify-between text-xs rounded-md border px-2 py-1">
                              <span className="truncate">{s.title}</span>
                              <Badge variant="outline" className="text-[10px]">{t('aiAgent.playground.format.scoreDot', { label: codeLabel(t, KIND, s.kind), value: percent(s.score) })}</Badge>
                            </div>
                          ))}
                        </div>
                      )}
                    </Section>
                    <Section title={t('aiAgent.playground.analysis.strategy')}>
                      <Badge variant="outline" className={actionBadge(dryResult.answerStrategy.action)}>{codeLabel(t, ACTION, dryResult.answerStrategy.action)}</Badge>
                      {dryResult.answerStrategy.reason && <span className="text-xs text-muted-foreground ms-2">{codeLabel(t, REASON, dryResult.answerStrategy.reason)}</span>}
                    </Section>
                    <Section title={t('aiAgent.playground.analysis.routing')}>
                      {dryResult.routingRulesMatched.length === 0 ? none : dryResult.routingRulesMatched.map((r) => (
                        <Badge key={r.id} variant="secondary" className="me-1.5 mb-1.5">
                          {r.action_type ? t('aiAgent.playground.analysis.ruleAction', { name: r.name, action: r.action_type }) : r.name}
                        </Badge>
                      ))}
                    </Section>
                    <Section title={t('aiAgent.playground.analysis.workflows')}>
                      {dryResult.workflowMatches.length === 0 ? none :
                        dryResult.workflowMatches.map((w) => <Badge key={w.id} variant="secondary" className="me-1.5">{w.name}</Badge>)}
                    </Section>
                    <Section title={t('aiAgent.playground.analysis.triggers')}>
                      {dryResult.messageTriggersMatched.length === 0 ? none :
                        dryResult.messageTriggersMatched.map((trigger) => <Badge key={trigger.id} variant="secondary" className="me-1.5">{trigger.name}</Badge>)}
                    </Section>
                    {dryResult.warnings.length > 0 && (
                      <Section title={t('aiAgent.playground.analysis.warnings')}>
                        {dryResult.warnings.map((w) => {
                          const key = keyFor(WARNING, w.code);
                          return <p key={w.code} className="text-xs text-amber-700 dark:text-amber-300">{key ? t(key) : w.message}</p>;
                        })}
                      </Section>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      {/* No letter-spacing on Persian: it pulls joined letters apart. */}
      <p className="text-[11px] uppercase tracking-wide rtl:tracking-normal text-muted-foreground font-medium mb-1.5">{title}</p>
      <div>{children}</div>
    </div>
  );
}
