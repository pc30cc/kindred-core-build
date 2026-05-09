import { useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Beaker, Loader2 } from 'lucide-react';

const BUCKET_TONE: Record<string, string> = {
  high: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  medium: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  low: 'bg-muted text-muted-foreground',
};

function actionLabel(a: string): string {
  if (a === 'answer') return 'AI would answer';
  if (a === 'handoff') return 'AI would transfer to operator';
  if (a === 'no_answer') return 'AI would not answer';
  if (a === 'clarification') return 'AI would ask a clarifying question';
  return a;
}

type TestAiResult = Awaited<ReturnType<typeof aiAgentApi.testAi>>;

export default function TestAiPanel() {
  const { workspace } = useActiveWorkspace();
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
      setError(e?.message || 'Test failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Beaker className="h-4 w-4 text-primary" /> Test AI</CardTitle>
        <CardDescription>Try a visitor message and see what the AI would do. Nothing is sent to visitors.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea placeholder="Type a visitor message..." value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
        <Input placeholder="Optional page URL" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} />
        <div className="flex justify-end">
          <Button onClick={onTest} disabled={loading || !message.trim()}>
            {loading && <Loader2 className="h-4 w-4 me-2 animate-spin" />}Test
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {result && (
          <div className="rounded-md border p-3 space-y-2 bg-muted/30">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{actionLabel(result.action)}</Badge>
              <Badge variant="outline" className={BUCKET_TONE[result.confidence_bucket]}>
                Confidence: {result.confidence_bucket.charAt(0).toUpperCase() + result.confidence_bucket.slice(1)}
              </Badge>
            </div>
            {result.answer && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Preview answer</p>
                <p className="text-sm whitespace-pre-wrap">{result.answer}</p>
              </div>
            )}
            {!result.answer && result.action !== 'answer' && (
              <p className="text-xs text-muted-foreground">{result.reason}</p>
            )}
            {result.sources?.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Sources used</p>
                <ul className="text-sm list-disc pl-5 space-y-0.5">
                  {result.sources.map((a, i) => (
                    <li key={i}>{a.title}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.sources_hidden && (
              <p className="text-[11px] text-muted-foreground">Source list hidden by your settings.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}