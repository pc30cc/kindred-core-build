import { useState, useEffect, useRef } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Sparkles, Bot, Loader2, Upload, Trash2, Settings as SettingsIcon, User, FileText, Eye, MessageCircle, Languages, Tags, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';

const FALLBACK_INTRO_TEMPLATES: Record<string, (name: string) => string> = {
  en: (name) =>
    `Hi! I'm ${name}, an AI assistant. I can answer questions from our help center. If I'm not sure about something, I'll connect you with a human agent.`,
  fa: (name) =>
    `سلام! من ${name} هستم، یک دستیار هوشمند. می‌توانم به سوالات شما با کمک پایگاه دانش پاسخ بدهم. اگر مطمئن نباشم، شما را به یک کارشناس انسانی وصل می‌کنم.`,
  tr: (name) =>
    `Merhaba! Ben ${name}, bir yapay zeka asistanıyım. Yardım merkezimizden sorularınızı yanıtlayabilirim. Emin olmadığım konularda sizi bir temsilciye bağlarım.`,
};
const FALLBACK_HANDOFF_TEMPLATES: Record<string, string> = {
  fa: 'باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم.',
  tr: 'Tamam — sizi bir temsilciye bağlıyorum.',
  en: "Sure — I'll connect you with a human agent.",
};
const FALLBACK_HANDOFF_PRECHAT_TEMPLATES: Record<string, string> = {
  fa: 'برای اینکه اپراتورهای ما بتوانند بهتر به شما پاسخگو باشند لطفا اطلاعات خودتان را تکمیل کنید.',
  tr: 'Ekibimizin size daha iyi yardımcı olabilmesi için lütfen bilgilerinizi tamamlayın.',
  en: 'So our team can help you faster, please complete your info below.',
};
const LOCALE_LABELS: Record<string, string> = { fa: 'فارسی', en: 'English', tr: 'Türkçe' };
const LOCALE_DIR: Record<string, 'rtl' | 'ltr'> = { fa: 'rtl', en: 'ltr', tr: 'ltr' };

const ENABLE_ERROR_MESSAGES: Record<string, string> = {
  ai_provider_not_configured: 'یک سرویس‌دهنده هوش مصنوعی برای این ورک‌اسپیس تنظیم نشده است.',
  no_published_knowledge: 'برای پاسخ‌دهی فقط از پایگاه دانش، باید حداقل یک مقاله منتشر شده داشته باشید.',
  module_ai_assistant_not_enabled: 'ماژول دستیار هوشمند در پلن فعلی این ورک‌اسپیس فعال نیست.',
  owner_or_admin_required: 'فقط مالک یا ادمین ورک‌اسپیس می‌تواند این تنظیم را تغییر دهد.',
};

export default function AiAgentSettingsPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const { t, dir } = useTranslation();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const activeLocales = allowedLocales.length ? allowedLocales : ['fa', 'en', 'tr'];
  const tr = (k: string, fb: string, vars?: Record<string, string>) => {
    const v = t(`aiAgent.settings.${k}` as any, vars);
    return !v || v === `aiAgent.settings.${k}` ? fb : v;
  };
  const [form, setForm] = useState<any>(null);
  const [generating, setGenerating] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [introDrafts, setIntroDrafts] = useState<Record<string, string>>({ fa: '', en: '', tr: '' });
  const [handoffDrafts, setHandoffDrafts] = useState<Record<string, string>>({ fa: '', en: '', tr: '' });
  const [handoffPrechatDrafts, setHandoffPrechatDrafts] = useState<Record<string, string>>({ fa: '', en: '', tr: '' });
  const [newKeyword, setNewKeyword] = useState('');
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Fields deferred behind the main "Save changes" button (identity, business
  // description, answer behavior, transparency) are only included in the
  // onSave PATCH when the operator actually touched their control this
  // session -- same dirty-tracking discipline as BehaviorPage. allowed_locales
  // and welcome_message have NO editable control on this page at all, so they
  // are never in `dirty` and are never resent (previously they were resent
  // unconditionally from whatever stale value was loaded, silently
  // overwriting e.g. a language choice made on the Behavior page).
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (data?.settings) setForm(data.settings);
    setDirty(new Set());
  }, [data]);
  useEffect(() => {
    const localized = (data?.settings?.intro_message_localized || {}) as Record<string, string>;
    setIntroDrafts({ fa: localized.fa || '', en: localized.en || '', tr: localized.tr || '' });
  }, [data?.settings?.intro_message_localized]);
  useEffect(() => {
    const localized = (data?.settings?.handoff_message_localized || {}) as Record<string, string>;
    setHandoffDrafts({ fa: localized.fa || '', en: localized.en || '', tr: localized.tr || '' });
  }, [data?.settings?.handoff_message_localized]);
  useEffect(() => {
    const localized = (data?.settings?.handoff_prechat_message_localized || {}) as Record<string, string>;
    setHandoffPrechatDrafts({ fa: localized.fa || '', en: localized.en || '', tr: localized.tr || '' });
  }, [data?.settings?.handoff_prechat_message_localized]);

  if (isLoading || !form) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const set = (patch: any) => setForm({ ...form, ...patch });
  // Used by the controls gated behind the deferred "Save changes" button:
  // updates local form state AND marks each touched key dirty so onSave
  // knows to include it. Controls that save immediately (avatar, enabled
  // toggle, intro/handoff drafts, handoff keywords) keep using plain `set`
  // since they never go through the onSave PATCH.
  const setDirtyField = (patch: Record<string, unknown>) => {
    set(patch);
    setDirty((prev) => {
      const next = new Set(prev);
      for (const key of Object.keys(patch)) next.add(key);
      return next;
    });
  };

  // Enable/disable is owned by the Activation page — Settings only shows
  // the resulting status so the owner never has two conflicting switches.
  const toggleIntro = async (v: boolean) => {
    try {
      await update.mutateAsync({ ai_intro_enabled: v });
      set({ ai_intro_enabled: v });
      toast.success(v ? 'ارسال پیام معرفی فعال شد' : 'ارسال پیام معرفی غیرفعال شد');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const saveIntroMessage = async (code: string, value: string) => {
    const current = (form.intro_message_localized || {}) as Record<string, string>;
    if ((current[code] || '') === value) return;
    const next = { ...current, [code]: value };
    try {
      await update.mutateAsync({ intro_message_localized: next });
      set({ intro_message_localized: next });
      toast.success('پیام معرفی ذخیره شد');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const saveHandoffMessage = async (code: string, value: string) => {
    const current = (form.handoff_message_localized || {}) as Record<string, string>;
    if ((current[code] || '') === value) return;
    const next = { ...current, [code]: value };
    try {
      await update.mutateAsync({ handoff_message_localized: next });
      set({ handoff_message_localized: next });
      toast.success('پیام ارجاع به اپراتور ذخیره شد');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const saveHandoffPrechatMessage = async (code: string, value: string) => {
    const current = (form.handoff_prechat_message_localized || {}) as Record<string, string>;
    if ((current[code] || '') === value) return;
    const next = { ...current, [code]: value };
    try {
      await update.mutateAsync({ handoff_prechat_message_localized: next });
      set({ handoff_prechat_message_localized: next });
      toast.success('پیام درخواست اطلاعات ذخیره شد');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const handoffKeywords: string[] = form.handoff_keywords || [];

  const handleAddKeyword = async () => {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    if (handoffKeywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      setKeywordError('این کلمه قبلاً اضافه شده است.');
      return;
    }
    setKeywordError(null);
    const next = [...handoffKeywords, trimmed];
    try {
      await update.mutateAsync({ handoff_keywords: next });
      set({ handoff_keywords: next });
      setNewKeyword('');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const handleRemoveKeyword = async (word: string) => {
    const next = handoffKeywords.filter((k) => k !== word);
    try {
      await update.mutateAsync({ handoff_keywords: next });
      set({ handoff_keywords: next });
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const onSave = async () => {
    // Minimal PATCH: only fields the operator actually touched this session.
    // agent_logo_url is intentionally excluded -- it is already persisted
    // immediately by onAvatarSelected/onRemoveAvatar, so resending it here
    // would only ever be redundant, never necessary. allowed_locales and
    // welcome_message have no control on this page and are therefore never
    // dirty and never sent.
    const patch: Record<string, unknown> = {};
    if (dirty.has('agent_name')) patch.agent_name = form.agent_name;
    if (dirty.has('business_description')) patch.business_description = form.business_description;
    if (dirty.has('answer_guidance')) patch.answer_guidance = form.answer_guidance;
    if (dirty.has('fallback_message')) patch.fallback_message = form.fallback_message;
    if (dirty.has('answer_only_from_kb')) patch.answer_only_from_kb = form.answer_only_from_kb;
    if (dirty.has('show_sources_to_operator')) patch.show_sources_to_operator = form.show_sources_to_operator;
    try {
      await update.mutateAsync(patch);
      setDirty(new Set());
      toast.success(tr('saved', 'Settings saved'));
    } catch (e: any) {
      toast.error(e?.message || tr('saveFailed', 'Save failed'));
    }
  };

  const onGenerate = async () => {
    if (!workspace?.id) return;
    setGenerating(true);
    try {
      const r = await aiAgentApi.generateBusinessDescription(workspace.id);
      setDirtyField({ business_description: r.description });
      toast.success(r.source === 'ai' ? tr('generated', 'Generated') : tr('generatedOffline', 'Generated (offline stub)'));
    } catch (e: any) {
      toast.error(e?.message || tr('generationFailed', 'Generation failed'));
    } finally {
      setGenerating(false);
    }
  };

  const onPickAvatar = () => fileInputRef.current?.click();

  const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !workspace?.id) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      toast.error(tr('uploadOnlyImages', 'Only PNG, JPG, WebP or GIF images are supported'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(tr('uploadTooLarge', 'Image is too large (max 5 MB)'));
      return;
    }
    setUploadingAvatar(true);
    try {
      const r = await aiAgentApi.uploadAvatar(workspace.id, file);
      set({ agent_logo_url: r.avatar_url });
      toast.success(tr('avatarUpdated', 'Avatar updated'));
    } catch (err: any) {
      toast.error(err?.message || tr('uploadFailed', 'Upload failed'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const onRemoveAvatar = async () => {
    if (!workspace?.id) return;
    setUploadingAvatar(true);
    try {
      await aiAgentApi.removeAvatar(workspace.id);
      set({ agent_logo_url: null });
      toast.success(tr('avatarRemoved', 'Avatar removed'));
    } catch (err: any) {
      toast.error(err?.message || tr('removeFailed', 'Remove failed'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in" dir={dir}>
      <AiPageHeader
        icon={SettingsIcon}
        accent="rose"
        title={tr('title', 'Agent Settings')}
        subtitle={tr('subtitle', 'Configure how the AI agent presents itself and answers visitors.')}
        meta={
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${form.enabled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${form.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/50'}`} />
            {form.enabled ? t('aiAgent.activation.active') : t('aiAgent.activation.disabled')}
          </span>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-violet-500/10 text-violet-600 ring-violet-500/20">
                  <User className="h-4 w-4" />
                </span>
                {tr('identity', 'Identity')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>{tr('avatar', 'Avatar')}</Label>
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden border">
                    {form.agent_logo_url
                      ? <img src={form.agent_logo_url} alt="" className="h-full w-full object-cover" />
                      : <Bot className="h-7 w-7 text-primary" />}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={onPickAvatar} disabled={uploadingAvatar}>
                      {uploadingAvatar ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <Upload className="h-3.5 w-3.5 me-1.5" />}
                      {form.agent_logo_url ? tr('change', 'Change') : tr('upload', 'Upload')}
                    </Button>
                    {form.agent_logo_url && (
                      <Button size="sm" variant="ghost" onClick={onRemoveAvatar} disabled={uploadingAvatar}>
                        <Trash2 className="h-3.5 w-3.5 me-1.5" /> {tr('remove', 'Remove')}
                      </Button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={onAvatarSelected}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{tr('avatarHint', 'PNG, JPG, WebP or GIF. Max 5 MB.')}</p>
              </div>
              <div>
                <Label>{tr('agentName', 'Agent name')}</Label>
                <Input value={form.agent_name} onChange={(e) => setDirtyField({ agent_name: e.target.value })} />
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2.5">
                  <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-sky-500/10 text-sky-600 ring-sky-500/20">
                    <FileText className="h-4 w-4" />
                  </span>
                  {tr('businessDesc', 'Business description')}
                </CardTitle>
                <Button size="sm" variant="outline" onClick={onGenerate} disabled={generating}>
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  <span className="ms-1.5">{tr('generate', 'Generate with AI')}</span>
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={6}
                maxLength={2000}
                placeholder={tr('bizPlaceholder', 'Describe what your business does and how it helps customers.')}
                value={form.business_description || ''}
                onChange={(e) => setDirtyField({ business_description: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-2">{(form.business_description?.length || 0)}/2000</p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-emerald-500/10 text-emerald-600 ring-emerald-500/20">
                  <MessageCircle className="h-4 w-4" />
                </span>
                {tr('answerBehavior', 'Answer behavior')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>{tr('guidance', 'Answer guidance')}</Label>
                <Select value={form.answer_guidance} onValueChange={(v) => setDirtyField({ answer_guidance: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conservative">{tr('guidanceOpt.conservative', 'Conservative — only when sources are clear')}</SelectItem>
                    <SelectItem value="balanced">{tr('guidanceOpt.balanced', 'Balanced — answer when likely enough')}</SelectItem>
                    <SelectItem value="creative">{tr('guidanceOpt.creative', 'Creative — more flexible')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/40 p-3 hover:border-primary/40 hover:bg-accent/30 transition-colors">
                <div>
                  <p className="text-sm font-medium">{tr('onlyKbTitle', 'Answer only from Knowledge Base')}</p>
                  <p className="text-xs text-muted-foreground">{tr('onlyKbDesc', 'Recommended. Hands off when no match is found.')}</p>
                </div>
                <Switch checked={form.answer_only_from_kb} onCheckedChange={(v) => setDirtyField({ answer_only_from_kb: v })} />
              </div>
              <div>
                <Label>{tr('fallback', 'Fallback message')}</Label>
                <Input value={form.fallback_message} onChange={(e) => setDirtyField({ fallback_message: e.target.value })} />
              </div>
            </CardContent>
          </Card>

          {/* Pre-chat introduction — the AI's welcome message. Single source
              of truth for what used to be two separate settings: this
              replaces the legacy plain "Welcome message" field above with a
              per-language editor (collapses to one field on a
              single-language platform). */}
          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2.5">
                  <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-sky-500/10 text-sky-600 ring-sky-500/20">
                    <Languages className="h-4 w-4" />
                  </span>
                  پیام معرفی (خوش‌آمدگویی)
                </CardTitle>
                <Switch checked={form.ai_intro_enabled !== false} onCheckedChange={toggleIntro} disabled={update.isPending} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground -mt-2">
                وقتی ویزیتور پیش‌گفتگو را کامل کرد، هوش مصنوعی این پیام را می‌فرستد. فقط در حالت‌های پاسخ خودکار فعال است.
              </p>
              {activeLocales.map((code) => (
                <div key={code}>
                  {canSwitchLanguage && <Label htmlFor={`intro-${code}`}>{LOCALE_LABELS[code] || code}</Label>}
                  <Textarea
                    id={`intro-${code}`}
                    className={canSwitchLanguage ? 'mt-1.5' : ''}
                    rows={3}
                    dir={LOCALE_DIR[code] || 'ltr'}
                    placeholder={(FALLBACK_INTRO_TEMPLATES[code] || FALLBACK_INTRO_TEMPLATES.en)(form.agent_name || 'AI Assistant')}
                    value={introDrafts[code] ?? ''}
                    onChange={(e) => setIntroDrafts((d) => ({ ...d, [code]: e.target.value }))}
                    onBlur={(e) => saveIntroMessage(code, e.target.value)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Handoff acknowledgement — the message the AI sends right when it
              connects the visitor to a human ("Sure — I'll connect you with
              a human agent now."). Same per-locale editor pattern as the
              intro card above; falls back to the built-in template text
              when a locale is left blank. */}
          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-violet-500/10 text-violet-600 ring-violet-500/20">
                  <MessageCircle className="h-4 w-4" />
                </span>
                پیام ارجاع به اپراتور
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground -mt-2">
                وقتی هوش مصنوعی گفتگو را به یک کارشناس انسانی ارجاع می‌دهد، این پیام را می‌فرستد.
              </p>
              {activeLocales.map((code) => (
                <div key={code}>
                  {canSwitchLanguage && <Label htmlFor={`handoff-${code}`}>{LOCALE_LABELS[code] || code}</Label>}
                  <Textarea
                    id={`handoff-${code}`}
                    className={canSwitchLanguage ? 'mt-1.5' : ''}
                    rows={2}
                    dir={LOCALE_DIR[code] || 'ltr'}
                    placeholder={FALLBACK_HANDOFF_TEMPLATES[code] || FALLBACK_HANDOFF_TEMPLATES.en}
                    value={handoffDrafts[code] ?? ''}
                    onChange={(e) => setHandoffDrafts((d) => ({ ...d, [code]: e.target.value }))}
                    onBlur={(e) => saveHandoffMessage(code, e.target.value)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Handoff pre-chat prompt — the line shown above the inline
              name/email/phone fields when the AI hands off mid-thread
              ("so our team can help you faster, please complete your
              info"). Distinct from the intro/handoff-ack cards above:
              this is a label on a form, not something the AI "says". */}
          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-emerald-500/10 text-emerald-600 ring-emerald-500/20">
                  <User className="h-4 w-4" />
                </span>
                پیام درخواست اطلاعات (هنگام ارجاع)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground -mt-2">
                وقتی هوش مصنوعی گفتگو را به اپراتور ارجاع می‌دهد و فیلدهای نام/ایمیل/تلفن داخل همان چت نمایش داده می‌شوند، این متن بالای آن‌ها نشان داده می‌شود.
              </p>
              {activeLocales.map((code) => (
                <div key={code}>
                  {canSwitchLanguage && <Label htmlFor={`handoff-prechat-${code}`}>{LOCALE_LABELS[code] || code}</Label>}
                  <Textarea
                    id={`handoff-prechat-${code}`}
                    className={canSwitchLanguage ? 'mt-1.5' : ''}
                    rows={2}
                    dir={LOCALE_DIR[code] || 'ltr'}
                    placeholder={FALLBACK_HANDOFF_PRECHAT_TEMPLATES[code] || FALLBACK_HANDOFF_PRECHAT_TEMPLATES.en}
                    value={handoffPrechatDrafts[code] ?? ''}
                    onChange={(e) => setHandoffPrechatDrafts((d) => ({ ...d, [code]: e.target.value }))}
                    onBlur={(e) => saveHandoffPrechatMessage(code, e.target.value)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-amber-500/10 text-amber-600 ring-amber-500/20">
                  <Tags className="h-4 w-4" />
                </span>
                کلمات کلیدی ارجاع به انسان
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground -mt-2">
                وقتی ویزیتور یکی از این کلمات را در پیام خود بنویسد (مثلاً «اپراتور» یا «انسان»)، گفتگو به یک کارشناس واقعی ارجاع داده می‌شود.
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="مثلاً: پشتیبان"
                  value={newKeyword}
                  onChange={(e) => { setNewKeyword(e.target.value); setKeywordError(null); }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddKeyword())}
                />
                <Button onClick={handleAddKeyword} variant="outline" size="sm" className="shrink-0" disabled={update.isPending}>
                  افزودن
                </Button>
              </div>
              {keywordError && <p className="text-xs text-destructive">{keywordError}</p>}
              <div className="flex flex-wrap gap-2">
                {handoffKeywords.map((word) => (
                  <div key={word} className="flex items-center gap-1.5 bg-muted/50 rounded-full ps-3 pe-1.5 py-1 border border-border text-sm">
                    <span>{word}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveKeyword(word)}
                      className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-destructive/15 hover:text-destructive transition-colors"
                      aria-label="حذف"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {handoffKeywords.length === 0 && (
                  <p className="text-xs text-muted-foreground">هنوز کلمه‌ای اضافه نشده است.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-amber-500/10 text-amber-600 ring-amber-500/20">
                  <Eye className="h-4 w-4" />
                </span>
                {tr('transparency', 'Operator transparency')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between rounded-lg border border-border/40 p-3 hover:border-primary/40 hover:bg-accent/30 transition-colors">
                <div>
                  <p className="text-sm font-medium">{tr('sourcesTitle', 'Show sources to operators')}</p>
                  <p className="text-xs text-muted-foreground">{tr('sourcesDesc', 'Operators can see which knowledge source helped create a suggestion.')}</p>
                </div>
                <Switch checked={!!form.show_sources_to_operator} onCheckedChange={(v) => setDirtyField({ show_sources_to_operator: v })} />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={onSave} disabled={update.isPending} size="lg" className="shadow-lg shadow-primary/20">
              {update.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />}
              {tr('save', 'Save changes')}
            </Button>
          </div>
        </div>

        <div>
          <Card className="sticky top-6 bg-gradient-to-br from-primary/5 to-primary/0 border-primary/20">
            <CardHeader className="pb-3"><CardTitle className="text-base">{tr('preview', 'Live preview')}</CardTitle></CardHeader>
            <CardContent>
              <div className="rounded-xl bg-background border border-border/60 shadow-sm p-4 space-y-3">
                <div className="flex items-center gap-2.5 pb-3 border-b">
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {form.agent_logo_url ? <img src={form.agent_logo_url} alt="" className="h-full w-full object-cover" /> : <Bot className="h-4 w-4 text-primary" />}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{form.agent_name}</p>
                    <p className="text-[11px] text-success">● {tr('online', 'Online')}</p>
                  </div>
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 text-sm max-w-[85%]">
                  {introDrafts[activeLocales[0]]
                    || (FALLBACK_INTRO_TEMPLATES[activeLocales[0]] || FALLBACK_INTRO_TEMPLATES.en)(form.agent_name || 'AI Assistant')}
                </div>
                <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-3 py-2 text-sm max-w-[85%] ms-auto">
                  {tr('sampleVisitor', 'How do I get started?')}
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 text-sm max-w-[85%]">
                  {tr('sampleAi', 'Sure — let me check our knowledge base for you.')}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}