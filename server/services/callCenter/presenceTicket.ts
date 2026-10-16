/**
 * "This visitor was just seen": a signed, 60-second cookie that lets the call
 * widget bootstrap skip its visitor database work on the next page views.
 *
 * Every bootstrap used to read visitor_sessions, visitor_presence,
 * widget_settings, contacts and call_sessions (7-8 round trips, plus a
 * contact re-pin UPDATE for identified visitors) only to find that nothing
 * had changed: the session and presence rows are written at most once a
 * minute anyway (SESSION_TOUCH_MS in services/widget/crossWidgetIdentity.ts).
 * After a full pass the response carries this ticket; while it is valid —
 * same workspace, same visitor cookie, same network, under 60 s old — the
 * next bootstrap answers from it with no visitor query at all (one primary-key
 * read of the contact for an identified visitor's pre-fill).
 *
 * Stateless (HMAC), so it holds across processes and regions. It grants
 * nothing: it only lets the server skip work it would have found unchanged.
 * A browser without third-party cookies never sends it (and gets a new
 * visitor each page view anyway).
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { ServerConfig } from '../../config.js';
import { isSecureRequest } from '../widget/visitorIdentity.js';

export const PRESENCE_TICKET_COOKIE = 'dvccp';
export const PRESENCE_TICKET_TTL_SECONDS = 60;
const COOKIE_PATH = '/api/call-widget/bootstrap';

export interface PresenceTicket {
  /** workspace id */ w: string;
  /** visitor id (dvsid) */ v: string;
  /** visitor_sessions.id */ s: string;
  /** hashIp() of the request's address ('' = unknown) */ h: string;
  /** linked contact id, or null */ c: string | null;
  /** issued at, unix seconds */ t: number;
}

type OptionalSecrets = { widgetTokenSecret?: string; sessionSecret?: string };
function secret(config: ServerConfig): string {
  const s = config as ServerConfig & OptionalSecrets;
  return `call-widget-presence:${s.widgetTokenSecret || s.sessionSecret || config.signingSecret || config.supabaseServiceRoleKey}`;
}
function sign(config: ServerConfig, body: string): string {
  return crypto.createHmac('sha256', secret(config)).update(body).digest('base64url');
}

export function issuePresenceTicket(res: Response, req: Request, config: ServerConfig, ticket: Omit<PresenceTicket, 't'>): void {
  const body = Buffer.from(JSON.stringify({ ...ticket, t: Math.floor(Date.now() / 1000) })).toString('base64url');
  const secure = isSecureRequest(req);
  const attrs = [
    `${PRESENCE_TICKET_COOKIE}=${body}.${sign(config, body)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    `Max-Age=${PRESENCE_TICKET_TTL_SECONDS}`,
    `SameSite=${secure ? 'None' : 'Lax'}`,
  ];
  if (secure) attrs.push('Secure', 'Partitioned');
  res.append('Set-Cookie', attrs.join('; '));
}

/** The request's ticket when it is genuine, unexpired and for this visitor on this network. */
export function readPresenceTicket(
  req: Request,
  config: ServerConfig,
  expect: { workspaceId: string; visitorId: string; ipHash: string },
): PresenceTicket | null {
  const raw = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[PRESENCE_TICKET_COOKIE];
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const sig = Buffer.from(raw.slice(dot + 1));
  const good = Buffer.from(sign(config, body));
  if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PresenceTicket;
    const age = Math.floor(Date.now() / 1000) - Number(t.t);
    if (!(age >= 0 && age < PRESENCE_TICKET_TTL_SECONDS)) return null;
    if (t.w !== expect.workspaceId || t.v !== expect.visitorId || t.h !== expect.ipHash || !t.s) return null;
    return t;
  } catch {
    return null;
  }
}
