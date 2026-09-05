/**
 * FIREBASE CLOUD MESSAGING TRANSPORT (HTTP v1).
 *
 * The ONLY place in the codebase that talks to Google. Everything else goes
 * through `dispatch.ts`.
 *
 * Deliberate choices:
 *  • No Cloud Functions, no Firebase Auth, no Firebase database. FCM is used
 *    purely as a push transport for iOS (via APNs) and Android.
 *  • Credentials are read from the server environment ONLY — never shipped in
 *    the app bundle, never stored in the database, never logged.
 *  • A self-signed service-account JWT is exchanged for a short-lived OAuth
 *    access token, cached in memory until shortly before it expires. That
 *    keeps the dependency surface at `jsonwebtoken` (already a server dep)
 *    instead of pulling the whole firebase-admin SDK into the deployable.
 *  • Every failure is returned, never thrown at the caller's critical path:
 *    push is best-effort and must never affect message ingestion.
 */
import jwt from 'jsonwebtoken';

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export type FcmSendOutcome =
  | { ok: true }
  | { ok: false; unregistered: boolean; status: number; error: string };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedCreds: FcmCredentials | null | undefined;

/**
 * Reads credentials from env. Accepts either the whole service-account JSON
 * (FIREBASE_SERVICE_ACCOUNT_JSON, optionally base64) or the three discrete
 * fields. Returns null when push is simply not configured — that is a valid
 * deployment state, not an error.
 */
export function getFcmCredentials(): FcmCredentials | null {
  if (cachedCreds !== undefined) return cachedCreds;
  cachedCreds = loadCredentials();
  return cachedCreds;
}

/** Test seam: forget the memoized credentials/access token. */
export function resetFcmCredentialCache(): void {
  cachedCreds = undefined;
  accessToken = null;
}

function loadCredentials(): FcmCredentials | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (raw) {
    try {
      const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const json = JSON.parse(text) as Record<string, string>;
      if (json.project_id && json.client_email && json.private_key) {
        return {
          projectId: json.project_id,
          clientEmail: json.client_email,
          privateKey: normalizeKey(json.private_key),
        };
      }
    } catch {
      // Never log the value: it contains a private key.
      console.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON is not valid service-account JSON');
      return null;
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey: normalizeKey(privateKey) };
  }
  return null;
}

function normalizeKey(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

export function isPushConfigured(): boolean {
  return getFcmCredentials() !== null;
}

let accessToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(creds: FcmCredentials): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (accessToken && accessToken.expiresAt - 60 > now) return accessToken.value;

  const assertion = jwt.sign(
    { scope: SCOPE },
    creds.privateKey,
    {
      algorithm: 'RS256',
      issuer: creds.clientEmail,
      subject: creds.clientEmail,
      audience: TOKEN_URL,
      expiresIn: 3600,
    },
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    // Body can contain the assertion echo — log only status.
    console.error('[push] google token exchange failed', { status: res.status });
    return null;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  accessToken = {
    value: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600),
  };
  return accessToken.value;
}

export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  /** Identifiers ONLY. Never tokens, credentials or private metadata. */
  data: Record<string, string>;
  badge?: number;
  sound?: boolean;
  collapseKey?: string;
  androidChannelId?: string;
}

export async function sendFcmMessage(msg: FcmMessage): Promise<FcmSendOutcome> {
  const creds = getFcmCredentials();
  if (!creds) return { ok: false, unregistered: false, status: 0, error: 'push_not_configured' };

  let token: string | null;
  try {
    token = await getAccessToken(creds);
  } catch (err) {
    return { ok: false, unregistered: false, status: 0, error: safeError(err) };
  }
  if (!token) return { ok: false, unregistered: false, status: 0, error: 'no_access_token' };

  const payload = {
    message: {
      token: msg.token,
      notification: { title: msg.title, body: msg.body },
      data: msg.data,
      android: {
        priority: 'HIGH',
        collapse_key: msg.collapseKey,
        notification: {
          channel_id: msg.androidChannelId ?? 'webyar_messages',
          sound: msg.sound === false ? undefined : 'default',
festival: undefined,
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          ...(msg.collapseKey ? { 'apns-collapse-id': msg.collapseKey.slice(0, 64) } : {}),
        },
        payload: {
          aps: {
            alert: { title: msg.title, body: msg.body },
            sound: msg.sound === false ? undefined : 'default',
            badge: msg.badge,
            'mutable-content': 1,
          },
        },
      },
    },
  };

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(creds.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    if (res.ok) return { ok: true };

    const text = await res.text();
    // UNREGISTERED (404) and INVALID_ARGUMENT on the token (400) mean the
    // device address is dead: the caller disables it instead of retrying.
    const unregistered =
      res.status === 404 ||
      /UNREGISTERED|NOT_FOUND|registration-token-not-registered|INVALID_ARGUMENT/i.test(text);
    return {
      ok: false,
      unregistered,
      status: res.status,
      error: text.slice(0, 300),
    };
  } catch (err) {
    return { ok: false, unregistered: false, status: 0, error: safeError(err) };
  }
}

function safeError(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 300);
}
