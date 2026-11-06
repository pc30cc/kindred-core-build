/**
 * The call-centre widget's request and ring-quiet limits
 * (callRequestLimiter.ts) as the route uses them. In the single process each
 * of these is the limiter's own function, on its own maps, as before. In a
 * cluster worker (docs/operations/BACKEND_PROCESSES.md) the limits are the
 * primary's, for the whole container, so a request, cancel, request loop
 * rings the phones once whichever worker answers it; without an answer from
 * the primary the worker counts in its own maps (and gives the primary's
 * share back if its answer comes late).
 */
import { hubActive, sharedCall, sharedSend } from '../../cluster/client.js';
import {
  giveBackCallRequest,
  mayRingForVisitor,
  takeCallRequest,
  type CallRequestDecision,
  type CallRequestTicket,
} from './callRequestLimiter.js';

/** A ticket, marked when it came from the primary (given back there). */
export type SharedCallRequestTicket = CallRequestTicket & { hub?: boolean };

export type SharedCallRequestDecision =
  | { ok: true; ticket: SharedCallRequestTicket }
  | { ok: false; retryAfterSeconds: number };

export async function takeSharedCallRequest(visitorKey: string | null, ipKey: string | null): Promise<SharedCallRequestDecision> {
  if (!hubActive()) return takeCallRequest(visitorKey, ipKey);
  let viaHub = true;
  const decision = await sharedCall<CallRequestDecision>('call.take', { visitorKey, ipKey }, () => takeCallRequest(visitorKey, ipKey), {
    fallback: () => {
      viaHub = false;
      return takeCallRequest(visitorKey, ipKey);
    },
    // The primary took a share after all, but this worker counted the call
    // here instead: give the primary's back, or the visitor's call counts twice.
    onLate: (late) => {
      if (late?.ok) giveBackSharedCallRequest({ ...late.ticket, hub: true });
    },
  });
  // The ticket carries the primary's `at`, which is what its give-back finds.
  return decision.ok && viaHub ? { ok: true, ticket: { ...decision.ticket, hub: true } } : decision;
}

export function giveBackSharedCallRequest(ticket: SharedCallRequestTicket): void {
  if (!ticket.hub) {
    giveBackCallRequest(ticket);
    return;
  }
  const { visitorKey, ipKey, at } = ticket;
  sharedSend('call.giveBack', { visitorKey, ipKey, at });
}

export function mayRingSharedForVisitor(visitorKey: string | null): Promise<boolean> {
  return sharedCall('call.mayRing', { visitorKey }, () => mayRingForVisitor(visitorKey));
}
