/**
 * Native (iOS) settings screen.
 *
 * Structured like a real iOS Settings app: an identity hero (avatar, name,
 * email), then grouped sections — profile, notifications, availability,
 * shortcuts, appearance & language, support, and finally sign out.
 * Each row pushes a sub-screen that reuses the exact same, already-audited
 * settings surface as the web panel (see MobileSubScreen).
 */
import { useNavigate, useParams } from 'react-router-dom';
import {
  Bell,
  Check,
  Clock,
  HelpCircle,
  Languages,
  LogOut,
  Moon,
  Star,
  Sun,
  SunMoon,
  UserRound,
  Zap,
} from 'lucide-react';
import { useTheme } from 'next-themes';

import { useI18n, useTranslation } from '@/i18n';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/features/auth/AuthContext';
import { useProfile } from '@/hooks/useProfile';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { cn } from '@/lib/utils';
import { MobileScreen, MobileGroup, MobileRow } from './MobileScreen';
import { appStoreUrl, supportUrl, openExternal } from './mobileLinks';

const LANGUAGES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'fa', label: 'فارسی' },
];

const THEMES = [
  { value: 'light', label: 'interface.light', icon: Sun },
  { value: 'dark', label: 'interface.dark', icon: Moon },
  { value: 'system', label: 'interface.system', icon: SunMoon },
] as const;

export default function MobileSettingsPage() {
  const { t } = useTranslation();
  const { locale, setLocale } = useI18n();
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const { data: profile } = useProfile();

  const go = (path: string) => navigate(`/${slug}/settings/${path}`);
  const store = appStoreUrl();
  const support = supportUrl();
  const name = (profile?.full_name || '').trim() || user?.email || '';

  return (
    <MobileScreen centered title={t('nav.settings')} bodyClassName="pb-[124px]">
      {/* Identity hero */}
      <div className="flex flex-col items-center gap-2 px-4 pb-1 pt-6">
        <ContactAvatar
          name={profile?.full_name}
          email={user?.email}
          avatarUrl={profile?.avatar_url}
          size="lg"
          className="scale-[1.55]"
        />
        <p className="mt-4 truncate text-[19px] font-bold text-foreground">{name}</p>
        <p
          className="max-w-full truncate text-[13px] text-muted-foreground"
          style={{ unicodeBidi: 'plaintext' }}
        >
          {user?.email}
        </p>
      </div>

      <MobileGroup title={t('settings.profile')}>
        <MobileRow
          icon={UserRound}
          iconClassName="bg-primary/15 text-primary"
          label={t('account.title')}
          description={t('settings.profile')}
          chevron
          onClick={() => go('profile')}
        />
      </MobileGroup>

      <MobileGroup>
        <MobileRow
          icon={Bell}
          iconClassName="bg-rose-500/15 text-rose-500"
          label={t('notifications.title')}
          chevron
          onClick={() => go('notifications')}
        />
        <MobileRow
          icon={Clock}
          iconClassName="bg-emerald-500/15 text-emerald-600"
          label={t('availabilityPage.title')}
          chevron
          onClick={() => go('availability')}
        />
        <MobileRow
          icon={Zap}
          iconClassName="bg-amber-500/15 text-amber-600"
          label={t('canned.title')}
          description={t('canned.memberHint')}
          chevron
          onClick={() => go('shortcuts')}
        />
      </MobileGroup>

      <MobileGroup title={t('interface.appearance')}>
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-muted/60"
          >
            <option.icon className="h-5 w-5 text-muted-foreground" />
            <span className="flex-1 text-[15px] text-foreground">
              {t(option.label)}
            </span>
            <Check
              className={cn(
                'h-5 w-5 text-primary transition-opacity',
                (theme ?? 'system') === option.value ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        ))}
      </MobileGroup>

      <MobileGroup title={t('interface.language')}>
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            type="button"
            onClick={() => setLocale(lang.code)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-muted/60"
          >
            <Languages className="h-5 w-5 text-muted-foreground" />
            <span className="flex-1 text-[15px] text-foreground">{lang.label}</span>
            <Check
              className={cn(
                'h-5 w-5 text-primary transition-opacity',
                locale === lang.code ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        ))}
      </MobileGroup>

      {(store || support) && (
        <MobileGroup>
          {store && (
            <MobileRow
              icon={Star}
              iconClassName="bg-yellow-500/15 text-yellow-600"
              label={t('mobileSettings.rateApp')}
              chevron
              onClick={() => openExternal(store)}
            />
          )}
          {support && (
            <MobileRow
              icon={HelpCircle}
              iconClassName="bg-sky-500/15 text-sky-600"
              label={t('mobileSettings.help')}
              description={t('mobileSettings.helpHint')}
              chevron
              onClick={() => openExternal(support)}
            />
          )}
        </MobileGroup>
      )}

      <div className="px-4 pt-5">
        <button
          type="button"
          onClick={() => signOut()}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-card py-3.5 text-[16px] font-semibold text-destructive shadow-[0_1px_2px_hsl(220_40%_20%/0.06)] active:bg-destructive/10"
        >
          <LogOut className="h-5 w-5" />
          {t('auth.logout')}
        </button>
      </div>
    </MobileScreen>
  );
}
