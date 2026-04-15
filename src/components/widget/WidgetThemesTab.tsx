import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import {
  MessageSquare, MessageCircle, Headphones, HelpCircle, Smile, Zap, Heart, Send,
  Rocket, Sparkles, HandMetal, Bot, ShieldCheck, Phone, Globe, Star, Megaphone, Check, Save, Loader2, X,
} from 'lucide-react';

const COLORS = ['#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#ef4444', '#6366f1'];

function getFabIcons() {
  return [
    { id: 'chat', name: 'Chat', icon: MessageSquare },
    { id: 'message_circle', name: 'Message', icon: MessageCircle },
    { id: 'headset', name: 'Headset', icon: Headphones },
    { id: 'help_circle', name: 'Help', icon: HelpCircle },
    { id: 'smile', name: 'Smile', icon: Smile },
    { id: 'zap', name: 'Zap', icon: Zap },
    { id: 'heart', name: 'Heart', icon: Heart },
    { id: 'send', name: 'Send', icon: Send },
    { id: 'hand_wave', name: 'Hand', icon: HandMetal },
    { id: 'rocket', name: 'Rocket', icon: Rocket },
    { id: 'sparkles', name: 'Sparkles', icon: Sparkles },
    { id: 'bot', name: 'Bot', icon: Bot },
    { id: 'shield', name: 'Shield', icon: ShieldCheck },
    { id: 'phone', name: 'Phone', icon: Phone },
    { id: 'globe', name: 'Globe', icon: Globe },
    { id: 'star', name: 'Star', icon: Star },
    { id: 'megaphone', name: 'Megaphone', icon: Megaphone },
  ];
}

function getThemes() {
  return [
    { id: 'modern', name: 'Modern', desc: 'Dark & sleek', style: 'dark', fabShape: 'rounded-lg', chatBg: '#0f1420', msgBg: '#1e2538', inputBg: '#1a2030', inspiration: 'Intercom' },
    { id: 'minimal', name: 'Minimal', desc: 'Clean & light', style: 'light', fabShape: 'circle', chatBg: '#ffffff', msgBg: '#f1f5f9', inputBg: '#f8fafc', inspiration: 'Crisp' },
    { id: 'gradient', name: 'Gradient', desc: 'Bold gradients', style: 'light', fabShape: 'rounded-xl', chatBg: '#ffffff', msgBg: '#f0f4ff', inputBg: '#fafbfc', inspiration: 'Drift' },
    { id: 'bubble', name: 'Bubble', desc: 'Soft & rounded', style: 'dark', fabShape: 'circle', chatBg: '#1a1a2e', msgBg: '#16213e', inputBg: '#0f3460', inspiration: 'Tidio' },
    { id: 'classic', name: 'Classic', desc: 'Timeless design', style: 'light', fabShape: 'rounded-md', chatBg: '#ffffff', msgBg: '#f9fafb', inputBg: '#ffffff', inspiration: 'Zendesk' },
    { id: 'neon', name: 'Neon', desc: 'Neon glow effect', style: 'dark', fabShape: 'rounded-lg', chatBg: '#0a0a0f', msgBg: '#12121c', inputBg: '#0e0e16', inspiration: 'LiveChat' },
    { id: 'glass', name: 'Glass', desc: 'Glassmorphism', style: 'dark', fabShape: 'circle', chatBg: 'rgba(15,20,32,0.92)', msgBg: 'rgba(255,255,255,0.06)', inputBg: 'rgba(255,255,255,0.04)', inspiration: 'Glass' },
    { id: 'flat', name: 'Flat', desc: 'Simple & flat', style: 'light', fabShape: 'rounded-md', chatBg: '#fefefe', msgBg: '#f3f4f6', inputBg: '#f9fafb', inspiration: 'Olark' },
    { id: 'rounded', name: 'Rounded', desc: 'Friendly curves', style: 'light', fabShape: 'circle', chatBg: '#ffffff', msgBg: '#eef2ff', inputBg: '#f8fafc', inspiration: 'Crisp' },
    { id: 'corporate', name: 'Corporate', desc: 'Professional', style: 'dark', fabShape: 'rounded-sm', chatBg: '#111827', msgBg: '#1f2937', inputBg: '#1a2332', inspiration: 'Salesforce' },
  ];
}

type ThemeItem = ReturnType<typeof getThemes>[0];

function ThemeMiniPreview({ theme, color }: { theme: ThemeItem; color: string }) {
  const isDark = theme.style === 'dark';
  return (
    <div className="rounded-lg overflow-hidden" style={{ height: '90px', background: theme.chatBg, border: isDark ? '1px solid #1e2538' : '1px solid #e2e8f0' }}>
      <div className="h-7 flex items-center px-2 gap-1.5" style={{ background: color }}>
        <div className="w-3.5 h-3.5 rounded-full bg-white/30" />
        <div className="flex-1">
          <div className="h-1.5 rounded bg-white/40 max-w-[45px]" />
          <div className="h-1 rounded bg-white/20 max-w-[60px] mt-0.5" />
        </div>
      </div>
      <div className="p-1.5 space-y-1">
        <div className="flex gap-1 items-start">
          <div className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5" style={{ background: color + '30' }} />
          <div className="h-5 rounded-xl flex-1 max-w-[65%]" style={{ background: theme.msgBg }} />
        </div>
        <div className="flex justify-end">
          <div className="h-5 rounded-xl w-[45%]" style={{ background: color }} />
        </div>
        <div className="flex gap-1 items-start">
          <div className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5" style={{ background: color + '30' }} />
          <div className="h-4 rounded-xl flex-1 max-w-[50%]" style={{ background: theme.msgBg }} />
        </div>
      </div>
    </div>
  );
}

export default function WidgetThemesTab() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  const updateWidget = useUpdateWidgetSettings(workspace?.id);

  const FAB_ICONS = getFabIcons();
  const THEMES = getThemes();

  const [localSettings, setLocalSettings] = useState({
    theme: 'modern',
    primary_color: '#3B82F6',
    secondary_color: '#6366f1',
    fab_icon: 'chat',
    fab_shape: 'circle' as string,
    fab_label: '',
    fab_scale: 100,
    fab_icon_color: '#ffffff',
    fab_text_color: '#ffffff',
    fab_animation: true,
    fab_help_icon: 'help_circle',
    fab_chat_label: '',
    fab_help_label: '',
    show_logo: true,
  });

  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (widget) {
      setLocalSettings({
        theme: (widget as any).theme || 'modern',
        primary_color: widget.primary_color || '#3B82F6',
        secondary_color: (widget as any).secondary_color || '#6366f1',
        fab_icon: (widget as any).fab_icon || 'chat',
        fab_shape: (widget as any).fab_shape || 'circle',
        fab_label: (widget as any).fab_label || '',
        fab_scale: (widget as any).fab_scale ?? 100,
        fab_icon_color: (widget as any).fab_icon_color || '#ffffff',
        fab_text_color: (widget as any).fab_text_color || '#ffffff',
        fab_animation: (widget as any).fab_animation !== false,
        fab_help_icon: (widget as any).fab_help_icon || 'help_circle',
        fab_chat_label: (widget as any).fab_chat_label || '',
        fab_help_label: (widget as any).fab_help_label || '',
        show_logo: (widget as any).show_logo !== false,
      });
      setDirty(false);
    }
  }, [widget]);

  const update = (partial: Partial<typeof localSettings>) => {
    setLocalSettings(s => ({ ...s, ...partial }));
    setDirty(true);
  };

  const handleSave = () => {
    updateWidget.mutate(localSettings as any, {
      onSuccess: () => { toast({ title: 'ذخیره شد' }); setDirty(false); },
    });
  };

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;

  const currentFabIcon = FAB_ICONS.find(i => i.id === localSettings.fab_icon)?.icon || MessageSquare;
  const helpFabIcon = FAB_ICONS.find(i => i.id === localSettings.fab_help_icon)?.icon || HelpCircle;
  const currentThemeDef = THEMES.find(t => t.id === localSettings.theme) || THEMES[0];

  return (
    <div className="space-y-6 relative">
      {/* Live Preview - Sticky */}
      <Card className="sticky top-4 z-10 border-primary/30 bg-card/95 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            پیش‌نمایش زنده ویجت
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between gap-4">
            {/* Mini chat panel preview */}
            <div className="flex-1 max-w-[280px]">
              <div className="rounded-xl overflow-hidden border" style={{
                background: currentThemeDef.chatBg,
                borderColor: currentThemeDef.style === 'dark' ? '#1e2538' : '#e2e8f0',
              }}>
                <div className="h-10 flex items-center px-3 gap-2" style={{ background: localSettings.primary_color }}>
                  {localSettings.show_logo && (
                    <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                      <span className="text-white text-[10px] font-bold">W</span>
                    </div>
                  )}
                  <div className="flex-1">
                    <div className="h-2 rounded bg-white/40 max-w-[70px]" />
                    <div className="h-1.5 rounded bg-white/20 max-w-[50px] mt-1" />
                  </div>
                  <div className="w-5 h-5 rounded-full flex items-center justify-center bg-white/10">
                    <X className="w-3 h-3 text-white/60" />
                  </div>
                </div>
                <div className="p-2.5 space-y-1.5">
                  <div className="flex gap-1.5 items-start">
                    <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: localSettings.primary_color + '30' }} />
                    <div className="h-6 rounded-xl flex-1 max-w-[70%]" style={{ background: currentThemeDef.msgBg }} />
                  </div>
                  <div className="flex justify-end">
                    <div className="h-5 rounded-xl w-[50%]" style={{ background: localSettings.primary_color }} />
                  </div>
                </div>
                <div className="h-8 flex items-center px-2.5 gap-2 border-t" style={{
                  background: currentThemeDef.inputBg,
                  borderColor: currentThemeDef.style === 'dark' ? '#ffffff10' : '#e2e8f0',
                }}>
                  <div className="flex-1 h-4 rounded" style={{ background: currentThemeDef.style === 'dark' ? '#ffffff08' : '#00000008' }} />
                  <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: localSettings.primary_color }}>
                    <Send className="w-2.5 h-2.5 text-white" />
                  </div>
                </div>
              </div>
            </div>

            {/* FAB preview */}
            <div className="flex flex-col items-center gap-2">
              <span className="text-[10px] text-muted-foreground">دکمه ویجت</span>
              {localSettings.fab_shape === 'dual' ? (
                <div className="flex items-center gap-0.5">
                  <div className="flex items-center gap-1 px-2.5 py-2 rounded-s-2xl text-white text-[10px] font-semibold" style={{ background: localSettings.primary_color }}>
                    {(() => { const FabIc = currentFabIcon; return <FabIc className="w-3.5 h-3.5" style={{ color: localSettings.fab_icon_color }} />; })()}
                    <span style={{ color: localSettings.fab_text_color }}>{localSettings.fab_chat_label || 'Chat'}</span>
                  </div>
                  <div className="flex items-center gap-1 px-2.5 py-2 rounded-e-2xl text-white text-[10px] font-semibold" style={{ background: localSettings.secondary_color }}>
                    {(() => { const HelpIc = helpFabIcon; return <HelpIc className="w-3.5 h-3.5" style={{ color: localSettings.fab_icon_color }} />; })()}
                    <span style={{ color: localSettings.fab_text_color }}>{localSettings.fab_help_label || 'Help'}</span>
                  </div>
                </div>
              ) : (
                <div
                  className={`flex items-center justify-center shadow-lg ${localSettings.fab_animation ? 'animate-bounce' : ''}`}
                  style={{
                    background: localSettings.primary_color,
                    borderRadius: localSettings.fab_shape === 'circle' ? '50%' : localSettings.fab_shape === 'pill' ? '28px' : '14px',
                    width: localSettings.fab_shape === 'pill' ? 'auto' : `${Math.round(56 * localSettings.fab_scale / 100)}px`,
                    height: `${Math.round(56 * localSettings.fab_scale / 100)}px`,
                    paddingLeft: localSettings.fab_shape === 'pill' ? '14px' : undefined,
                    paddingRight: localSettings.fab_shape === 'pill' ? '18px' : undefined,
                    gap: localSettings.fab_shape === 'pill' ? '6px' : undefined,
                    transform: `scale(${localSettings.fab_scale / 100})`,
                  }}
                >
                  {(() => { const FabIc = currentFabIcon; return <FabIc className="w-6 h-6" style={{ color: localSettings.fab_icon_color }} />; })()}
                  {localSettings.fab_shape === 'pill' && (
                    <span className="text-xs font-semibold whitespace-nowrap" style={{ color: localSettings.fab_text_color }}>
                      {localSettings.fab_label || 'Chat'}
                    </span>
                  )}
                </div>
              )}
              <span className="text-[9px] text-muted-foreground">قالب: {currentThemeDef.name}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Theme Selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">انتخاب قالب ویجت</CardTitle>
          <CardDescription>یکی از قالب‌های حرفه‌ای را انتخاب کنید. رنگ اصلی روی تمام قالب‌ها اعمال می‌شود.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {THEMES.map(theme => {
              const isSelected = localSettings.theme === theme.id;
              const isDark = theme.style === 'dark';
              return (
                <button
                  key={theme.id}
                  onClick={() => {
                    const fabShapeMap: Record<string, string> = {
                      'circle': 'circle', 'rounded-xl': 'square', 'rounded-lg': 'square',
                      'rounded-md': 'square', 'rounded-sm': 'square',
                    };
                    update({ theme: theme.id, fab_shape: fabShapeMap[theme.fabShape] || 'circle' });
                  }}
                  className={`relative group rounded-xl border-2 p-2.5 text-start transition-all duration-200 hover:scale-[1.02] ${
                    isSelected ? 'border-primary ring-2 ring-primary/20 shadow-lg' : 'border-border hover:border-foreground/30'
                  }`}
                  style={{ background: isDark ? '#0f1420' : '#f8fafc' }}
                >
                  <ThemeMiniPreview theme={theme} color={localSettings.primary_color} />
                  <div className="flex items-center justify-between mt-2">
                    <div>
                      <div className={`text-xs font-semibold ${isDark ? 'text-white' : 'text-foreground'}`}>{theme.name}</div>
                      <div className={`text-[10px] ${isDark ? 'text-gray-400' : 'text-muted-foreground'}`}>{theme.desc}</div>
                      <div className={`text-[9px] mt-0.5 ${isDark ? 'text-gray-500' : 'text-muted-foreground/60'}`}>Inspired by {theme.inspiration}</div>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-3 h-3 text-primary-foreground" />
                      </div>
                    )}
                  </div>
                  <div
                    className="absolute -bottom-2 -start-2 w-7 h-7 flex items-center justify-center shadow-md"
                    style={{
                      background: localSettings.primary_color,
                      borderRadius: theme.fabShape === 'circle' ? '50%' : '10px',
                    }}
                  >
                    {(() => { const FabIc = currentFabIcon; return <FabIc className="w-3.5 h-3.5 text-white" />; })()}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* FAB Shape */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">شکل دکمه ویجت</CardTitle>
          <CardDescription>شکل دکمه شناور ویجت چت را انتخاب کنید.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {([
              { id: 'circle', name: 'دایره', radius: '50%', w: '56px', h: '56px' },
              { id: 'square', name: 'مربع', radius: '14px', w: '56px', h: '56px' },
              { id: 'pill', name: 'کپسولی', radius: '28px', w: '140px', h: '48px' },
              { id: 'dual', name: 'دوتایی', radius: '16px', w: 'auto', h: '48px' },
            ] as const).map(shape => {
              const isSelected = localSettings.fab_shape === shape.id;
              const FabIc = currentFabIcon;
              return (
                <button
                  key={shape.id}
                  onClick={() => update({ fab_shape: shape.id })}
                  className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all duration-200 hover:scale-105 ${
                    isSelected ? 'border-primary ring-2 ring-primary/20 bg-primary/10' : 'border-border hover:border-foreground/30 bg-card'
                  }`}
                >
                  {shape.id === 'dual' ? (
                    <div className="flex items-center gap-1">
                      <div className="flex items-center gap-1.5 px-3 py-2 rounded-s-2xl text-white text-xs font-semibold" style={{ background: localSettings.primary_color }}>
                        <FabIc className="w-3.5 h-3.5" />
                        <span className="whitespace-nowrap">{localSettings.fab_chat_label || 'Chat'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-2 rounded-e-2xl text-white text-xs font-semibold" style={{ background: localSettings.secondary_color }}>
                        {(() => { const HelpIc = FAB_ICONS.find(i => i.id === localSettings.fab_help_icon)?.icon || HelpCircle; return <HelpIc className="w-3.5 h-3.5" />; })()}
                        <span className="whitespace-nowrap">{localSettings.fab_help_label || 'Help'}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center shadow-lg" style={{
                      background: localSettings.primary_color, borderRadius: shape.radius,
                      width: shape.w, height: shape.h,
                      gap: shape.id === 'pill' ? '8px' : undefined,
                      paddingLeft: shape.id === 'pill' ? '14px' : undefined,
                      paddingRight: shape.id === 'pill' ? '18px' : undefined,
                    }}>
                      <FabIc className="w-5 h-5 text-white" />
                      {shape.id === 'pill' && <span className="text-white text-xs font-semibold whitespace-nowrap">{localSettings.fab_label || 'Chat'}</span>}
                    </div>
                  )}
                  <span className={`text-xs font-medium ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>{shape.name}</span>
                </button>
              );
            })}
          </div>

          {localSettings.fab_shape === 'pill' && (
            <div className="space-y-2 mt-4">
              <Label>متن دکمه</Label>
              <Input value={localSettings.fab_label} onChange={e => update({ fab_label: e.target.value })} maxLength={20} placeholder="Chat" />
            </div>
          )}
          {localSettings.fab_shape === 'dual' && (
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div className="space-y-2">
                <Label>عنوان دکمه چت</Label>
                <Input value={localSettings.fab_chat_label} onChange={e => update({ fab_chat_label: e.target.value })} maxLength={15} placeholder="Chat" />
              </div>
              <div className="space-y-2">
                <Label>عنوان دکمه راهنما</Label>
                <Input value={localSettings.fab_help_label} onChange={e => update({ fab_help_label: e.target.value })} maxLength={15} placeholder="Help" />
              </div>
            </div>
          )}

          {/* Animation toggle */}
          <div className="flex items-center justify-between mt-4 p-3 rounded-lg bg-muted/50">
            <div>
              <Label>انیمیشن دکمه</Label>
              <p className="text-[11px] text-muted-foreground mt-0.5">حرکت جلب‌توجه هنگام بارگذاری</p>
            </div>
            <Switch checked={localSettings.fab_animation} onCheckedChange={v => update({ fab_animation: v })} />
          </div>

          {/* Scale */}
          <div className="space-y-3 mt-4">
            <div className="flex items-center justify-between">
              <Label>اندازه دکمه</Label>
              <span className="text-sm font-semibold text-primary">{localSettings.fab_scale}%</span>
            </div>
            <div dir="ltr">
              <Slider value={[localSettings.fab_scale]} onValueChange={([v]) => update({ fab_scale: v })} min={60} max={150} step={5} className="w-full" />
            </div>
          </div>

          {/* Icon & Text Color */}
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="space-y-2">
              <Label>رنگ آیکون</Label>
              <div className="flex gap-2 items-center">
                {['#ffffff', '#000000', '#f59e0b', '#ef4444'].map(c => (
                  <button key={c} onClick={() => update({ fab_icon_color: c })}
                    className={`w-7 h-7 rounded-lg border-2 transition-all ${localSettings.fab_icon_color === c ? 'border-foreground scale-110' : 'border-border hover:border-foreground/50'}`}
                    style={{ backgroundColor: c }} />
                ))}
                <Input type="color" value={localSettings.fab_icon_color} onChange={e => update({ fab_icon_color: e.target.value })} className="w-7 h-7 p-0 border-border rounded-lg cursor-pointer" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>رنگ متن</Label>
              <div className="flex gap-2 items-center">
                {['#ffffff', '#000000', '#f59e0b', '#ef4444'].map(c => (
                  <button key={c} onClick={() => update({ fab_text_color: c })}
                    className={`w-7 h-7 rounded-lg border-2 transition-all ${localSettings.fab_text_color === c ? 'border-foreground scale-110' : 'border-border hover:border-foreground/50'}`}
                    style={{ backgroundColor: c }} />
                ))}
                <Input type="color" value={localSettings.fab_text_color} onChange={e => update({ fab_text_color: e.target.value })} className="w-7 h-7 p-0 border-border rounded-lg cursor-pointer" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* FAB Icon */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">آیکون دکمه</CardTitle>
          <CardDescription>آیکون دکمه شناور ویجت را انتخاب کنید.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
            {FAB_ICONS.map(ic => {
              const isSelected = localSettings.fab_icon === ic.id;
              const Icon = ic.icon;
              return (
                <button key={ic.id} onClick={() => update({ fab_icon: ic.id })}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all duration-200 hover:scale-105 ${
                    isSelected ? 'border-primary ring-2 ring-primary/20 bg-primary/10' : 'border-border hover:border-foreground/30 bg-card'
                  }`}>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shadow-md" style={{ background: localSettings.primary_color }}>
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <span className={`text-[10px] font-medium ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>{ic.name}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Colors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">رنگ‌ها</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>رنگ اصلی</Label>
            <div className="flex gap-2 items-center flex-wrap">
              {COLORS.map(c => (
                <button key={c} onClick={() => update({ primary_color: c })}
                  className={`w-8 h-8 rounded-lg border-2 transition-all ${localSettings.primary_color === c ? 'border-foreground scale-110' : 'border-border hover:border-foreground/50'}`}
                  style={{ backgroundColor: c }} />
              ))}
              <Input type="color" value={localSettings.primary_color} onChange={e => update({ primary_color: e.target.value })} className="w-8 h-8 p-0 border-border rounded-lg cursor-pointer" />
            </div>
          </div>
          {localSettings.fab_shape === 'dual' && (
            <div className="space-y-2">
              <Label>رنگ دکمه راهنما</Label>
              <div className="flex gap-2 items-center flex-wrap">
                {COLORS.map(c => (
                  <button key={c} onClick={() => update({ secondary_color: c })}
                    className={`w-8 h-8 rounded-lg border-2 transition-all ${localSettings.secondary_color === c ? 'border-foreground scale-110' : 'border-border hover:border-foreground/50'}`}
                    style={{ backgroundColor: c }} />
                ))}
                <Input type="color" value={localSettings.secondary_color} onChange={e => update({ secondary_color: e.target.value })} className="w-8 h-8 p-0 border-border rounded-lg cursor-pointer" />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">نمایش لوگو</p>
              <p className="text-xs text-muted-foreground">لوگو در هدر ویجت نمایش داده شود</p>
            </div>
            <Switch checked={localSettings.show_logo} onCheckedChange={v => update({ show_logo: v })} />
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      {dirty && (
        <Button onClick={handleSave} disabled={updateWidget.isPending} className="w-full">
          {updateWidget.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span className="ms-2">ذخیره تغییرات</span>
        </Button>
      )}
    </div>
  );
}
