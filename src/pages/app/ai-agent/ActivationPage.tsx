import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentDiagnostics, useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Check, X, Loader2, AlertTriangle, Info, Power } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import type { AgentMode, AgentSettings, EscalationStyle } from '@/lib/ai-agent-api';

function CheckRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-0">
      <div className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${ok ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}>
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

const MODE_KEYS: Record<AgentMode, string> = {
  off: 'modeOff',
  suggest_only: 'modeSuggestOnly',
  auto_reply_when_offline: 'modeAutoOffline',
  auto_reply_until_human_joins: 'modeAutoUntilHuman',
  auto_reply_always: 'modeAutoAlways',
};

export default function ActivationPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data: diag, isLoading } = useAiAgentDiagnostics(workspace?.id);
  const { data: settingsData } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const settings = settingsData?.settings;

  if (isLoading || !diag || !settings) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const canEnable = diag.checks.ai_provider_configured && diag.checks.module_enabled && (!settings.answer_only_from_kb || diag.checks.has_knowledge);
  const isAutoMode = settings.mode.startsWith('auto_reply_');

  const patch = async (p: Partial<AgentSettings>, successMsg = t('aiAgent.activation.settingsUpdated')) => {
    try {
      await update.mutateAsync(p);
      toast.success(successMsg);
    } catch (e: any) {
      toast.error(e?.message || t('aiAgent.activation.updateFailed'));
    }
  };

  const onToggle = (v: boolean) => {
    if (v && !canEnable) {
      toast.error(t('aiAgent.activation.resolveChecklist'));
      return;
    }
    patch({ enabled: v }, v ? t('aiAgent.activation.enabled') : t('aiAgent.activation.disabledToast'));
  };

  const availability = diag.operator_availability;
  const limits = diag.reply_limits;

  return (
    <div className="space-y-6 animate-fade-in">
      <AiPageHeader
        icon={Power}
        accent="emerald"
        title={t('aiAgent.activation.title')}
        subtitle={t('aiAgent.activation.subtitle')}
        meta={
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${settings.enabled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${settings.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/50'}`} />
            {settings.enabled ? t('aiAgent.activation.active') : t('aiAgent.activation.disabled')}
          </span>
        }
        actions={
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/70 px-4 py-2.5 backdrop-blur-sm">
            <div className="text-end">
              <p className="text-xs text-muted-foreground">{t('aiAgent.activation.modeLabel')}</p>
              <p className="text-[13px] font-semibold">{t(`aiAgent.activation.${MODE_KEYS[settings.mode]}` as any)}</p>
            </div>
            <Switch checked={settings.enabled} onCheckedChange={onToggle} disabled={update.isPending} />
          </div>
        }
      />

      {/* Mode */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.replyMode')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Label>{t('aiAgent.activation.modeLabel')}</Label>
          <Select value={settings.mode} onValueChange={(m) => patch({ mode: m as AgentMode }, t('aiAgent.activation.modeUpdated'))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(MODE_KEYS) as AgentMode[]).map((m) => (
                <SelectItem key={m} value={m}>{t(`aiAgent.activation.${MODE_KEYS[m]}` as any)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('aiAgent.activation.modeHint')}</p>

          {settings.mode === 'auto_reply_always' && (
            <div className="flex items-start gap-2.5 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <p><strong>{t('aiAgent.activation.advancedLabel')}</strong> {t('aiAgent.activation.advancedWarning')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Intro — lives in the Settings tab now, which supports per-language
          text. Kept as a pointer here to avoid two conflicting editors for
          the same setting. */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.introTitle')}</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t('aiAgent.activation.introPointerPrefix')} <strong>{t('aiAgent.activation.introPointerTab')}</strong> {t('aiAgent.activation.introPointerSuffix')}
          </p>
        </CardContent>
      </Card>

      {/* Fallback & handoff */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.fallbackTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('aiAgent.activation.fallbackLabel')}</Label>
            <Select
              value={settings.fallback_behavior || 'handoff'}
              onValueChange={(v) => patch({ fallback_behavior: v as 'handoff' | 'silent' })}
            >
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="handoff">{t('aiAgent.activation.fallbackHandoff')}</SelectItem>
                <SelectItem value="silent">{t('aiAgent.activation.fallbackSilent')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('aiAgent.activation.stopOnHandoff')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.stopOnHandoffHint')}</p>
            </div>
            <Switch
              checked={settings.stop_on_handoff !== false}
              onCheckedChange={(v) => patch({ stop_on_handoff: v })}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Automated inbox & takeover safety */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.safetyTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('aiAgent.activation.keepAutomated')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.keepAutomatedHint')}</p>
            </div>
            <Switch
              checked={(settings as any).keep_in_automated_until_handoff !== false}
              onCheckedChange={(v) => patch({ keep_in_automated_until_handoff: v } as any)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('aiAgent.activation.stopAfterHuman')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.stopAfterHumanHint')}</p>
            </div>
            <Switch
              checked={(settings as any).pause_auto_reply_after_human_reply !== false}
              onCheckedChange={(v) => patch({ pause_auto_reply_after_human_reply: v } as any)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('aiAgent.activation.allowSuggestions')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.allowSuggestionsHint')}</p>
            </div>
            <Switch
              checked={(settings as any).allow_suggestions_after_takeover !== false}
              onCheckedChange={(v) => patch({ allow_suggestions_after_takeover: v } as any)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Automated inbox snapshot */}
      {(diag as any).automated_inbox && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.snapshotTitle')}</CardTitle></CardHeader>
          <CardContent className="text-sm grid grid-cols-3 gap-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">{t('aiAgent.activation.aiManaged')}</div>
              <div className="text-xl font-semibold">{(diag as any).automated_inbox.ai_managed}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">{t('aiAgent.activation.needsHuman')}</div>
              <div className="text-xl font-semibold">{(diag as any).automated_inbox.needs_human}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">{t('aiAgent.activation.humanActive')}</div>
              <div className="text-xl font-semibold">{(diag as any).automated_inbox.human_active}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Limits */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.limitsTitle')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="max_conv">{t('aiAgent.activation.maxPerConversation')}</Label>
            <Input
              id="max_conv"
              type="number"
              min={0}
              max={100}
              className="mt-1.5"
              defaultValue={settings.max_replies_per_conversation}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n) && n !== settings.max_replies_per_conversation) {
                  patch({ max_replies_per_conversation: n });
                }
              }}
            />
          </div>
          <div>
            <Label htmlFor="max_hour">{t('aiAgent.activation.maxPerHour')}</Label>
            <Input
              id="max_hour"
              type="number"
              min={0}
              max={1000}
              className="mt-1.5"
              defaultValue={settings.max_replies_per_hour}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n) && n !== settings.max_replies_per_hour) {
                  patch({ max_replies_per_hour: n });
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Answer behavior — Phase 4 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('aiAgent.activation.answerBehavior')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('aiAgent.activation.escalationStyle')}</Label>
            <Select
              value={(settings.escalation_style as EscalationStyle) || 'balanced'}
              onValueChange={(v) => patch({ escalation_style: v as EscalationStyle })}
            >
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">{t('aiAgent.activation.escConservative')}</SelectItem>
                <SelectItem value="balanced">{t('aiAgent.activation.escBalanced')}</SelectItem>
                <SelectItem value="helpful_first">{t('aiAgent.activation.escHelpful')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-2">
              {t('aiAgent.activation.escalationHint')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('aiAgent.activation.allowClarifying')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.allowClarifyingHint')}</p>
            </div>
            <Switch
              checked={settings.allow_clarifying_questions !== false}
              onCheckedChange={(v) => patch({ allow_clarifying_questions: v })}
              disabled={update.isPending}
            />
          </div>

          <div>
            <Label htmlFor="max_clar">{t('aiAgent.activation.maxClarifying')}</Label>
            <Input
              id="max_clar"
              type="number"
              min={0}
              max={5}
              className="mt-1.5"
              defaultValue={settings.max_clarification_attempts ?? 1}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n) && n !== (settings.max_clarification_attempts ?? 1)) {
                  patch({ max_clarification_attempts: Math.max(0, Math.min(5, n)) });
                }
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.maxClarifyingHint')}</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('aiAgent.activation.allowCaveat')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.allowCaveatHint')}</p>
            </div>
            <Switch
              checked={settings.allow_answer_with_caveat !== false}
              onCheckedChange={(v) => patch({ allow_answer_with_caveat: v })}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Learning — placeholder, feature ships in Phase 2 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('aiAgent.activation.learningTitle')}</CardTitle>
            <Badge variant="outline" className="text-[10px]">{t('aiAgent.activation.comingSoon')}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t('aiAgent.activation.learningIntro')}
          </p>
          <div className="flex items-center justify-between opacity-70">
            <div>
              <Label>{t('aiAgent.activation.enableLearning')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.enableLearningHint')}</p>
            </div>
            <Switch
              checked={settings.learning_enabled !== false}
              onCheckedChange={(v) => patch({ learning_enabled: v })}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between opacity-70">
            <div>
              <Label>{t('aiAgent.activation.autoCandidates')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.autoCandidatesHint')}</p>
            </div>
            <Switch
              checked={settings.auto_create_learning_candidates !== false}
              onCheckedChange={(v) => patch({ auto_create_learning_candidates: v })}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between opacity-70">
            <div>
              <Label>{t('aiAgent.activation.requireApproval')}</Label>
              <p className="text-xs text-muted-foreground mt-1">{t('aiAgent.activation.requireApprovalHint')}</p>
            </div>
            <Switch
              checked={settings.require_approval_for_learning !== false}
              onCheckedChange={(v) => patch({ require_approval_for_learning: v })}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Checklist */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.checklistTitle')}</CardTitle></CardHeader>
        <CardContent>
          <CheckRow ok={diag.checks.ai_provider_configured} label={t('aiAgent.activation.checkProvider')} hint={diag.provider ? `${diag.provider.name} • ${diag.provider.model}` : t('aiAgent.activation.checkProviderHint')} />
          <CheckRow ok={diag.checks.has_knowledge} label={t('aiAgent.activation.checkKnowledge')} hint={t('aiAgent.activation.checkKnowledgeHint', { published: String(diag.knowledge.published), qna: String(diag.knowledge.qna_count) })} />
          <CheckRow ok={diag.checks.module_enabled} label={t('aiAgent.activation.checkModule')} hint={t('aiAgent.activation.checkModuleHint')} />
          <CheckRow ok={diag.auto_modes_supported !== false} label={t('aiAgent.activation.checkRuntime')} hint={t('aiAgent.activation.checkRuntimeHint')} />
          <CheckRow ok={diag.intro_enabled !== false} label={t('aiAgent.activation.checkIntro')} hint={diag.intro_enabled === false ? t('aiAgent.activation.checkIntroOff') : t('aiAgent.activation.checkIntroOn')} />
        </CardContent>
      </Card>

      {/* Operator availability snapshot */}
      {availability && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.availabilityTitle')}</CardTitle></CardHeader>
          <CardContent className="flex items-center gap-3 text-sm">
            <div className={`h-2.5 w-2.5 rounded-full ${availability.status === 'online' ? 'bg-success' : 'bg-muted-foreground/40'}`} />
            <span className="font-medium">{availability.status === 'online' ? t('aiAgent.activation.statusOnline') : availability.status === 'offline' ? t('aiAgent.activation.statusOffline') : t('aiAgent.activation.statusUnknown')}</span>
            {typeof availability.online_count === 'number' && (
              <span className="text-xs text-muted-foreground">
                {t('aiAgent.activation.onlineCount', { online: String(availability.online_count), total: String(availability.total_count ?? '?') })}
              </span>
            )}
            {isAutoMode && availability.status !== 'online' && settings.mode === 'auto_reply_when_offline' && (
              <Badge variant="secondary" className="ml-auto">{t('aiAgent.activation.aiWillAnswer')}</Badge>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reply limits snapshot */}
      {limits && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.activeLimits')}</CardTitle></CardHeader>
          <CardContent className="text-sm grid grid-cols-2 gap-2">
            <div className="flex justify-between"><span className="text-muted-foreground">{t('aiAgent.activation.perConversation')}</span><span>{limits.per_conversation}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{t('aiAgent.activation.perHour')}</span><span>{limits.per_hour}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{t('aiAgent.activation.fallbackShort')}</span><span>{limits.fallback_behavior === 'silent' ? t('aiAgent.activation.fallbackSilent') : t('aiAgent.activation.fallbackHandoff')}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{t('aiAgent.activation.stopOnHandoffShort')}</span><span>{limits.stop_on_handoff ? t('aiAgent.activation.yes') : t('aiAgent.activation.no')}</span></div>
          </CardContent>
        </Card>
      )}

      {/* Recent runs */}
      {diag.recent_runs && diag.recent_runs.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('aiAgent.activation.recentRuns')}</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {diag.recent_runs.slice(0, 5).map((r) => (
              <div key={r.id} className="flex items-center justify-between py-1 border-b last:border-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{r.run_type || '?'}</Badge>
                  <span className="text-xs text-muted-foreground">{r.mode || ''}</span>
                </div>
                <Badge variant={r.status === 'replied' || r.status === 'suggested' ? 'default' : 'secondary'} className="text-[10px]">{r.status || '?'}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!canEnable && (
        <div className="flex items-start gap-2.5 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p>{t('aiAgent.activation.resolveChecklistAbove')}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        {t('aiAgent.activation.footerNote')}
      </p>
    </div>
  );
}