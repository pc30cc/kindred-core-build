/** Module-owned destination policy. Provider assets on customer sites remain allowed. */
export const bridgeProviderDomains = ['goftino.com', 'raychat.io', 'crisp.chat', 'webyar.ai', 'respok.app'] as const;

export function isBridgeProviderSite(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
    return bridgeProviderDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

export function assertBridgeTarget(value: string): void {
  if (isBridgeProviderSite(value)) throw new Error('provider_site_blocked');
}
