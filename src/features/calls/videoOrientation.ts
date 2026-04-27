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

export type VideoOrientation = 'portrait' | 'landscape' | 'square';

export function getVideoOrientation(el: HTMLVideoElement | null): VideoOrientation | null {
  if (!el) return null;
  const w = el.videoWidth || 0;
  const h = el.videoHeight || 0;
  if (!w || !h) return null;
  if (h > w * 1.05) return 'portrait';
  if (w > h * 1.05) return 'landscape';
  return 'square';
}

/**
 * Apply orientation classes to the video element AND its closest stage
 * container. Returns the detected orientation (or null if metadata not yet
 * available). Safe to call repeatedly — old classes are removed first.
 */
export function applyVideoOrientationClass(
  el: HTMLVideoElement | null,
  role: CallVideoRole,
  stagePrefix: 'call-video' | 'gs-call-video' = 'call-video',
): VideoOrientation | null {
  if (!el) return null;
  const orientation = getVideoOrientation(el);
  if (!orientation) return null;
  const classes = [`${stagePrefix}--portrait`, `${stagePrefix}--landscape`, `${stagePrefix}--square`];
  el.classList.remove(...classes);
  el.classList.add(`${stagePrefix}--${orientation}`);
  // Mirror to nearest stage wrapper so layout (e.g. blurred bg) can react.
  const stage = el.closest('[data-call-stage], [data-call-surface], [data-call-video-stage]') as HTMLElement | null;
  if (stage) {
    stage.classList.remove(...classes);
    stage.classList.add(`${stagePrefix}--${orientation}`);
    stage.setAttribute('data-video-orientation', orientation);
  }
  try {
    // eslint-disable-next-line no-console
    console.info('[call-ui] video dimensions', {
      role,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      orientation,
    });
    // eslint-disable-next-line no-console
    console.info('[call-ui] orientation class applied', {
      role,
      orientation,
      cls: `${stagePrefix}--${orientation}`,
    });
  } catch { /* diagnostic only */ }
  return orientation;
}

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