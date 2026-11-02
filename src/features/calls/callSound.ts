/**
 * Operator-side call sound utility (ringback, message tone, and the
 * ringtone of an incoming colleague call).
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
 *   - Ringtone (an incoming colleague call, TEAM_CALLS.md "Web panel") =
 *     a brighter double ring (C5+E5, twice) every 3s, made in the page:
 *     no audio file. `startRingtone()` / `stopRingtone(reason)`.
 *   - A colleague call's ringback has its own switch
 *     (`startTeamRingback()` / `stopTeamRingback(reason)`, the same tone):
 *     the visitor call's surface stops its ringback on every phase change,
 *     which must never silence a colleague who is being rung, and a
 *     colleague call's end must never silence a visitor's.
 *   - Settings: read `localStorage.operator_sound_enabled` (default ON).
 *   - Never throws — audio failures are swallowed and logged at debug level.
 */
import { callDebug } from './callDebug';

let audioCtx: AudioContext | null = null;
let userInteracted = false;
let ringbackTimer: ReturnType<typeof setInterval> | null = null;
let ringbackActive = false;
let unlockHandlersInstalled = false;
let ringtoneTimer: ReturnType<typeof setInterval> | null = null;
let ringtoneActive = false;
let teamRingbackTimer: ReturnType<typeof setInterval> | null = null;
let teamRingbackActive = false;

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
    if (ringtoneActive && !ringtoneTimer) startRingtoneInternal();
    if (teamRingbackActive && !teamRingbackTimer) startTeamRingbackInternal();
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
  // The click that started the call is itself a valid user gesture.
  // Try to create/resume the AudioContext now — if it ends up in the
  // 'running' state, audio is unlocked and we can ring immediately.
  // This is the common path for operator-initiated calls (the operator
  // clicked the Call button in the same task tick).
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === 'running') {
    userInteracted = true;
    startRingbackInternal();
    return;
  }
  // Fallback: AudioContext is suspended (rare for operator flow, e.g.
  // tab restored without interaction). Wait for the next gesture.
  if (ctx && ctx.resume) {
    ctx.resume().then(() => {
      if (!ringbackActive) return;
      if (ctx.state === 'running') {
        userInteracted = true;
        startRingbackInternal();
      }
    }).catch(() => { /* swallow — unlock handler will retry */ });
  }
  callDebug('call-sound', 'operator ringback waiting for audio unlock', { state: ctx?.state ?? 'no-ctx' });
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

function ringtoneOnce() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    // A phone-like double ring: two short chords (C5 + E5), 0.4s each.
    for (const at of [0, 0.55]) {
      for (const f of [523.25, 659.25]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, t0 + at);
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(0.09, t0 + at + 0.02);
        gain.gain.setValueAtTime(0.09, t0 + at + 0.32);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.42);
      }
    }
  } catch {
    /* swallow */
  }
}

function startRingtoneInternal() {
  if (ringtoneTimer) return;
  ringtoneOnce();
  ringtoneTimer = setInterval(ringtoneOnce, 3000);
}

/**
 * Ring for an incoming colleague call. Idempotent. The ring arrives without
 * a click, so when the browser still holds the page's audio (no interaction
 * yet) it starts on the member's first interaction, as the ringback does.
 * Honors the operator sound switch (`operator_sound_enabled`).
 */
export function startRingtone(): void {
  if (typeof window === 'undefined') return;
  installUnlockHandlers();
  if (!isOperatorSoundEnabled()) {
    callDebug('call-sound', 'ringtone skipped (disabled)');
    return;
  }
  if (ringtoneActive) return;
  ringtoneActive = true;
  callDebug('call-sound', 'ringtone start');
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === 'running') {
    startRingtoneInternal();
    return;
  }
  if (ctx && ctx.resume) {
    ctx.resume().then(() => {
      if (ringtoneActive && ctx.state === 'running') startRingtoneInternal();
    }).catch(() => { /* swallow — unlock handler will retry */ });
  }
}

/** Stop the incoming-call ringtone. Idempotent. `reason` is diagnostic only. */
export function stopRingtone(reason: string = 'unspecified'): void {
  if (!ringtoneActive && !ringtoneTimer) return;
  ringtoneActive = false;
  if (ringtoneTimer) {
    try { clearInterval(ringtoneTimer); } catch { /* swallow */ }
    ringtoneTimer = null;
  }
  callDebug('call-sound', 'ringtone stop', { reason });
}

/** Diagnostic only. */
export function isRingtoneActive(): boolean {
  return ringtoneActive;
}

function startTeamRingbackInternal() {
  if (teamRingbackTimer) return;
  ringOnce();
  teamRingbackTimer = setInterval(ringOnce, 1900);
}

/**
 * The caller's ringback of a colleague call (TEAM_CALLS.md, "Web panel"):
 * the visitor ringback's tone, under a switch of its own, so neither call's
 * surface ever stops the other's. Idempotent; queued until the page may play
 * audio, like `startRingback`. Honors `operator_sound_enabled`.
 */
export function startTeamRingback(): void {
  if (typeof window === 'undefined') return;
  installUnlockHandlers();
  if (!isOperatorSoundEnabled()) {
    callDebug('call-sound', 'team ringback skipped (disabled)');
    return;
  }
  if (teamRingbackActive) return;
  teamRingbackActive = true;
  callDebug('call-sound', 'team ringback start');
  // Called in the call button's own click: usually a running context.
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === 'running') {
    userInteracted = true;
    startTeamRingbackInternal();
    return;
  }
  if (ctx && ctx.resume) {
    ctx.resume().then(() => {
      if (teamRingbackActive && ctx.state === 'running') {
        userInteracted = true;
        startTeamRingbackInternal();
      }
    }).catch(() => { /* swallow — unlock handler will retry */ });
  }
}

/** Stop a colleague call's ringback. Idempotent. `reason` is diagnostic only. */
export function stopTeamRingback(reason: string = 'unspecified'): void {
  if (!teamRingbackActive && !teamRingbackTimer) return;
  teamRingbackActive = false;
  if (teamRingbackTimer) {
    try { clearInterval(teamRingbackTimer); } catch { /* swallow */ }
    teamRingbackTimer = null;
  }
  callDebug('call-sound', 'team ringback stop', { reason });
}

/** Diagnostic only. */
export function isTeamRingbackActive(): boolean {
  return teamRingbackActive;
}
