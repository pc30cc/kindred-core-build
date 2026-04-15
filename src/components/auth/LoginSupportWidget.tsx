import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Globe,
  Heart,
  HelpCircle,
  Megaphone,
  MessageCircle,
  Phone,
  Rocket,
  Send,
  ShieldCheck,
  Smile,
  Sparkles,
  SquarePen,
  Hand,
  Headphones,
  Star,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

type LoginSupportWidgetProps = {
  brandLetter: string;
  brandName: string;
  isRtl: boolean;
  locale: string;
};

type ThemeSurface = {
  badgeBackground: string;
  badgeColor: string;
  borderColor: string;
  headerBackground: string;
  hintBackground: string;
  hintColor: string;
  inputBackground: string;
  inputBorderColor: string;
  inputTextColor: string;
  mutedColor: string;
  panelBackground: string;
  panelRadius: string;
  shadow: string;
  textColor: string;
};

const copyByLocale = {
  en: {
    launcher: 'Support chat',
    hint: 'Need help?',
    title: 'Support is here',
    body: 'If you have any questions before signing in, our team is ready to help.',
    status: 'Online now',
    placeholder: 'Type a message…',
  },
  fa: {
    launcher: 'چت پشتیبانی',
    hint: 'نیاز به کمک دارید؟',
    title: 'پشتیبانی در دسترس است',
    body: 'اگر قبل از ورود سوالی دارید، تیم پشتیبانی آماده کمک به شماست.',
    status: 'الان آنلاین هستیم',
    placeholder: 'پیام خود را بنویسید…',
  },
  tr: {
    launcher: 'Destek sohbeti',
    hint: 'Yardıma mı ihtiyacınız var?',
    title: 'Destek burada',
    body: 'Giriş yapmadan önce bir sorunuz varsa ekibimiz size yardımcı olmaya hazır.',
    status: 'Şu an çevrimiçi',
    placeholder: 'Mesajınızı yazın…',
  },
} as const;

const iconMap: Record<string, LucideIcon> = {
  chat: MessageCircle,
  message_circle: SquarePen,
  headset: Headphones,
  help_circle: HelpCircle,
  smile: Smile,
  zap: Zap,
  heart: Heart,
  send: Send,
  hand_wave: Hand,
  rocket: Rocket,
  sparkles: Sparkles,
  bot: Bot,
  shield: ShieldCheck,
  phone: Phone,
  globe: Globe,
  star: Star,
  megaphone: Megaphone,
};

function getThemeSurface(themeId: string, primaryColor: string, secondaryColor: string): ThemeSurface {
  const themes: Record<string, ThemeSurface> = {
    modern: {
      panelBackground: '#0f1420',
      headerBackground: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
      textColor: '#e2e8f0',
      mutedColor: 'rgba(226, 232, 240, 0.78)',
      borderColor: '#1e2538',
      inputBackground: '#1a2030',
      inputBorderColor: '#25314a',
      inputTextColor: '#e2e8f0',
      hintBackground: '#111827',
      hintColor: '#f8fafc',
      badgeBackground: 'rgba(255,255,255,0.08)',
      badgeColor: '#f8fafc',
      panelRadius: '24px',
      shadow: '0 28px 80px rgba(15, 23, 42, 0.36)',
    },
    minimal: {
      panelBackground: '#ffffff',
      headerBackground: primaryColor,
      textColor: '#0f172a',
      mutedColor: '#475569',
      borderColor: '#e2e8f0',
      inputBackground: '#f8fafc',
      inputBorderColor: '#e2e8f0',
      inputTextColor: '#0f172a',
      hintBackground: '#ffffff',
      hintColor: '#0f172a',
      badgeBackground: '#f1f5f9',
      badgeColor: '#0f172a',
      panelRadius: '28px',
      shadow: '0 24px 60px rgba(15, 23, 42, 0.12)',
    },
    gradient: {
      panelBackground: '#ffffff',
      headerBackground: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
      textColor: '#0f172a',
      mutedColor: '#475569',
      borderColor: '#dbeafe',
      inputBackground: '#f8fafc',
      inputBorderColor: '#dbeafe',
      inputTextColor: '#0f172a',
      hintBackground: 'linear-gradient(135deg, rgba(59,130,246,0.12), rgba(99,102,241,0.12))',
      hintColor: '#1e293b',
      badgeBackground: 'rgba(59,130,246,0.1)',
      badgeColor: '#1d4ed8',
      panelRadius: '24px',
      shadow: '0 24px 70px rgba(59, 130, 246, 0.18)',
    },
    bubble: {
      panelBackground: '#1a1a2e',
      headerBackground: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
      textColor: '#e2e8f0',
      mutedColor: 'rgba(226, 232, 240, 0.72)',
      borderColor: '#16213e',
      inputBackground: '#0f3460',
      inputBorderColor: '#1f4f86',
      inputTextColor: '#f8fafc',
      hintBackground: '#16213e',
      hintColor: '#f8fafc',
      badgeBackground: 'rgba(255,255,255,0.08)',
      badgeColor: '#f8fafc',
      panelRadius: '30px',
      shadow: '0 28px 80px rgba(16, 24, 40, 0.38)',
    },
    classic: {
      panelBackground: '#ffffff',
      headerBackground: '#f8fafc',
      textColor: '#0f172a',
      mutedColor: '#64748b',
      borderColor: '#e5e7eb',
      inputBackground: '#ffffff',
      inputBorderColor: '#d1d5db',
      inputTextColor: '#0f172a',
      hintBackground: '#ffffff',
      hintColor: '#0f172a',
      badgeBackground: '#f3f4f6',
      badgeColor: '#111827',
      panelRadius: '14px',
      shadow: '0 18px 50px rgba(15, 23, 42, 0.12)',
    },
    neon: {
      panelBackground: '#0a0a0f',
      headerBackground: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
      textColor: '#e2e8f0',
      mutedColor: 'rgba(226, 232, 240, 0.72)',
      borderColor: '#1a1a2e',
      inputBackground: '#0e0e16',
      inputBorderColor: 'rgba(59,130,246,0.45)',
      inputTextColor: '#f8fafc',
      hintBackground: '#0a0a0f',
      hintColor: '#f8fafc',
      badgeBackground: 'rgba(59,130,246,0.18)',
      badgeColor: '#bfdbfe',
      panelRadius: '20px',
      shadow: `0 0 0 1px rgba(59,130,246,0.18), 0 0 32px rgba(59,130,246,0.28)`,
    },
    glass: {
      panelBackground: 'rgba(15,20,32,0.9)',
      headerBackground: 'rgba(255,255,255,0.06)',
      textColor: '#f8fafc',
      mutedColor: 'rgba(248, 250, 252, 0.72)',
      borderColor: 'rgba(255,255,255,0.12)',
      inputBackground: 'rgba(255,255,255,0.04)',
      inputBorderColor: 'rgba(255,255,255,0.12)',
      inputTextColor: '#f8fafc',
      hintBackground: 'rgba(15,20,32,0.86)',
      hintColor: '#f8fafc',
      badgeBackground: 'rgba(255,255,255,0.08)',
      badgeColor: '#f8fafc',
      panelRadius: '24px',
      shadow: '0 24px 70px rgba(15, 23, 42, 0.32)',
    },
    flat: {
      panelBackground: '#fefefe',
      headerBackground: primaryColor,
      textColor: '#0f172a',
      mutedColor: '#475569',
      borderColor: '#e5e7eb',
      inputBackground: '#f9fafb',
      inputBorderColor: '#e5e7eb',
      inputTextColor: '#0f172a',
      hintBackground: '#ffffff',
      hintColor: '#0f172a',
      badgeBackground: '#f3f4f6',
      badgeColor: '#0f172a',
      panelRadius: '10px',
      shadow: '0 16px 40px rgba(15, 23, 42, 0.08)',
    },
    rounded: {
      panelBackground: '#ffffff',
      headerBackground: primaryColor,
      textColor: '#0f172a',
      mutedColor: '#475569',
      borderColor: '#e2e8f0',
      inputBackground: '#f8fafc',
      inputBorderColor: '#e2e8f0',
      inputTextColor: '#0f172a',
      hintBackground: '#ffffff',
      hintColor: '#0f172a',
      badgeBackground: '#eef2ff',
      badgeColor: '#3730a3',
      panelRadius: '32px',
      shadow: '0 24px 60px rgba(15, 23, 42, 0.12)',
    },
    corporate: {
      panelBackground: '#111827',
      headerBackground: '#1f2937',
      textColor: '#d1d5db',
      mutedColor: '#9ca3af',
      borderColor: '#374151',
      inputBackground: '#1a2332',
      inputBorderColor: '#374151',
      inputTextColor: '#f9fafb',
      hintBackground: '#111827',
      hintColor: '#f9fafb',
      badgeBackground: '#1f2937',
      badgeColor: '#f9fafb',
      panelRadius: '12px',
      shadow: '0 22px 60px rgba(15, 23, 42, 0.28)',
    },
  };

  return themes[themeId] || themes.modern;
}

function getLauncherRadius(shape: string) {
  switch (shape) {
    case 'square':
      return '18px';
    case 'pill':
      return '999px';
    case 'dual':
      return '20px';
    default:
      return '999px';
  }
}

export function LoginSupportWidget({ brandLetter, brandName, isRtl, locale }: LoginSupportWidgetProps) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [widgetData, setWidgetData] = useState<any>(null);
  const [widgetDisabled, setWidgetDisabled] = useState(false);
  const [message, setMessage] = useState('');

  const normalizedLocale = useMemo(() => {
    if (locale.toLowerCase().startsWith('fa')) return 'fa';
    if (locale.toLowerCase().startsWith('tr')) return 'tr';
    return 'en';
  }, [locale]);

  const copy = copyByLocale[normalizedLocale];

  // Fetch widget settings directly from Supabase (no external API dependency)
  useEffect(() => {
    const workspaceId = (window as Window & { __gs_id?: string }).__gs_id;
    if (!workspaceId) return;

    let cancelled = false;

    supabase
      .from('widget_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setWidgetDisabled(true);
          return;
        }
        if (!data.enabled) {
          setWidgetDisabled(true);
          return;
        }
        setWidgetData(data);
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let timeoutId: number | undefined;

    const syncVisibility = () => {
      const existingWidget = document.querySelector('.gs-widget-root');
      const shouldShowFallback = !existingWidget;
      setVisible(shouldShowFallback);
      if (!shouldShowFallback) setOpen(false);
    };

    syncVisibility();
    timeoutId = window.setTimeout(syncVisibility, 1600);

    const observer = new MutationObserver(syncVisibility);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, []);

  const primaryColor = widgetData?.primary_color || '#3B82F6';
  const secondaryColor = widgetData?.secondary_color || '#6366f1';
  const themeId = widgetData?.theme || 'modern';
  const fabShape = widgetData?.fab_shape || 'circle';
  const fabScale = (widgetData?.fab_scale || 100) / 100;
  const fabIconColor = widgetData?.fab_icon_color || '#ffffff';
  const fabTextColor = widgetData?.fab_text_color || '#ffffff';
  const showLogo = widgetData?.show_logo !== false;
  const resolvedBrandName = brandName;
  const resolvedBrandLetter = (resolvedBrandName.charAt(0) || brandLetter).toUpperCase();
  const launcherText = widgetData?.launcher_text || copy.hint;
  const welcomeMessage = widgetData?.welcome_message || copy.title;
  const greetingMessage = widgetData?.greeting_message || copy.body;
  const placeholderText = widgetData?.placeholder_text || copy.placeholder;
  const isLeftPosition = (widgetData?.position || (isRtl ? 'bottom-left' : 'bottom-right')) === 'bottom-left';
  const surface = useMemo(() => getThemeSurface(themeId, primaryColor, secondaryColor), [themeId, primaryColor, secondaryColor]);
  const FabIcon = iconMap[widgetData?.fab_icon || 'chat'] || MessageCircle;
  const HelpIcon = iconMap[widgetData?.fab_help_icon || 'help_circle'] || HelpCircle;

  if (!visible || widgetDisabled) {
    return null;
  }

  return (
    <div
      className={`fixed bottom-6 z-[2147482999] flex max-w-[calc(100vw-1.5rem)] flex-col gap-3 ${isLeftPosition ? 'left-6 items-start' : 'right-6 items-end'}`}
    >
      {open && (
        <div
          className="w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden border backdrop-blur-sm"
          style={{
            background: surface.panelBackground,
            borderColor: surface.borderColor,
            borderRadius: surface.panelRadius,
            boxShadow: surface.shadow,
            color: surface.textColor,
          }}
        >
          <div
            className="flex items-start justify-between gap-3 px-4 py-4"
            style={{ background: surface.headerBackground, color: '#ffffff' }}
          >
            <div className="flex min-w-0 items-center gap-3">
              {showLogo && widgetData?.logo_url ? (
                <img
                  src={widgetData.logo_url}
                  alt={resolvedBrandName}
                  className="h-10 w-10 shrink-0 rounded-2xl object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-black"
                  style={{ background: 'rgba(255,255,255,0.14)', color: '#ffffff' }}
                >
                  {resolvedBrandLetter}
                </div>
              )}

              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{resolvedBrandName}</p>
                <p className="mt-1 text-xs" style={{ color: 'rgba(255,255,255,0.82)' }}>{copy.status}</p>
              </div>
            </div>

            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors"
              style={{ background: 'rgba(255,255,255,0.14)', color: '#ffffff' }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 px-4 py-4">
            <div className="space-y-2">
              <h2 className="text-base font-semibold">{welcomeMessage}</h2>
              <p className="text-sm leading-6" style={{ color: surface.mutedColor }}>{greetingMessage}</p>
            </div>

            <div
              className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium"
              style={{ background: surface.badgeBackground, color: surface.badgeColor }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: primaryColor }} aria-hidden="true" />
              {launcherText}
            </div>

            <div className="flex items-center gap-2 rounded-[20px] border px-2 py-2"
              style={{ background: surface.inputBackground, borderColor: surface.inputBorderColor }}
            >
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={placeholderText}
                aria-label={placeholderText}
                className="h-10 flex-1 bg-transparent px-2 text-sm outline-none placeholder:opacity-70"
                style={{ color: surface.inputTextColor }}
              />
              <button
                type="button"
                aria-label="Send"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full"
                style={{ background: primaryColor, color: fabIconColor }}
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {fabShape === 'dual' ? (
        <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
          <button
            type="button"
            onClick={() => setOpen((c) => !c)}
            className="inline-flex items-center gap-2 px-4 py-3 text-sm font-semibold shadow-2xl transition-transform hover:scale-[1.02]"
            style={{
              background: primaryColor,
              color: fabTextColor,
              borderRadius: getLauncherRadius('dual'),
            }}
          >
            <FabIcon className="h-4 w-4" />
            <span>{widgetData?.fab_chat_label || 'Chat'}</span>
          </button>
          <button
            type="button"
            onClick={() => setOpen((c) => !c)}
            className="inline-flex items-center gap-2 px-4 py-3 text-sm font-semibold shadow-2xl transition-transform hover:scale-[1.02]"
            style={{
              background: secondaryColor,
              color: fabTextColor,
              borderRadius: getLauncherRadius('dual'),
            }}
          >
            <HelpIcon className="h-4 w-4" />
            <span>{widgetData?.fab_help_label || 'Help'}</span>
          </button>
        </div>
      ) : (
        <div className={`flex items-center gap-3 ${isRtl ? 'flex-row-reverse' : ''}`}>
          {!open && fabShape !== 'pill' && (
            <div
              className="hidden rounded-full border px-3 py-2 text-sm font-medium shadow-lg sm:block"
              style={{
                background: surface.hintBackground,
                color: surface.hintColor,
                borderColor: surface.borderColor,
              }}
            >
              {launcherText}
            </div>
          )}

          <button
            type="button"
            aria-label={copy.launcher}
            onClick={() => setOpen((c) => !c)}
            className="inline-flex min-h-14 items-center justify-center gap-2 px-4 shadow-2xl transition-transform hover:scale-[1.03]"
            style={{
              background: primaryColor,
              color: fabShape === 'pill' ? fabTextColor : fabIconColor,
              borderRadius: getLauncherRadius(fabShape),
              transform: `scale(${fabScale})`,
              width: fabShape === 'pill' ? 'auto' : '3.5rem',
              minWidth: '3.5rem',
            }}
          >
            <FabIcon className="h-5 w-5 shrink-0" />
            {fabShape === 'pill' && (
              <span className="text-sm font-semibold" style={{ color: fabTextColor }}>
                {widgetData?.fab_label || launcherText}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
