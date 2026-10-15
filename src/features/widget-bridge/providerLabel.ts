import type { TranslationKey } from '@/i18n';
import type { BridgeAllowedProvider } from '../../../shared/widgetBridge';

const NAMES: Partial<Record<BridgeAllowedProvider, string>> = { crisp: 'Crisp', raychat: 'Raychat', goftino: 'Goftino' };

/**
 * A provider's label: third-party widgets by name; this platform's own widget
 * (`platform`) by the edition's brand (`{{brandLatin}}`), custom by its text.
 */
export function bridgeProviderLabel(provider: BridgeAllowedProvider, t: (key: TranslationKey) => string): string {
  if (provider === 'custom') return t('widgetBridge.custom');
  if (provider === 'platform') return t('widgetBridge.platformProvider');
  return NAMES[provider] ?? provider;
}
