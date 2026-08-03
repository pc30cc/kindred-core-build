import { useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Beaker, Loader2 } from 'lucide-react';
import { useTranslation } from '@/i18n';

const BUCKET_TONE: Record<string, string> = {
  high: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  medium: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  low: 'bg-muted text-muted-foreground',
};

type TestAiResult = Awaited<ReturnType<typeof aiAgentApi.testAi>>;

export default function TestAiPanel() {
  const { workspace } = useActiveWorkspace();
  const { t, dir } = useTranslation();
  const tt = (k: string, fb: string) => {
    const v = t(`aiAgent.test.${k}` as any);
    return !v || v === `aiAgent.test.${k}` ? fb : v;
  };
  const [message, setMessage] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestAiResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onTest = async () => {
    if (!workspace?.id || !message.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await aiAgentApi.testAi({
        workspaceId: workspace.id,
        message: message.trim(),
        pageContext: pageUrl.trim() ? { currentPageUrl: pageUrl.trim() } : null,
      });
      setResult(r);
    } catch (e: any) {
      const raw = String(e?.message || '');
      const code = (raw.match(/test_ai_rate_limited|test_ai_failed|invalid_params/) || [])[0];
      const localized = code ? tt(`error.${code}`, '') : '';
      setError(localized || tt('error.default', tt('failed', 'Test failed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card dir={dir}>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Beaker className="h-4 w-4 text-primary" /> {tt('title', 'Test the AI Agent')}</CardTitle>
        <CardDescription>{tt('desc', 'Send a sample visitor message and see exactly what the AI would do.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea placeholder={tt('messagePlaceholder', 'Type a visitor message...')} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
        <Input placeholder={tt('urlPlaceholder', 'Page URL (optional)')} value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} dir="ltr" />
        <div className="flex justify-end">
          <Button onClick={onTest} disabled={loading || !message.trim()}>
            {loading && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            {loading ? tt('running', 'Testing...') : tt('run', 'Run test')}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {result && (
          <div className="rounded-md border p-3 space-y-2 bg-muted/30">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{tt(`action.${result.action}`, result.action)}</Badge>
              <Badge variant="outline" className={BUCKET_TONE[result.confidence_bucket]}>
                {tt('confidence', 'Confidence')}: {tt(`bucket.${result.confidence_bucket}`, result.confidence_bucket)}
              </Badge>
            </div>
            {result.answer && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tt('previewAnswer', 'Preview answer')}</p>
                <p className="text-sm whitespace-pre-wrap">{result.answer}</p>
              </div>
            )}
            {!result.answer && result.action !== 'answer' && (
              <p className="text-xs text-muted-foreground">
                {tt(`reason.${result.action}`, tt('reason.default', result.reason))}
              </p>
            )}
            {result.sources?.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tt('sourcesUsed', 'Sources used')}</p>
                <ul className="text-sm list-disc ps-5 space-y-0.5">
                  {result.sources.map((a, i) => (
                    <li key={i}>{a.title}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.sources_hidden && (
              <p className="text-[11px] text-muted-foreground">{tt('sourcesHidden', 'The source list is hidden by your settings.')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}