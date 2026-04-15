import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { fetchWidgetConfig } from '@/lib/api';

type LoginSupportWidgetProps = {
  brandLetter: string;
  brandName: string;
  isRtl: boolean;
  locale: string;
};

const copyByLocale = {
  en: {
    launcher: 'Support chat',
    hint: 'Need help?',
    title: 'Support is here',
    body: 'If you have any questions before signing in, our team is ready to help.',
    status: 'Online now',
  },
  fa: {
    launcher: 'چت پشتیبانی',
    hint: 'نیاز به کمک دارید؟',
    title: 'پشتیبانی در دسترس است',
    body: 'اگر قبل از ورود سوالی دارید، تیم پشتیبانی آماده کمک به شماست.',
    status: 'الان آنلاین هستیم',
  },
  tr: {
    launcher: 'Destek sohbeti',
    hint: 'Yardıma mı ihtiyacınız var?',
    title: 'Destek burada',
    body: 'Giriş yapmadan önce bir sorunuz varsa ekibimiz size yardımcı olmaya hazır.',
    status: 'Şu an çevrimiçi',
  },
} as const;

export function LoginSupportWidget({ brandLetter, brandName, isRtl, locale }: LoginSupportWidgetProps) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);

  const copy = useMemo(() => {
    const normalizedLocale = locale.toLowerCase().startsWith('fa')
      ? 'fa'
      : locale.toLowerCase().startsWith('tr')
        ? 'tr'
        : 'en';

    return copyByLocale[normalizedLocale];
  }, [locale]);

  useEffect(() => {
    let timeoutId: number | undefined;

    const syncVisibility = () => {
      const existingWidget = document.querySelector('.gs-widget-root');
      const shouldShowFallback = !existingWidget;
      setVisible(shouldShowFallback);

      if (!shouldShowFallback) {
        setOpen(false);
      }
    };

    syncVisibility();
    timeoutId = window.setTimeout(syncVisibility, 1600);

    const observer = new MutationObserver(syncVisibility);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      observer.disconnect();
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div
      className={`fixed bottom-6 z-[2147482999] flex max-w-[calc(100vw-1.5rem)] flex-col gap-3 ${isRtl ? 'left-6 items-start' : 'right-6 items-end'}`}
    >
      {open && (
        <div className="w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-3xl border border-border bg-card text-card-foreground shadow-2xl backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3 bg-primary px-4 py-4 text-primary-foreground">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15 text-sm font-black text-primary-foreground">
                {brandLetter}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{brandName}</p>
                <p className="mt-1 text-xs text-primary-foreground/80">{copy.status}</p>
              </div>
            </div>
            <button
              type="button"
              aria-label={copy.launcher}
              onClick={() => setOpen(false)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary-foreground/15 text-primary-foreground transition-colors hover:bg-primary-foreground/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 px-4 py-4">
            <h2 className="text-base font-semibold text-foreground">{copy.title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">{copy.body}</p>
            <div className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground">
              <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
              {copy.hint}
            </div>
          </div>
        </div>
      )}

      <div className={`flex items-center gap-3 ${isRtl ? 'flex-row-reverse' : ''}`}>
        {!open && (
          <div className="hidden rounded-full border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-lg sm:block">
            {copy.hint}
          </div>
        )}

        <button
          type="button"
          aria-label={copy.launcher}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xl transition-transform hover:scale-[1.03]"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}