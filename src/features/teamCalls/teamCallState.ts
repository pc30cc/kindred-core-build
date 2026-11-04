/**
 * The colleague call's shared state (TeamCallContext.tsx): its types, the
 * React context, and the helpers the call button and the call screens read.
 * Kept apart from the provider so that file exports only its component.
 */
import { createContext, useContext } from 'react';
import type { TranslationKey } from '@/i18n';
import type { TeamCall, TeamCallChannel, TeamCallPeer } from '@/lib/team-calls-api';

export type TeamCallPhase =
  /** The caller's POST is in flight. */
  | 'placing'
  /**
   * Placed and ringing on the server: "Calling…" until a phone or tab of the
   * colleague rang (`call.rang_at`), then "Ringing…" with the ringback.
   */
  | 'outgoing'
  /** Ringing in this tab. */
  | 'incoming'
  /** This tab's accept is in flight. */
  | 'answering'
  /** Answered: joining the room. */
  | 'connecting'
  /** In the room. */
  | 'active'
  /** Over: the window shows why for a moment, then closes. */
  | 'ended';

export interface TeamCallSession {
  /** This tab's own handle of the session (a call id is known only once placed). */
  key: string;
  /** The call as the server last answered it; null while it is being placed. */
  call: TeamCall | null;
  role: 'caller' | 'callee';
  channel: TeamCallChannel;
  peer: TeamCallPeer;
  workspaceId: string;
  phase: TeamCallPhase;
  /** Publish the camera when joining (a video call, unless answered without it). */
  withCamera: boolean;
  /** The line the ended window shows. */
  notice: { key: TranslationKey; params?: Record<string, string> } | null;
}

export interface TeamCallContextValue {
  session: TeamCallSession | null;
  /** From the call button (a click): asks for notifications once, then rings the colleague. */
  placeCall(input: { workspaceId: string; peer: TeamCallPeer; channel: TeamCallChannel }): Promise<void>;
  answer(withCamera: boolean): Promise<void>;
  decline(): Promise<void>;
  hangUp(): Promise<void>;
  /** The call window: the room is joined. */
  markJoined(): void;
  /** The call window: the room could not be joined; ends the call. */
  failJoin(err: unknown): Promise<void>;
  /** Closes an ended window now. */
  dismiss(): void;
  /** The ringing card: it is on screen for [callId] (sends `rang` once per call). */
  ringShown(callId: string): void;
}

export const TeamCallContext = createContext<TeamCallContextValue | null>(null);

/** The colleague-call controls, or null outside the app shell (the phone shell has none). */
export function useTeamCall(): TeamCallContextValue | null {
  return useContext(TeamCallContext);
}

/** The colleague's name as the call shows it. */
export function peerDisplayName(peer: TeamCallPeer | null | undefined, fallback: string): string {
  const name = peer?.name?.trim();
  return name || fallback;
}
