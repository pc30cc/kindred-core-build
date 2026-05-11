/**
 * Lazy local LiveKit client loader for the standalone Call Center
 * operator media console. Self-hosted, no CDN.
 *
 * Source: /widget/vendor/livekit-client.umd.min.js (served by frontend).
 * Idempotent: concurrent callers share the same in-flight promise.
 */

declare global {
  interface Window {
    LivekitClient?: any;
    LiveKit?: any;
  }
}

const LOCAL_SDK_PATH = '/widget/vendor/livekit-client.umd.min.js';

let inflight: Promise<any> | null = null;

function resolveExisting(): any | null {
  if (typeof window === 'undefined') return null;
  return window.LivekitClient || window.LiveKit || null;
}

export function loadLiveKitClient(): Promise<any> {
  const existing = resolveExisting();
  if (existing && existing.Room) return Promise.resolve(existing);
  if (inflight) return inflight;

  inflight = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('livekit_client_load_failed'));
      return;
    }
    // Reuse existing tag if any
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[data-livekit-loader="1"]`,
    );
    const onReady = () => {
      const lk = resolveExisting();
      if (!lk) return reject(new Error('livekit_client_load_failed'));
      if (!lk.Room) return reject(new Error('livekit_client_invalid'));
      resolve(lk);
    };
    if (existingScript) {
      existingScript.addEventListener('load', onReady, { once: true });
      existingScript.addEventListener(
        'error',
        () => reject(new Error('livekit_client_load_failed')),
        { once: true },
      );
      return;
    }
    const s = document.createElement('script');
    s.src = LOCAL_SDK_PATH;
    s.async = true;
    s.defer = true;
    s.dataset.livekitLoader = '1';
    s.onload = onReady;
    s.onerror = () => {
      inflight = null;
      reject(new Error('livekit_client_load_failed'));
    };
    document.head.appendChild(s);
  });

  // Reset inflight on failure so retry is possible.
  inflight.catch(() => {
    inflight = null;
  });

  return inflight;
}