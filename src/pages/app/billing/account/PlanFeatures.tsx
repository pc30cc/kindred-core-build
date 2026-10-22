/**
 * What a plan gives, as a short list: its countable limits first, then the
 * capabilities it grants — built from the same limits/entitlements the
 * platform enforces, so a card never promises what the plan does not grant.
 * Storage is in MB (`storage_mb`, migration 271). The monthly AI credit is
 * passed in already formatted (`aiCredit`): the server computes it with the
 * grant's own function and converts it as the billing page does.
 *
 * Only keys something enforces are listed. The reserved ones nothing reads
 * (advanced_ai_agent, custom_branding, white_label, sso, api_access; see
 * server/services/billing/capabilityRegistry.ts) are not, whatever a plan
 * stores. What a plan really changes about the platform's "Powered by"
 * credit (server/services/widget/poweredBy.ts) is listed instead: none in
 * the widget, or the owner's option to hide it.
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useEdition } from '@/hooks/useEdition';
import { formatMb } from '@/lib/storageUnits';
import { storageLimitMb } from '../../../../../shared/planLimits';

const CAP_KEYS = [
  'max_agents',
  'max_conversations',
  'max_visitors',
  'max_contacts',
  'max_kb_articles',
  'storage_mb',
  'max_call_minutes_per_month',
  'max_widget_domains',
  'data_retention_days',
] as const;

const FEATURE_KEYS = [
  'chat_widget',
  'omnichannel',
  'telegram',
  'whatsapp',
  'instagram',
  'email',
  'sms',
  'bale',
  'ai_assistant',
  'ai_kb_builder',
  'ai_operator_assist',
  'knowledge_base',
  'help_center',
  'call_center',
  'call_recording',
  'call_queue',
  'voice_video',
  'visitor_tracking',
  'contacts',
  'widget_smart_engagement',
  'automation',
  'analytics',
  'audit_logs',
  'priority_support',
] as const;

/** The "Powered by" credit's items, after the features (see creditItem). */
const CREDIT_KEYS = ['no_powered_by', 'widget_powered_by_toggle'] as const;

/**
 * What the plan changes about the credit, by the rule the widget follows
 * (isPoweredByAllowedForPlan): `widget_powered_by: false` shows none (the
 * legacy `remove_powered_by: true` too, while the plan does not name
 * widget_powered_by); else `widget_powered_by_toggle: true` lets the owner
 * hide it. Nothing to say for a plan that shows it, as every plan does by
 * default.
 */
function creditItem(entitlements: Record<string, unknown>): (typeof CREDIT_KEYS)[number] | null {
  const shown = 'widget_powered_by' in entitlements
    ? entitlements.widget_powered_by !== false
    : entitlements.remove_powered_by !== true;
  if (!shown) return 'no_powered_by';
  return entitlements.widget_powered_by_toggle === true ? 'widget_powered_by_toggle' : null;
}

const SHOWN = 6;

export default function PlanFeatures({
  limits,
  entitlements,
  aiCredit = null,
}: {
  limits: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  /** The plan's monthly AI credit, formatted; null or omitted when it grants none. */
  aiCredit?: string | null;
}) {
  const { t, locale } = useTranslation();
  // Bale (an Iranian messenger) is a feature of the Iranian edition only.
  const { features: editionFeatures } = useEdition();
  const [expanded, setExpanded] = useState(false);
  const nf = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US');

  // The monthly AI credit first: it is what plans differ by most, and the
  // list is cut after SHOWN items.
  const items: string[] = aiCredit ? [t('billing.plans.aiCreditMonthly', { value: aiCredit })] : [];
  for (const key of CAP_KEYS) {
    // Storage in MB (storage_mb).
    const raw = key === 'storage_mb' ? storageLimitMb(limits) ?? NaN : Number(limits[key]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const value = raw < 0
      ? t('billing.plans.unlimited')
      : key === 'storage_mb' ? formatMb(raw, locale) : nf.format(raw);
    items.push(t(`billing.plans.cap.${key}` as TranslationKey, { value }));
  }
  for (const key of FEATURE_KEYS) {
    if (entitlements[key] !== true) continue;
    if (key === 'bale' && !editionFeatures.bale) continue;
    items.push(t(`billing.plans.feat.${key}` as TranslationKey));
  }
  const credit = creditItem(entitlements);
  if (credit) items.push(t(`billing.plans.feat.${credit}` as TranslationKey));
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, SHOWN);

  return (
    <div className="space-y-1.5">
      <ul className="space-y-1 text-xs text-muted-foreground">
        {shown.map((label) => (
          <li key={label} className="flex items-start gap-1.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span>{label}</span>
          </li>
        ))}
      </ul>
      {items.length > SHOWN && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="text-xs font-medium text-primary hover:underline"
        >
          {expanded ? t('billing.plans.showLess') : `${t('billing.plans.showAll')} (${items.length - SHOWN}+)`}
        </button>
      )}
    </div>
  );
}
