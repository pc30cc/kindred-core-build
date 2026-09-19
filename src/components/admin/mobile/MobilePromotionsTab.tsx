/**
 * Promotions: first-party promotional content inside the native app.
 *
 * Two things are kept apart on purpose, and the copy here says so:
 *
 *   • WHAT a promotion says lives on this row — one banner and one full-screen
 *     card, written in each of the three languages the app speaks.
 *   • WHO sees one is a plan decision, made in Super Admin → Plans against
 *     `mobile_promo_banner` and `mobile_promo_fullscreen`. A Free plan can
 *     carry promotions while every paid plan does not.
 *
 * This is not an ad network and must not become one without a fresh look at
 * Apple's rules: no SDK, no auction, no device identifier, no impression
 * beacon. That is what keeps the feature clear of App Tracking Transparency
 * (guideline 5.1.2) instead of depending on a prompt most people decline.
 *
 * The one rule with teeth is the external link. A button that leaves the app
 * for a page where a subscription can be bought falls under guidelines 3.1.1
 * and 3.1.3 and needs Apple's External Purchase Link Entitlement. The backend
 * strips the link until the switch at the bottom is on, so an unacknowledged
 * URL cannot ship by accident.
 */
import { Megaphone, LayoutTemplate, Maximize, Gauge, ShieldAlert } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

const LOCALES = ['en', 'fa', 'tr'] as const;
type Locale = (typeof LOCALES)[number];

type Creative = {
  cta_url?: string;
  image_url?: string;
  text?: Partial<Record<Locale, { title?: string; body?: string; cta_label?: string }>>;
};

type Slot = 'ads_banner' | 'ads_fullscreen';

export function MobilePromotionsTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();

  const creative = (slot: Slot): Creative => (draft[slot] ?? {}) as Creative;

  const setShared = (slot: Slot, key: 'cta_url' | 'image_url', value: string) => {
    set({ [slot]: { ...creative(slot), [key]: value } } as Partial<MobileAppSettings>);
  };

  const setText = (
    slot: Slot,
    locale: Locale,
    key: 'title' | 'body' | 'cta_label',
    value: string,
  ) => {
    const current = creative(slot);
    set({
      [slot]: {
        ...current,
        text: {
          ...(current.text ?? {}),
          [locale]: { ...(current.text?.[locale] ?? {}), [key]: value },
        },
      },
    } as Partial<MobileAppSettings>);
  };

  const textOf = (slot: Slot, locale: Locale, key: 'title' | 'body' | 'cta_label') =>
    creative(slot).text?.[locale]?.[key] ?? '';

  const hasExternalLink = LOCALES.length > 0 && (
    /^https:\/\//i.test(creative('ads_banner').cta_url ?? '')
    || /^https:\/\//i.test(creative('ads_fullscreen').cta_url ?? '')
  );

  const localeLabel: Record<Locale, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

  const slotFields = (slot: Slot) => (
    <>
      <TextField
        label={t('admin.mobileApp.promotions.ctaUrl') as string}
        hint={t('admin.mobileApp.promotions.ctaUrlHint') as string}
        value={creative(slot).cta_url ?? ''}
        onChange={(v) => setShared(slot, 'cta_url', v)}
        placeholder="https://"
        dir="ltr"
      />
      <TextField
        label={t('admin.mobileApp.promotions.imageUrl') as string}
        hint={t('admin.mobileApp.promotions.imageUrlHint') as string}
        value={creative(slot).image_url ?? ''}
        onChange={(v) => setShared(slot, 'image_url', v)}
        placeholder="https://"
        dir="ltr"
      />
      {LOCALES.map((locale) => (
        <div key={locale} className="col-span-full grid gap-1.5 rounded-xl border border-border/70 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {localeLabel[locale]}
          </p>
          <FieldGrid cols={2}>
            <TextField
              label={t('admin.mobileApp.promotions.title') as string}
              value={textOf(slot, locale, 'title')}
              onChange={(v) => setText(slot, locale, 'title', v)}
              dir={locale === 'fa' ? 'rtl' : 'ltr'}
            />
            <TextField
              label={t('admin.mobileApp.promotions.ctaLabel') as string}
              hint={t('admin.mobileApp.promotions.ctaLabelHint') as string}
              value={textOf(slot, locale, 'cta_label')}
              onChange={(v) => setText(slot, locale, 'cta_label', v)}
              dir={locale === 'fa' ? 'rtl' : 'ltr'}
            />
          </FieldGrid>
          <TextAreaField
            label={t('admin.mobileApp.promotions.body') as string}
            value={textOf(slot, locale, 'body')}
            onChange={(v) => setText(slot, locale, 'body', v)}
            rows={2}
            counter={200}
          />
        </div>
      ))}
    </>
  );

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Megaphone}
        heading={t('admin.mobileApp.promotions.heading') as string}
        caption={t('admin.mobileApp.promotions.caption') as string}
      >
        <SwitchField
          label={t('admin.mobileApp.promotions.enabled') as string}
          hint={t('admin.mobileApp.promotions.enabledHint') as string}
          checked={draft.ads_enabled}
          onChange={(v) => set({ ads_enabled: v })}
        />
      </SettingsSection>

      <SettingsSection
        icon={LayoutTemplate}
        heading={t('admin.mobileApp.promotions.bannerHeading') as string}
        caption={t('admin.mobileApp.promotions.bannerCaption') as string}
      >
        <FieldGrid cols={2}>{slotFields('ads_banner')}</FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Maximize}
        heading={t('admin.mobileApp.promotions.fullscreenHeading') as string}
        caption={t('admin.mobileApp.promotions.fullscreenCaption') as string}
      >
        <FieldGrid cols={2}>{slotFields('ads_fullscreen')}</FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Gauge}
        heading={t('admin.mobileApp.promotions.pacingHeading') as string}
        caption={t('admin.mobileApp.promotions.pacingCaption') as string}
      >
        <FieldGrid cols={3}>
          <TextField
            label={t('admin.mobileApp.promotions.interval') as string}
            hint={t('admin.mobileApp.promotions.intervalHint') as string}
            value={String(draft.ads_min_interval_minutes ?? 360)}
            onChange={(v) => set({ ads_min_interval_minutes: Number(v) || 0 })}
            type="number"
            dir="ltr"
          />
          <TextField
            label={t('admin.mobileApp.promotions.perDay') as string}
            hint={t('admin.mobileApp.promotions.perDayHint') as string}
            value={String(draft.ads_max_per_day ?? 3)}
            onChange={(v) => set({ ads_max_per_day: Number(v) || 0 })}
            type="number"
            dir="ltr"
          />
          <TextField
            label={t('admin.mobileApp.promotions.afterLaunches') as string}
            hint={t('admin.mobileApp.promotions.afterLaunchesHint') as string}
            value={String(draft.ads_start_after_launches ?? 2)}
            onChange={(v) => set({ ads_start_after_launches: Number(v) || 0 })}
            type="number"
            dir="ltr"
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={ShieldAlert}
        heading={t('admin.mobileApp.promotions.complianceHeading') as string}
        caption={t('admin.mobileApp.promotions.complianceCaption') as string}
      >
        <SwitchField
          label={t('admin.mobileApp.promotions.externalAck') as string}
          hint={t('admin.mobileApp.promotions.externalAckHint') as string}
          checked={draft.ads_external_link_acknowledged}
          onChange={(v) => set({ ads_external_link_acknowledged: v })}
        />
        {hasExternalLink && !draft.ads_external_link_acknowledged && (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            {t('admin.mobileApp.promotions.externalAckWarning')}
          </p>
        )}
        <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
          <li>{t('admin.mobileApp.promotions.rule1')}</li>
          <li>{t('admin.mobileApp.promotions.rule2')}</li>
          <li>{t('admin.mobileApp.promotions.rule3')}</li>
          <li>{t('admin.mobileApp.promotions.rule4')}</li>
        </ul>
      </SettingsSection>
    </div>
  );
}
