import type { Page } from '@playwright/test';
import { assertBridgeTarget, isBridgeProviderSite } from '../../shared/widgetBridgeTargets.js';

/** Block top-level redirects, never the provider's embedded widget/API/assets. */
export async function guardBridgePage(page: Page): Promise<() => void> {
  let blocked = false;
  // Redirect hops may bypass route handlers; observe every navigation request.
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && isBridgeProviderSite(request.url())) blocked = true;
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame() && isBridgeProviderSite(frame.url())) blocked = true;
  });
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && isBridgeProviderSite(request.url())) {
      blocked = true;
      await route.abort('blockedbyclient');
    } else await route.fallback();
  });
  return () => {
    if (blocked) throw new Error('provider_site_blocked');
    assertBridgeTarget(page.url());
  };
}
