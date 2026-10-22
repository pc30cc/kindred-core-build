/**
 * Operator-side message notification chime.
 *
 * Fires a soft 2-note Web Audio chime when a visitor writes in a
 * conversation that is this operator's to answer: their own, an unassigned
 * one, or — for a supervisor watching "All conversations" — anyone's (the
 * banner's rule, passesScope). It used to chime for every visitor message in
 * the workspace, a colleague's chats included. Listens for the
 * `inbox:new-message` CustomEvent that `useInboxListRealtime` dispatches,
 * from the app shell, so it rings on every page, not only on the Inbox.
 *
 * Settings precedence (most authoritative first):
 *   1. localStorage `operator_message_sound_enabled` (per-device override).
 *      '0' / 'false' → muted regardless of server prefs.
 *      '1' / 'true'  → on regardless of server prefs.
 *   2. Server NotificationPrefs.disable_all       → muted
 *   3. Server NotificationPrefs.play_sound        → on/off
 *   4. Server NotificationPrefs.quiet_hours_*     → muted in window
 *   5. Server NotificationPrefs.push_scope        → which conversations
 *
 * Throttle: at most one chime per 1.5s (rapid bursts collapse).
 * Autoplay: AudioContext is created lazily and resumed on the first user
 * gesture; until then the chime is silently dropped (browser policy).
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationPrefs } from '@/lib/notifications-api';
import { passesScope, resolveAssignee } from './operatorBrowserNotification';

const LS_KEY = 'operator_message_sound_enabled';
const THROTTLE_MS = 1500;

let audioCtx: AudioContext | null = null;
let lastPlayedAt = 0;

function ensureAudioCtx(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

function readLocalOverride(): boolean | null {
  try {
    const v = window.localStorage.getItem(LS_KEY);
    if (v === null) return null;
    if (v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
    return null;
  } catch {
    return null;
  }
}

/** Per-device mute toggle (used by the inbox header icon). */
export function getOperatorMessageSoundEnabled(): boolean {
  const local = readLocalOverride();
  if (local !== null) return local;
  return true; // default ON — server prefs may still mute it.
}
export function setOperatorMessageSoundEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch { /* swallow */ }
  try { window.dispatchEvent(new CustomEvent('operator-message-sound-changed', { detail: { enabled } })); } catch { /* swallow */ }
}

function isInQuietHours(prefs: NotificationPrefs | null | undefined): boolean {
  if (!prefs?.quiet_hours_enabled) return false;
  const start = prefs.quiet_hours_start;
  const end = prefs.quiet_hours_end;
  if (!start || !end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (Number.isNaN(sh) || Number.isNaN(sm) || Number.isNaN(eh) || Number.isNaN(em)) return false;
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e; // wraps midnight
}

function playChime() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state !== 'running') return; // autoplay-blocked → silent
  try {
    const t0 = ctx.currentTime;
    // Soft pleasant 2-note chime: E5 → A5.
    const notes = [
      { f: 659.25, at: 0.0,  dur: 0.18 },
      { f: 880.0,  at: 0.12, dur: 0.22 },
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, t0 + n.at);
      gain.gain.setValueAtTime(0.0001, t0 + n.at);
      gain.gain.exponentialRampToValueAtTime(0.10, t0 + n.at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.02);
    }
  } catch { /* swallow */ }
}

/**
 * The chime, at most once per THROTTLE_MS (a message and an assignment that
 * arrive together ring once). Silent until a user gesture unlocked audio.
 */
export function playOperatorChime(): void {
  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  lastPlayedAt = now;
  playChime();
}

/**
 * Whether the operator's sound settings let the chime ring now (the device's
 * own switch, then "disable all", "play a sound" and quiet hours).
 */
export function chimeAllowedByPrefs(prefs: NotificationPrefs | null | undefined): boolean {
  const local = readLocalOverride();
  if (local === false) return false;
  if (prefs) {
    if (prefs.disable_all) return false;
    if (!prefs.play_sound) return false;
    if (isInQuietHours(prefs)) return false;
  }
  return true;
}

/**
 * Mount once at the workspace shell (useOperatorInboxAlerts). Subscribes to
 * the `inbox:new-message` window event and plays the chime when allowed.
 */
export function useOperatorMessageChime(
  workspaceId: string | undefined,
  options: { viewerId?: string; othersVisible?: () => boolean } = {},
): void {
  const qc = useQueryClient();
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Lazy unlock — first user gesture resumes the AudioContext.
    const unlock = () => { ensureAudioCtx(); };
    const unlockOpts: AddEventListenerOptions = { capture: true, passive: true, once: false };
    window.addEventListener('pointerdown', unlock, unlockOpts);
    window.addEventListener('keydown', unlock, unlockOpts);
    window.addEventListener('touchstart', unlock, unlockOpts);

    const onIncoming = async (evt: Event) => {
      const detail = (evt as CustomEvent<{
        workspaceId?: string;
        conversation_id?: string;
        sender_type?: string;
      }>).detail;
      if (!detail || !wsRef.current) return;
      if (detail.workspaceId && detail.workspaceId !== wsRef.current) return;
      // Only chime for visitor messages — not echoes of agent/AI replies.
      if (detail.sender_type && detail.sender_type !== 'contact') return;

      // Server-side preferences (the shell keeps them in the React Query
      // cache, so there is no network round-trip per event).
      const cached = qc.getQueryData<{ prefs: NotificationPrefs }>(['notification-prefs']);
      const prefs = cached?.prefs ?? null;
      if (!chimeAllowedByPrefs(prefs)) return;

      // Whose conversation it is: a colleague's chats are theirs.
      const { viewerId, othersVisible } = optionsRef.current;
      const conversationId = detail.conversation_id ? String(detail.conversation_id) : '';
      const assignee = conversationId
        ? await resolveAssignee(qc, wsRef.current, conversationId)
        : undefined;
      if (!passesScope(prefs?.push_scope ?? 'all', assignee, viewerId, othersVisible?.() ?? false)) return;

      playOperatorChime();
    };
    const listener = (evt: Event) => { void onIncoming(evt); };

    window.addEventListener('inbox:new-message', listener);
    return () => {
      window.removeEventListener('inbox:new-message', listener);
      window.removeEventListener('pointerdown', unlock, unlockOpts);
      window.removeEventListener('keydown', unlock, unlockOpts);
      window.removeEventListener('touchstart', unlock, unlockOpts);
    };
  }, [qc]);
}