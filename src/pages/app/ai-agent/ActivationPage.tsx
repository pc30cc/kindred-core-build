import { useState, useEffect } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentDiagnostics, useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Check, X, Loader2, AlertTriangle, Info } from 'lucide-react';
import { toast } from '@/lib/toast';
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

const MODE_LABELS: Record<AgentMode, string> = {
  off: 'Off',
  suggest_only: 'Suggest only — operators see suggestions, no visitor replies',
  auto_reply_when_offline: 'Auto-reply when offline',
  auto_reply_until_human_joins: 'Auto-reply until a human joins',
  auto_reply_always: 'Auto-reply always',
};

export default function ActivationPage() {
  const { workspace } = useActiveWorkspace();
  const { data: diag, isLoading } = useAiAgentDiagnostics(workspace?.id);
  const { data: settingsData } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const settings = settingsData?.settings;

  // Local draft for the intro message textarea so typing isn't blocked by mutation latency.
  const [introDraft, setIntroDraft] = useState<string>('');
  useEffect(() => {
    if (settings) setIntroDraft(settings.intro_message || '');
  }, [settings?.intro_message]);

  if (isLoading || !diag || !settings) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const canEnable = diag.checks.ai_provider_configured && diag.checks.module_enabled && (!settings.answer_only_from_kb || diag.checks.has_knowledge);
  const isAutoMode = settings.mode.startsWith('auto_reply_');

  const patch = async (p: Partial<AgentSettings>, successMsg = 'Settings updated') => {
    try {
      await update.mutateAsync(p);
      toast.success(successMsg);
    } catch (e: any) {
      toast.error(e?.message || 'Update failed');
    }
  };

  const onToggle = (v: boolean) => {
    if (v && !canEnable) {
      toast.error('Resolve the checklist below before enabling.');
      return;
    }
    patch({ enabled: v }, v ? 'AI Agent enabled' : 'AI Agent disabled');
  };

  const availability = diag.operator_availability;
  const limits = diag.reply_limits;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activation</h1>
        <p className="text-sm text-muted-foreground mt-1">Control whether the AI Agent is active and how it replies.</p>
      </div>

      {/* Master toggle */}
      <Card>
        <CardContent className="p-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${settings.enabled ? 'bg-success/15' : 'bg-muted'}`}>
              <div className={`h-2.5 w-2.5 rounded-full ${settings.enabled ? 'bg-success' : 'bg-muted-foreground/40'}`} />
            </div>
            <div>
              <p className="font-semibold">{settings.enabled ? 'AI Agent is active' : 'AI Agent is disabled'}</p>
              <p className="text-xs text-muted-foreground">Mode: <Badge variant="outline" className="text-[10px]">{settings.mode}</Badge></p>
            </div>
          </div>
          <Switch checked={settings.enabled} onCheckedChange={onToggle} disabled={update.isPending} />
        </CardContent>
      </Card>

      {/* Mode */}
      <Card>
        <CardHeader><CardTitle className="text-base">Reply mode</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Label>Mode</Label>
          <Select value={settings.mode} onValueChange={(m) => patch({ mode: m as AgentMode }, 'Mode updated')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(MODE_LABELS) as AgentMode[]).map((m) => (
                <SelectItem key={m} value={m}>{MODE_LABELS[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Auto-reply will only answer from published Knowledge Base / Q&amp;A. If unsure, it hands off to a human.</p>

          {settings.mode === 'auto_reply_always' && (
            <div className="flex items-start gap-2.5 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <p><strong>Advanced:</strong> AI may reply while humans are online. It will still obey limits and handoff rules.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Intro */}
      <Card>
        <CardHeader><CardTitle className="text-base">Pre-chat introduction</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Send AI intro after pre-chat</Label>
              <p className="text-xs text-muted-foreground mt-1">When a visitor finishes pre-chat, the AI sends a single welcome message. Only fires in auto-reply modes.</p>
            </div>
            <Switch
              checked={settings.ai_intro_enabled !== false}
              onCheckedChange={(v) => patch({ ai_intro_enabled: v })}
              disabled={update.isPending}
            />
          </div>
          <div>
            <Label htmlFor="intro_message">Intro message</Label>
            <Textarea
              id="intro_message"
              className="mt-1.5"
              rows={3}
              placeholder="Leave empty to use a default templated greeting in the visitor's language."
              value={introDraft}
              onChange={(e) => setIntroDraft(e.target.value)}
              onBlur={() => {
                if ((settings.intro_message || '') !== introDraft) {
                  patch({ intro_message: introDraft || null });
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Fallback & handoff */}
      <Card>
        <CardHeader><CardTitle className="text-base">Fallback &amp; handoff</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Fallback behavior when AI cannot answer</Label>
            <Select
              value={settings.fallback_behavior || 'handoff'}
              onValueChange={(v) => patch({ fallback_behavior: v as 'handoff' | 'silent' })}
            >
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="handoff">Hand off to a human (recommended)</SelectItem>
                <SelectItem value="silent">Stay silent — operator picks it up</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Stop AI after a handoff</Label>
              <p className="text-xs text-muted-foreground mt-1">Once a human takes over, AI stops auto-replying for the rest of the conversation.</p>
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
        <CardHeader><CardTitle className="text-base">Automated inbox &amp; takeover safety</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Keep AI conversations in Automated inbox until handoff</Label>
              <p className="text-xs text-muted-foreground mt-1">AI-handled conversations show in the Automated inbox until a human takes over or AI hands off.</p>
            </div>
            <Switch
              checked={(settings as any).keep_in_automated_until_handoff !== false}
              onCheckedChange={(v) => patch({ keep_in_automated_until_handoff: v } as any)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Stop AI after a human reply</Label>
              <p className="text-xs text-muted-foreground mt-1">Recommended. Even in <em>Auto-reply always</em>, AI pauses once an operator replies.</p>
            </div>
            <Switch
              checked={(settings as any).pause_auto_reply_after_human_reply !== false}
              onCheckedChange={(v) => patch({ pause_auto_reply_after_human_reply: v } as any)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Allow AI suggestions after human takeover</Label>
              <p className="text-xs text-muted-foreground mt-1">After a human takes over, AI never replies to the visitor — but may still suggest replies for the operator.</p>
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
          <CardHeader><CardTitle className="text-base">Automated inbox snapshot</CardTitle></CardHeader>
          <CardContent className="text-sm grid grid-cols-3 gap-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">AI-managed</div>
              <div className="text-xl font-semibold">{(diag as any).automated_inbox.ai_managed}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Needs human</div>
              <div className="text-xl font-semibold">{(diag as any).automated_inbox.needs_human}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Human active</div>
              <div className="text-xl font-semibold">{(diag as any).automated_inbox.human_active}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Limits */}
      <Card>
        <CardHeader><CardTitle className="text-base">Reply limits</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="max_conv">Max auto replies per conversation</Label>
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
            <Label htmlFor="max_hour">Max replies per hour (workspace)</Label>
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
          <CardTitle className="text-base">Answer behavior</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Escalation style</Label>
            <Select
              value={(settings.escalation_style as EscalationStyle) || 'balanced'}
              onValueChange={(v) => patch({ escalation_style: v as EscalationStyle })}
            >
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">
                  Conservative — only answer when very confident, escalate sooner
                </SelectItem>
                <SelectItem value="balanced">
                  Balanced (recommended) — answer when grounded, ask one clarifying question if vague
                </SelectItem>
                <SelectItem value="helpful_first">
                  Helpful first — try harder before escalating, prefer answering with a hedge over handoff
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-2">
              Controls how quickly the AI escalates to a human. The AI never invents facts — even Helpful first stays grounded in your knowledge base.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Allow clarifying questions</Label>
              <p className="text-xs text-muted-foreground mt-1">When the visitor's question is vague, AI may ask one short clarifying question instead of immediately handing off.</p>
            </div>
            <Switch
              checked={settings.allow_clarifying_questions !== false}
              onCheckedChange={(v) => patch({ allow_clarifying_questions: v })}
              disabled={update.isPending}
            />
          </div>

          <div>
            <Label htmlFor="max_clar">Max clarifying questions per conversation</Label>
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
            <p className="text-xs text-muted-foreground mt-1">After this, AI hands off instead of asking again.</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Allow answers with caveat</Label>
              <p className="text-xs text-muted-foreground mt-1">When the knowledge match is partial, AI may answer with a hedge such as "Based on the information I have…" instead of escalating.</p>
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
            <CardTitle className="text-base">Learning from operator replies</CardTitle>
            <Badge variant="outline" className="text-[10px]">Coming soon</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            When AI cannot answer and an operator replies with the correct answer, the system will create a pending Q&amp;A suggestion for an admin to review. Workspace-isolated and never auto-published. The pipeline is not active yet — these toggles save your preference for when it ships.
          </p>
          <div className="flex items-center justify-between opacity-70">
            <div>
              <Label>Enable learning</Label>
              <p className="text-xs text-muted-foreground mt-1">Allow this workspace to collect learning candidates from real conversations.</p>
            </div>
            <Switch
              checked={settings.learning_enabled !== false}
              onCheckedChange={(v) => patch({ learning_enabled: v })}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between opacity-70">
            <div>
              <Label>Auto-create learning candidates</Label>
              <p className="text-xs text-muted-foreground mt-1">Automatically pair a visitor's unanswered question with the operator's reply and queue it for review.</p>
            </div>
            <Switch
              checked={settings.auto_create_learning_candidates !== false}
              onCheckedChange={(v) => patch({ auto_create_learning_candidates: v })}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-center justify-between opacity-70">
            <div>
              <Label>Require approval before AI uses new knowledge</Label>
              <p className="text-xs text-muted-foreground mt-1">Strongly recommended. AI never uses a candidate until an admin approves it.</p>
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
        <CardHeader><CardTitle className="text-base">Readiness checklist</CardTitle></CardHeader>
        <CardContent>
          <CheckRow ok={diag.checks.ai_provider_configured} label="AI provider configured" hint={diag.provider ? `${diag.provider.name} • ${diag.provider.model}` : 'Set up an AI provider in admin or workspace providers'} />
          <CheckRow ok={diag.checks.has_knowledge} label="Published knowledge available" hint={`${diag.knowledge.published} published articles, ${diag.knowledge.qna_count} Q&A pairs`} />
          <CheckRow ok={diag.checks.module_enabled} label="Module enabled" hint="Plan grants the ai_assistant module" />
          <CheckRow ok={diag.auto_modes_supported !== false} label="Auto-reply runtime supported" hint="Server runtime can deliver auto, suggest, intro and handoff modes" />
          <CheckRow ok={diag.intro_enabled !== false} label="Pre-chat intro enabled" hint={diag.intro_enabled === false ? 'Disabled — visitors will not get an AI greeting' : 'Visitors get a single AI greeting after pre-chat'} />
        </CardContent>
      </Card>

      {/* Operator availability snapshot */}
      {availability && (
        <Card>
          <CardHeader><CardTitle className="text-base">Operator availability</CardTitle></CardHeader>
          <CardContent className="flex items-center gap-3 text-sm">
            <div className={`h-2.5 w-2.5 rounded-full ${availability.status === 'online' ? 'bg-success' : 'bg-muted-foreground/40'}`} />
            <span className="font-medium capitalize">{availability.status || 'unknown'}</span>
            {typeof availability.online_count === 'number' && (
              <span className="text-xs text-muted-foreground">
                {availability.online_count} online / {availability.total_count ?? '?'} total
              </span>
            )}
            {isAutoMode && availability.status !== 'online' && settings.mode === 'auto_reply_when_offline' && (
              <Badge variant="secondary" className="ml-auto">AI will answer now</Badge>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reply limits snapshot */}
      {limits && (
        <Card>
          <CardHeader><CardTitle className="text-base">Active limits</CardTitle></CardHeader>
          <CardContent className="text-sm grid grid-cols-2 gap-2">
            <div className="flex justify-between"><span className="text-muted-foreground">Per conversation</span><span>{limits.per_conversation}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Per hour</span><span>{limits.per_hour}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Fallback</span><span className="capitalize">{limits.fallback_behavior}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Stop on handoff</span><span>{limits.stop_on_handoff ? 'Yes' : 'No'}</span></div>
          </CardContent>
        </Card>
      )}

      {/* Recent runs */}
      {diag.recent_runs && diag.recent_runs.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
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
          <p>Resolve the checklist items above before enabling the AI Agent.</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        AI Agent never replies in <strong>off</strong> mode and only sends suggestions to operators in <strong>suggest only</strong> mode. Visitor-facing replies require an auto mode.
      </p>
    </div>
  );
}