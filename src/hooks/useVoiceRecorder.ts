/**
 * Operator voice-note recorder (MediaRecorder).
 *
 * Produces a File the caller can hand to the normal attachment upload flow,
 * so recorded audio travels the exact same authenticated path as any other
 * operator attachment. Mime negotiation mirrors the widget: Chrome/Firefox
 * yield audio/webm, Safari audio/mp4.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const CANDIDATE_MIMES = ['audio/webm', 'audio/mp4', 'audio/ogg'];

function pickMime(): string {
  const MR = (window as any).MediaRecorder;
  if (!MR?.isTypeSupported) return '';
  for (const m of CANDIDATE_MIMES) if (MR.isTypeSupported(m)) return m;
  return '';
}

export interface VoiceRecorderState {
  supported: boolean;
  recording: boolean;
  seconds: number;
  error: string | null;
  start: () => Promise<void>;
  /** Stops and resolves the recorded file (null when nothing was captured). */
  stop: () => Promise<File | null>;
  cancel: () => void;
}

export function useVoiceRecorder(maxSeconds = 300): VoiceRecorderState {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<any>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const supported =
    typeof window !== 'undefined' &&
    typeof (window as any).MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  const cleanup = useCallback(() => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    if (!supported || recording) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new (window as any).MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelledRef.current = false;
      rec.ondataavailable = (e: any) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.start();
      recorderRef.current = rec;
      setSeconds(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= maxSeconds) { try { rec.stop(); } catch { /* noop */ } }
          return next;
        });
      }, 1000);
    } catch (e: any) {
      cleanup();
      setError(e?.message || 'microphone_unavailable');
    }
  }, [supported, recording, maxSeconds, cleanup]);

  const stop = useCallback(() => {
    return new Promise<File | null>((resolve) => {
      const rec = recorderRef.current;
      if (!rec) { resolve(null); return; }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        cleanup();
        if (cancelledRef.current || blob.size < 512) { resolve(null); return; }
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const baseType = type.split(';')[0] || 'audio/webm';
        resolve(new File([blob], `voice-${Date.now()}.${ext}`, { type: baseType }));
      };
      try { rec.stop(); } catch { cleanup(); resolve(null); }
    });
  }, [cleanup]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    if (rec) { try { rec.stop(); } catch { /* noop */ } }
    chunksRef.current = [];
    cleanup();
    setSeconds(0);
  }, [cleanup]);

  return { supported, recording, seconds, error, start, stop, cancel };
}
