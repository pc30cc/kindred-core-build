/**
 * Phase — Inbox Call Hardening · Pass 3
 *
 * Ringtone / Ringback controller — WebAudio-only, zero asset dependencies.
 *
 * Why WebAudio (and not an <audio> tag with an mp3):
 *  - No bundle/asset weight added to the inbox or widget.
 *  - Lazy-init: the AudioContext is created only the first time we need
 *    to play sound, so normal inbox/messaging boot stays clean.
 *  - Single shared instance per page → impossible to leak overlapping
 *    loops if the engine flips phase rapidly.
 *
 * Two distinct sounds, exposed as two distinct kinds:
 *   - 'incoming'  → operator is being called (queue offer / direct invite).
 *                   Repeating two-tone "ring-ring" pattern (440 / 480 Hz),
 *                   modeled after a classic PSTN ring cadence.
 *   - 'ringback'  → operator started a call and is waiting for the visitor
 *                   to answer. Long single-tone (425 Hz) on/off cadence,
 *                   matches what a caller hears on most networks.
 *
 * Public surface is intentionally tiny:
 *   start(kind)  — idempotent. Calling start('incoming') twice does NOT
 *                  create a second loop. Switching kind stops the previous.
 *   stop()       — idempotent. Safe to call from multiple cleanup paths
 *                  (engine terminal phase, component unmount, race winners).
 *   isPlaying()  — read-only.
 *
 * The controller is browser-autoplay-safe: if the AudioContext starts in
 * 'suspended' state (no user gesture yet), we silently no-op rather than
 * throwing. The visible UI still rings; the next user interaction will
 * unlock audio for the next call.
 */

export type RingKind = 'incoming' | 'ringback';

interface ActiveLoop {
  kind: RingKind;
  /** setInterval id driving the on/off cadence. */
  cadenceId: ReturnType<typeof setInterval>;
  /** The currently sounding oscillator(s), if any. */
  stopBeep: () => void;
}

class RingtoneController {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private active: ActiveLoop | null = null;

  private ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      // Conservative volume — calls are alerts, not music.
      this.masterGain.gain.value = 0.18;
      this.masterGain.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /**
   * Play one short "beep" composed of one or more oscillators in parallel.
   * Returns a stop fn that immediately silences the beep (used so we can
   * cancel mid-beep when stop() races with a phase transition).
   */
  private beep(freqs: number[], durationMs: number): () => void {
    const ctx = this.ctx;
    const out = this.masterGain;
    if (!ctx || !out) return () => {};
    if (ctx.state === 'suspended') {
      // Try to resume — if no user gesture has happened yet this is a no-op,
      // and we treat the beep as silent.
      try { void ctx.resume(); } catch { /* ignore */ }
    }
    const now = ctx.currentTime;
    const stopAt = now + durationMs / 1000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + 0.02);
    env.gain.setValueAtTime(1, stopAt - 0.04);
    env.gain.linearRampToValueAtTime(0, stopAt);
    env.connect(out);
    const oscs: OscillatorNode[] = freqs.map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(env);
      o.start(now);
      o.stop(stopAt);
      return o;
    });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try { env.gain.cancelScheduledValues(ctx.currentTime); } catch { /* */ }
      try { env.gain.setValueAtTime(0, ctx.currentTime); } catch { /* */ }
      for (const o of oscs) {
        try { o.stop(); } catch { /* already stopped */ }
        try { o.disconnect(); } catch { /* */ }
      }
      try { env.disconnect(); } catch { /* */ }
    };
  }

  /**
   * Start a looping cadence. Idempotent for the same kind; switching kind
   * stops the previous loop first.
   */
  start(kind: RingKind): void {
    if (this.active && this.active.kind === kind) return;
    if (this.active) this.stop();
    if (!this.ensureCtx()) return;

    let stopBeep: () => void = () => {};
    let phase = 0; // 0 = beep, 1 = silence
    const pattern = kind === 'incoming'
      // Ring-ring cadence: two short tones, then a longer pause.
      // [beepMs, silenceMs] alternating.
      ? [400, 200, 400, 2000]
      // Ringback: long beep, long silence (~classic 1s on / 3s off).
      : [1000, 3000];

    const tick = () => {
      const slot = pattern[phase % pattern.length];
      const isBeep = phase % 2 === 0;
      if (isBeep) {
        const freqs = kind === 'incoming' ? [440, 480] : [425];
        stopBeep = this.beep(freqs, slot);
      } else {
        stopBeep = () => {};
      }
      phase += 1;
    };

    // Drive immediately, then on a fixed interval matching the slot ahead.
    // We keep the interval simple (200ms tick) and gate inside tick() by
    // tracking elapsed time — but for clarity here we schedule each slot.
    const schedule = () => {
      tick();
      const slotMs = pattern[(phase - 1) % pattern.length];
      this.active!.cadenceId = setTimeout(schedule, slotMs) as unknown as ReturnType<typeof setInterval>;
    };
    this.active = {
      kind,
      cadenceId: 0 as unknown as ReturnType<typeof setInterval>,
      stopBeep: () => stopBeep(),
    };
    schedule();
  }

  stop(): void {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    try { clearTimeout(a.cadenceId as unknown as number); } catch { /* */ }
    try { a.stopBeep(); } catch { /* */ }
  }

  isPlaying(): boolean { return this.active !== null; }

  currentKind(): RingKind | null { return this.active?.kind ?? null; }
}

/** Singleton — one shared controller per browser tab. */
const controller = new RingtoneController();

export const ringtone = {
  start: (k: RingKind) => controller.start(k),
  stop: () => controller.stop(),
  isPlaying: () => controller.isPlaying(),
  currentKind: () => controller.currentKind(),
};