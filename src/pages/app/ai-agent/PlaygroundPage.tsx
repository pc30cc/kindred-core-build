import { useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings } from '@/hooks/useAiAgent';
import { aiAgentApi, type PlaygroundResult, type TestRunResult } from '@/lib/ai-agent-api';
import { useI18n } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Beaker, Loader2, AlertTriangle, Bot, ArrowRight, Microscope } from 'lucide-react';

export default function PlaygroundPage() {
  const { workspace } = useActiveWorkspace();
  const { locale } = useI18n();
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
        locale,
        guidanceOverride: guidance === 'auto' ? undefined : guidance,
        modelOverride: model === 'auto' ? undefined : model,
      });
      setResult(r);
    } catch (e: any) {
      setError(e?.message || 'Test failed');
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
      const r = await aiAgentApi.testRun({ workspaceId: workspace.id, message: question, visitorLocale: locale });
      setDryResult(r);
    } catch (e: any) {
      setDryError(e?.message || 'Test failed');
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

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Beaker className="h-5 w-5 text-primary" /> Playground
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Safely test your AI Agent. Nothing is sent to real conversations and no workflows or tools are executed.</p>
      </div>

      {settings && !settings.enabled && (
        <div className="flex items-start gap-2.5 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p>AI Agent is disabled — this is a safe playground only. Visitors will not see these answers.</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v: any) => setTab(v)}>
        <TabsList>
          <TabsTrigger value="reply"><Bot className="h-3.5 w-3.5 me-1.5" />Full reply</TabsTrigger>
          <TabsTrigger value="analysis"><Microscope className="h-3.5 w-3.5 me-1.5" />Dry-run analysis</TabsTrigger>
        </TabsList>

        <TabsContent value="reply" className="mt-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Test question</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Model</Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Choose automatically</SelectItem>
                    <SelectItem value="gpt-5-nano">gpt-5-nano</SelectItem>
                    <SelectItem value="gpt-5-mini">gpt-5-mini</SelectItem>
                    <SelectItem value="gpt-5">gpt-5</SelectItem>
                    <SelectItem value="gpt-4o-mini">gpt-4o-mini</SelectItem>
                    <SelectItem value="gpt-4o">gpt-4o</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Guidance</Label>
                <Select value={guidance} onValueChange={(v: any) => setGuidance(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Use settings</SelectItem>
                    <SelectItem value="conservative">Conservative</SelectItem>
                    <SelectItem value="balanced">Balanced</SelectItem>
                    <SelectItem value="creative">Creative</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Question</Label>
              <Textarea rows={5} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask something a visitor would ask..." />
            </div>
            <Button onClick={onTest} disabled={loading || !question.trim()} className="w-full">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <ArrowRight className="h-3.5 w-3.5 me-1.5" />}
              Test
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-primary/5 to-primary/0 border-primary/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Result</CardTitle>
              {result && <Badge variant="outline" className={actionBadge(result.action)}>{result.action}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {!result && <p className="text-sm text-muted-foreground">Run a test to see the answer here.</p>}
            {result && (
              <>
                <div className="rounded-xl bg-background border p-4">
                  <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                    <Bot className="h-3.5 w-3.5" /> {settings?.agent_name || 'AI Assistant'}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">
                    {result.answer || result.fallbackMessage}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border p-2">
                    <p className="text-muted-foreground">Confidence</p>
                    <p className="font-mono">{(result.confidence * 100).toFixed(0)}%</p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-muted-foreground">Provider / model</p>
                    <p className="font-mono truncate">{result.provider || '—'} / {result.model || '—'}</p>
                  </div>
                </div>
                {result.retrievedArticles.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Retrieved sources</p>
                    <div className="space-y-1.5">
                      {result.retrievedArticles.map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-2 text-xs rounded-md border px-2.5 py-1.5">
                          <span className="truncate">{a.title}</span>
                          <Badge variant="secondary" className="shrink-0 text-[10px]">{a.kind} • {(a.score * 100).toFixed(0)}%</Badge>
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
                <CardTitle className="text-base">Dry-run input</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Visitor message</Label>
                  <Textarea rows={5} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. قیمت پلن چنده؟" />
                </div>
                <p className="text-xs text-muted-foreground">No real conversation is created. Workflows and tools are not executed.</p>
                <Button onClick={onDryRun} disabled={dryLoading || !question.trim()} className="w-full">
                  {dryLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <Microscope className="h-3.5 w-3.5 me-1.5" />}
                  Analyze
                </Button>
                {dryError && <p className="text-sm text-destructive">{dryError}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Pipeline analysis</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {!dryResult && <p className="text-muted-foreground">Run the analysis to see the pipeline breakdown.</p>}
                {dryResult && (
                  <>
                    <Section title="Detected language">
                      <Badge variant="outline">{dryResult.language.detected}</Badge>
                      <span className="text-xs text-muted-foreground ms-2">confidence {(dryResult.language.confidence * 100).toFixed(0)}%</span>
                    </Section>
                    <Section title="Detected topics">
                      {dryResult.topics.detectedTopics.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No topic matched.</span>
                      ) : dryResult.topics.detectedTopics.map((t) => (
                        <Badge key={t.id} variant="secondary" className="me-1.5 mb-1.5">{t.name} · {(t.confidence * 100).toFixed(0)}%</Badge>
                      ))}
                    </Section>
                    <Section title="Selected sources">
                      {dryResult.selectedSources.length === 0 ? (
                        <span className="text-xs text-muted-foreground">None.</span>
                      ) : (
                        <div className="space-y-1">
                          {dryResult.selectedSources.map((s) => (
                            <div key={s.id} className="flex items-center justify-between text-xs rounded-md border px-2 py-1">
                              <span className="truncate">{s.title}</span>
                              <Badge variant="outline" className="text-[10px]">{s.kind} · {(s.score * 100).toFixed(0)}%</Badge>
                            </div>
                          ))}
                        </div>
                      )}
                    </Section>
                    <Section title="Answer strategy">
                      <Badge variant="outline" className={actionBadge(dryResult.answerStrategy.action)}>{dryResult.answerStrategy.action}</Badge>
                      {dryResult.answerStrategy.reason && <span className="text-xs text-muted-foreground ms-2">{dryResult.answerStrategy.reason}</span>}
                    </Section>
                    <Section title="Routing rules matched">
                      {dryResult.routingRulesMatched.length === 0 ? (
                        <span className="text-xs text-muted-foreground">None.</span>
                      ) : dryResult.routingRulesMatched.map((r) => (
                        <Badge key={r.id} variant="secondary" className="me-1.5 mb-1.5">{r.name} → {r.action_type}</Badge>
                      ))}
                    </Section>
                    <Section title="Workflow matches">
                      {dryResult.workflowMatches.length === 0 ? <span className="text-xs text-muted-foreground">None.</span> :
                        dryResult.workflowMatches.map((w) => <Badge key={w.id} variant="secondary" className="me-1.5">{w.name}</Badge>)}
                    </Section>
                    <Section title="Message triggers matched">
                      {dryResult.messageTriggersMatched.length === 0 ? <span className="text-xs text-muted-foreground">None.</span> :
                        dryResult.messageTriggersMatched.map((t) => <Badge key={t.id} variant="secondary" className="me-1.5">{t.name}</Badge>)}
                    </Section>
                    {dryResult.warnings.length > 0 && (
                      <Section title="Warnings">
                        {dryResult.warnings.map((w) => (
                          <p key={w.code} className="text-xs text-amber-700 dark:text-amber-300">{w.message}</p>
                        ))}
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
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">{title}</p>
      <div>{children}</div>
    </div>
  );
}