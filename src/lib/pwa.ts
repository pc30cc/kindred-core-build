/**
 * PWA service worker registration (web only).
 *
 * The worker itself is generated at build time — see vite.config.ts's
 * `pwaBuild` plugin and scripts/pwa/service-worker-template.js. This module
 * only registers it and surfaces an "update available" toast; it never
 * force-reloads the page, since an unannounced reload mid-session could
 * drop an operator's in-progress reply or a visitor's typed message.
 */
import { createElement } from 'react';
import { isNativePlatform } from '@/lib/native';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

let updateToastShown = false;

function promptForUpdate(registration: ServiceWorkerRegistration) {
  if (updateToastShown) return;
  updateToastShown = true;

  const applyUpdate = () => {
    const waiting = registration.waiting;
    if (!waiting) { window.location.reload(); return; }
    // Reload once the NEW worker actually takes control, not immediately —
    // otherwise the page can reload while still served by the old worker.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waiting.postMessage('SKIP_WAITING');
  };

  toast({
    title: 'نسخه جدید در دسترس است',
    description: 'برای دریافت آخرین به‌روزرسانی، صفحه را تازه‌سازی کنید.',
    // No auto-dismiss — this app can stay open in the inbox for a full
    // shift, so a self-dismissing toast could easily be missed.
    duration: Infinity,
    action: createElement(ToastAction, { altText: 'تازه‌سازی', onClick: applyUpdate }, 'تازه‌سازی') as never,
  });
}

/**
 * Preview/dev/iframe contexts rebuild assets constantly, so a caching worker
 * there only produces an endless "new version available" prompt. In those
 * contexts we actively unregister any worker instead of registering one.
 */
function isDisallowedContext(): boolean {
  if (!import.meta.env.PROD) return true;
  try { if (window.self !== window.top) return true; } catch { return true; }
  const h = window.location.hostname;
  if (h.startsWith('id-preview--') || h.startsWith('preview--')) return true;
  if (h === 'lovableproject.com' || h.endsWith('.lovableproject.com')) return true;
  if (h === 'lovableproject-dev.com' || h.endsWith('.lovableproject-dev.com')) return true;
  if (h === 'beta.lovable.dev' || h.endsWith('.beta.lovable.dev')) return true;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (new URLSearchParams(window.location.search).has('sw') && new URLSearchParams(window.location.search).get('sw') === 'off') return true;
  return false;
}

async function unregisterAppWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs
        .filter((r) => {
          const url = r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || '';
          return url.endsWith('/sw.js');
        })
        .map((r) => r.unregister()),
    );
  } catch { /* best effort */ }
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Never inside the native Capacitor shell: it loads the bundled dist/
  // directly (capacitor.config.ts webDir), not this page over the network —
  // a caching worker there would only risk fighting the native bundle.
  if (isNativePlatform()) return;
  if (isDisallowedContext()) { void unregisterAppWorkers(); return; }


  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      // A worker may already be sitting in "waiting" from a previous visit
      // (e.g. this tab was open across a deploy).
      if (registration.waiting && registration.active) promptForUpdate(registration);

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `active` on the registration means this is an UPDATE to an
          // already-controlled page, not the very first install (which has
          // nothing to prompt about — there is no older version to leave).
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            promptForUpdate(registration);
          }
        });
      });
    }).catch(() => {
      // Registration is a progressive enhancement — never block the app.
    });
  });
}
