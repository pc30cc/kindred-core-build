/**
 * Operator-side call sound utility (ringback, message tone).
 *
 * Uses Web Audio API. Honors browser autoplay policy by deferring AudioContext
 * creation/resume until first user interaction. All operations are idempotent
 * and safe to call repeatedly.
 *
 * Logs are gated by the `callDebug` flag (see `callDebug.ts`).
 *
 * Design:
 *   - One shared AudioContext per tab.
 *   - Ringback = soft 2-tone (A4↔E5) loop, ~1.9s cadence.
 *   - Stop is fully idempotent (`stopRingback(reason)`).
 *   - Settings: read `localStorage.operator_sound_enabled` (default ON).
 *   - Never throws — audio failures are swallowed and logged at debug level.
 */
import { callDebug } from './callDebug';

let audioCtx: AudioContext | null = null;
let userInteracted = false;
let ringbackTimer: ReturnType<typeof setInterval> | null = null;
let ringbackActive = false;
let unlockHandlersInstalled = false;

function isOperatorSoundEnabled(): boolean {
  try {
    const v = window.localStorage.getItem('operator_sound_enabled');
    if (v === '0' || v === 'false') return false;
    return true; // default ON
  } catch {
    return true;
  }
}

function installUnlockHandlers() {
  if (unlockHandlersInstalled || typeof window === 'undefined') return;
  unlockHandlersInstalled = true;
  const mark = () => {
    if (userInteracted) return;
    userInteracted = true;
    callDebug('call-sound', 'audio unlocked');
    // If ringback was requested before unlock, start it now.
    if (ringbackActive && !ringbackTimer) startRingbackInternal();
  };
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('pointerdown', mark, opts);
  window.addEventListener('keydown', mark, opts);
  window.addEventListener('touchstart', mark, opts);
}

function ensureAudioCtx(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended' && audioCtx.resume) {
      try { void audioCtx.resume(); } catch { /* swallow */ }
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function ringOnce() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    // Soft professional pattern — two-tone warble, A4→E5 twice over ~0.9s.
    const pattern = [
      { f: 440.0, at: 0.0, dur: 0.22 },
      { f: 659.25, at: 0.22, dur: 0.22 },
      { f: 440.0, at: 0.46, dur: 0.22 },
      { f: 659.25, at: 0.68, dur: 0.22 },
    ];
    for (const n of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, t0 + n.at);
      gain.gain.setValueAtTime(0.0001, t0 + n.at);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + n.at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.02);
    }
  } catch {
    /* swallow */
  }
}

function startRingbackInternal() {
  if (ringbackTimer) return;
  ringOnce();
  ringbackTimer = setInterval(ringOnce, 1900);
}

/**
 * Begin operator ringback. Idempotent — calling again is a no-op while
 * already ringing. If audio is locked by the autoplay policy, the request
 * is queued and starts automatically on first user interaction.
 */
export function startRingback(): void {
  if (typeof window === 'undefined') return;
  installUnlockHandlers();
  if (!isOperatorSoundEnabled()) {
    callDebug('call-sound', 'operator ringback skipped (disabled)');
    return;
  }
  if (ringbackActive) return;
  ringbackActive = true;
  callDebug('call-sound', 'operator ringback start');
  if (!userInteracted) {
    callDebug('call-sound', 'operator ringback blocked (awaiting user gesture)');
    return;
  }
  startRingbackInternal();
}

/**
 * Stop operator ringback. Idempotent. `reason` is purely diagnostic.
 */
export function stopRingback(reason: string = 'unspecified'): void {
  if (!ringbackActive && !ringbackTimer) return;
  ringbackActive = false;
  if (ringbackTimer) {
    try { clearInterval(ringbackTimer); } catch { /* swallow */ }
    ringbackTimer = null;
  }
  callDebug('call-sound', 'operator ringback stop', { reason });
}

/** Diagnostic only. */
export function isRingbackActive(): boolean {
  return ringbackActive;
}