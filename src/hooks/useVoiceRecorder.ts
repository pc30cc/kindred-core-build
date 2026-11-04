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

type RecorderCtor = typeof MediaRecorder | undefined;

function recorderCtor(): RecorderCtor {
  return typeof window !== 'undefined'
    ? (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
    : undefined;
}

function pickMime(): string {
  const MR = recorderCtor();
  if (!MR?.isTypeSupported) return '';
  for (const m of CANDIDATE_MIMES) if (MR.isTypeSupported(m)) return m;
  return '';
}

export interface VoiceRecorderState {
  supported: boolean;
  /**
   * A note is in hand: being recorded, or (once `maxSeconds` is reached)
   * stopped and waiting to be sent with `stop()` or dropped with `cancel()`.
   */
  recording: boolean;
  seconds: number;
  error: string | null;
  start: () => Promise<void>;
  /** Stops and resolves the recorded file (null when nothing was captured). */
  stop: () => Promise<File | null>;
  cancel: () => void;
}

function fileOf(chunks: BlobPart[], mimeType: string | undefined): File | null {
  const type = mimeType || 'audio/webm';
  const blob = new Blob(chunks, { type });
  if (blob.size < 512) return null;
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const baseType = type.split(';')[0] || 'audio/webm';
  return new File([blob], `voice-${Date.now()}.${ext}`, { type: baseType });
}

export function useVoiceRecorder(maxSeconds = 300): VoiceRecorderState {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  /** Settles with the note once the recorder has stopped (by hand or at maxSeconds). */
  const finishedRef = useRef<Promise<File | null> | null>(null);

  const supported =
    !!recorderCtor() &&
    !!navigator.mediaDevices?.getUserMedia;

  const stopTimer = useCallback(() => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  /** Lets go of the microphone (the browser's recording light goes out). */
  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    stopTimer();
    releaseMic();
    recorderRef.current = null;
    finishedRef.current = null;
    setRecording(false);
  }, [stopTimer, releaseMic]);

  /** Stops the recorder if it still runs; its onstop (set at start) finishes the note. */
  const halt = useCallback((rec: MediaRecorder | null) => {
    stopTimer();
    if (rec && rec.state !== 'inactive') {
      // A recorder that refuses to stop still hands over what it captured.
      try { rec.stop(); } catch { rec.onstop?.call(rec, new Event('stop')); }
    }
    releaseMic();
  }, [stopTimer, releaseMic]);

  /** Drops whatever is in hand (cancel, unmount). */
  const abandon = useCallback(() => {
    cancelledRef.current = true;
    halt(recorderRef.current);
    chunksRef.current = [];
    cleanup();
  }, [halt, cleanup]);

  useEffect(() => abandon, [abandon]);

  const start = useCallback(async () => {
    if (!supported || recording) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const Recorder = recorderCtor()!;
      const rec = new Recorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelledRef.current = false;
      rec.ondataavailable = (e: BlobEvent) => { if (e.data?.size) chunksRef.current.push(e.data); };
      // The stop handler is in place before anything can stop the recorder,
      // so a note stopped at maxSeconds is kept until it is sent or dropped.
      finishedRef.current = new Promise<File | null>((resolve) => {
        rec.onstop = () => {
          const file = cancelledRef.current ? null : fileOf(chunksRef.current, rec.mimeType);
          chunksRef.current = [];
          releaseMic();
          resolve(file);
        };
      });
      rec.start();
      recorderRef.current = rec;
      setSeconds(0);
      setRecording(true);
      let elapsed = 0;
      timerRef.current = window.setInterval(() => {
        elapsed += 1;
        setSeconds(elapsed);
        if (elapsed >= maxSeconds) halt(rec);
      }, 1000);
    } catch (e: unknown) {
      cleanup();
      setError((e instanceof Error && e.message) || 'microphone_unavailable');
    }
  }, [supported, recording, maxSeconds, cleanup, halt, releaseMic]);

  const stop = useCallback(async (): Promise<File | null> => {
    const rec = recorderRef.current;
    const finished = finishedRef.current;
    if (!rec || !finished) return null;
    halt(rec);
    try {
      return await finished;
    } finally {
      cleanup();
    }
  }, [halt, cleanup]);

  const cancel = useCallback(() => {
    abandon();
    setSeconds(0);
  }, [abandon]);

  return { supported, recording, seconds, error, start, stop, cancel };
}
