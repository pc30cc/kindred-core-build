import type { CSSProperties } from 'react';

export const CALL_VIDEO_ORIENTATION_CORRECTION = 'scaleX(-1)';
export const CALL_VIDEO_ORIENTATION_CORRECTION_MODE = 'scaleX(-1)' as const;

export const CALL_VIDEO_STYLE: CSSProperties & { scale: number; rotate: string } = {
  transform: CALL_VIDEO_ORIENTATION_CORRECTION,
  scale: 1,
  rotate: '0deg',
};

export type CallVideoRole =
  | 'operator-local'
  | 'operator-remote'
  | 'operator-local-waiting'
  | 'visitor-local'
  | 'visitor-remote';

export function isCallOrientationDebugEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return import.meta.env.DEV ||
      params.get('callOrientationDebug') === '1' ||
      window.localStorage.getItem('call_orientation_debug') === '1';
  } catch {
    return false;
  }
}

export function logCallVideoOrientation(role: CallVideoRole, el: HTMLVideoElement | null): void {
  if (!el) return;
  try {
    const computed = window.getComputedStyle(el);
    const dataAttrs: Record<string, string> = {};
    Array.from(el.attributes).forEach((attr) => {
      if (attr.name.startsWith('data-')) dataAttrs[attr.name] = attr.value || 'true';
    });
    console.info('[call-ui] video orientation', {
      role,
      computedTransform: computed.transform,
      inlineTransform: el.style.transform || '',
      correctionMode: CALL_VIDEO_ORIENTATION_CORRECTION_MODE,
      className: el.className,
      dataAttrs,
    });
  } catch {
    /* diagnostic only */
  }
}