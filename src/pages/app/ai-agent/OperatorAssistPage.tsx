import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, TrendingUp, ThumbsUp, ThumbsDown, MessageSquare, ArrowUpRight } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';

export default function OperatorAssistPage() {
  const { workspace } = useActiveWorkspace();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const { data, isLoading } = useAiAgentSettings(wsId);
  const update = useUpdateAiAgentSettings(wsId);
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string) => {
    const v = t(`aiAgent.operatorAssist.${k}` as any);
    return !v || v === `aiAgent.operatorAssist.${k}` ? fb : v;
  };

  const [enabled, setEnabled] = useState(false);
  const [allowInsert, setAllowInsert] = useState(true);
  const [allowRegen, setAllowRegen] = useState(true);
  const [showSources, setShowSources] = useState(true);

  useEffect(() => {
    const s = data?.settings as any;
    if (!s) return;
    setEnabled(s.mode === 'suggest_only' || s.allow_suggestions_after_takeover === true || s.show_sources_to_operator === true);
    setAllowInsert(true);
    setAllowRegen(true);
    setShowSources(!!s.show_sources_to_operator);
  }, [data]);

  const analytics = useQuery({
    queryKey: ['assist-analytics', wsId],
    queryFn: () => aiAgentApi.getAssistAnalytics(wsId!, '7d'),
    enabled: !!wsId,
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const onSave = async () => {
    try {
      await update.mutateAsync({
        show_sources_to_operator: showSources,
        allow_suggestions_after_takeover: enabled,
      } as any);
      toast.success(tr('saved', 'Operator Assist saved'));
    } catch (e: any) {
      toast.error(e?.message || tr('saveFailed', 'Save failed'));
    }
  };

  const sum = analytics.data?.summary;

  return (
    <div className="space-y-8" dir={dir}>
      <AiPageHeader icon={Sparkles} accent="amber" title={tr('title', 'Operator Assist')} subtitle={tr('subtitle', 'Help your operators reply faster with AI suggestions.')} />

      <Card className="overflow-hidden border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-violet-500/10 text-violet-600 ring-violet-500/20">
              <Sparkles className="h-4 w-4" />
            </span>
            {tr('settingsTitle', 'Settings')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Row label={tr('row.enable', 'Enable Operator Assist')} value={enabled} onChange={setEnabled} />
          <Row label={tr('row.insert', 'Allow agents to insert suggestions')} value={allowInsert} onChange={setAllowInsert} />
          <Row label={tr('row.regen', 'Allow agents to regenerate suggestions')} value={allowRegen} onChange={setAllowRegen} />
          <Row label={tr('row.sources', 'Show source used for suggestion')} value={showSources} onChange={setShowSources} />
          <div className="flex justify-end pt-3">
            <Button onClick={onSave} disabled={update.isPending} size="lg" className="shadow-lg shadow-primary/20">
              {update.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}{tr('save', 'Save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/60">
        <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2.5">
              <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-emerald-500/10 text-emerald-600 ring-emerald-500/20">
                <TrendingUp className="h-4 w-4" />
              </span>
              {tr('usageTitle', 'Recent usage (7 days)')}
            </CardTitle>
            <CardDescription>{tr('usageDesc', 'How operators are using AI suggestions.')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/operator-assist-analytics'))} className="shrink-0">
            {tr('viewFullAnalytics', 'View full analytics')}
            <ArrowUpRight className="h-3.5 w-3.5 ms-1.5" />
          </Button>
        </CardHeader>
        <CardContent>
          {analytics.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : sum ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat icon={MessageSquare} tone="bg-primary/10 text-primary ring-primary/20" label={tr('stat.suggestions', 'Suggestions')} value={String(sum.total_suggestions || 0)} />
              <Stat icon={TrendingUp} tone="bg-violet-500/10 text-violet-500 ring-violet-500/20" label={tr('stat.acceptance', 'Acceptance')} value={`${Math.round((sum.acceptance_rate || 0) * 100)}%`} />
              <Stat icon={ThumbsUp} tone="bg-emerald-500/10 text-emerald-500 ring-emerald-500/20" label={tr('stat.positive', 'Positive')} value={String(sum.positive || 0)} />
              <Stat icon={ThumbsDown} tone="bg-rose-500/10 text-rose-500 ring-rose-500/20" label={tr('stat.negative', 'Negative')} value={String(sum.negative || 0)} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">{tr('empty', 'No usage data yet.')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/40 px-4 py-3 hover:border-primary/40 hover:bg-accent/30 transition-colors">
      <Label className="text-sm font-normal">{label}</Label>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: string; icon: any; tone: string }) {
  return (
    <Card className="border-border/60 hover:shadow-md transition-all hover:-translate-y-0.5">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <span className={`h-7 w-7 rounded-lg flex items-center justify-center ring-1 ${tone}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        </div>
        <p className="text-2xl font-bold mt-2 tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}