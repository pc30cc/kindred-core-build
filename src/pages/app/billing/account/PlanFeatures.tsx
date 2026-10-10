/**
 * What a plan gives, as a short list: its countable limits first, then the
 * capabilities it grants — built from the same limits/entitlements the
 * platform enforces, so a card never promises what the plan does not grant.
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useEdition } from '@/hooks/useEdition';

const CAP_KEYS = [
  'max_agents',
  'max_conversations',
  'max_visitors',
  'max_contacts',
  'max_kb_articles',
  'storage_gb',
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
  'advanced_ai_agent',
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
  'api_access',
  'audit_logs',
  'sso',
  'custom_branding',
  'white_label',
  'remove_powered_by',
  'priority_support',
] as const;

const SHOWN = 6;

export default function PlanFeatures({ limits, entitlements }: { limits: Record<string, unknown>; entitlements: Record<string, unknown> }) {
  const { t, locale } = useTranslation();
  // Bale (an Iranian messenger) is a feature of the Iranian edition only.
  const { features: editionFeatures } = useEdition();
  const [expanded, setExpanded] = useState(false);
  const nf = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US');

  const items: string[] = [];
  for (const key of CAP_KEYS) {
    const raw = Number(limits[key]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const value = raw < 0 ? t('billing.plans.unlimited') : nf.format(raw);
    items.push(t(`billing.plans.cap.${key}` as TranslationKey, { value }));
  }
  for (const key of FEATURE_KEYS) {
    if (entitlements[key] !== true) continue;
    if (key === 'bale' && !editionFeatures.bale) continue;
    items.push(t(`billing.plans.feat.${key}` as TranslationKey));
  }
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
