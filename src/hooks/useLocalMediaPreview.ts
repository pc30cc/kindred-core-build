/**
 * Phase 9 — Local-device preview for the operator waiting surface.
 *
 * Opens getUserMedia immediately after invitation creation so the operator
 * sees themselves (video) or knows their mic is hot (audio) BEFORE the
 * visitor joins and the real LiveKit room is established.
 *
 * Strict rules:
 *  - Decoupled from LiveKit. The hook never imports or touches the Room
 *    instance — it only owns a local MediaStream.
 *  - The stream is released as soon as `enabled` flips false (waiting →
 *    connecting / connected / terminal). This frees the camera/mic so
 *    the LiveKit client can re-acquire them on connect without device-
 *    busy errors on browsers (notably Safari) that lock devices per-
 *    consumer.
 *  - Audio invites NEVER request video — `wantVideo=false` in that case.
 */
import { useEffect, useRef, useState } from 'react';

export type LocalPreviewState = 'idle' | 'requesting' | 'ready' | 'denied' | 'failed';

export interface UseLocalMediaPreviewOptions {
  /** Whether the preview should be running. Flip false to release devices. */
  enabled: boolean;
  /** Whether to also request a camera track. Audio is always requested. */
  wantVideo: boolean;
}

export interface UseLocalMediaPreviewApi {
  state: LocalPreviewState;
  stream: MediaStream | null;
  error: string | null;
}

export function useLocalMediaPreview(opts: UseLocalMediaPreviewOptions): UseLocalMediaPreviewApi {
  const { enabled, wantVideo } = opts;
  const [state, setState] = useState<LocalPreviewState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;

    function release() {
      const s = streamRef.current;
      if (!s) return;
      streamRef.current = null;
      try {
        s.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* noop */ }
        });
      } catch { /* noop */ }
      setStream(null);
    }

    if (!enabled) {
      release();
      setState('idle');
      setError(null);
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState('failed');
      setError('media_devices_unavailable');
      return;
    }

    setState('requesting');
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: wantVideo })
      .then((s) => {
        if (cancelled) {
          // Effect re-ran (or wantVideo flipped) before getUserMedia
          // resolved — release immediately so we don't hold the camera.
          s.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
          return;
        }
        streamRef.current = s;
        setStream(s);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        const name = err?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setState('denied');
        } else {
          setState('failed');
        }
        setError(err?.message || name || 'unknown');
      });

    return () => {
      cancelled = true;
      release();
    };
  }, [enabled, wantVideo]);

  // Hard cleanup on unmount even if `enabled` was still true.
  useEffect(() => {
    return () => {
      const s = streamRef.current;
      if (s) s.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      streamRef.current = null;
    };
  }, []);

  return { state, stream, error };
}