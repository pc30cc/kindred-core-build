/**
 * NATIVE PUSH CLIENT (Capacitor — iOS today, Android ready).
 *
 * A thin, platform-agnostic wrapper around @capacitor-firebase/messaging:
 *  • asks for the OS permission (separate from Webyar's own preferences),
 *  • obtains the FCM token (on iOS the plugin registers with APNs first and
 *    exchanges the APNs token for an FCM token — no APNs code in JS),
 *  • registers/rotates it against the Webyar backend using the existing
 *    authenticated mobile session,
 *  • routes a notification tap to the exact conversation,
 *  • keeps the app badge reconciled with the server count.
 *
 * Everything here is inert on the web: each entry point returns immediately
 * when `isNativePlatform()` is false. This is NOT the Web Notifications API.
 */
import { isNativePlatform, getNativePlatform } from '@/lib/native';
import { authFetch } from '@/lib/authFetch';
import { API_BASE } from '@/lib/apiBase';

const DEVICE_ID_KEY = 'webyar.push.deviceId';

export interface PushNavigationTarget {
  workspaceId: string;
  conversationId: string;
  messageId?: string;
}

type NavHandler = (target: PushNavigationTarget) => void;

let navHandler: NavHandler | null = null;
let pendingTarget: PushNavigationTarget | null = null;
let initialized = false;
let currentDeviceId: string | null = null;

/** Stable per-install id. Not a credential — only an upsert key. */
function deviceId(): string {
  if (currentDeviceId) return currentDeviceId;
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    /* storage unavailable */
  }
  if (!id) {
    id = `${getNativePlatform()}-${crypto.randomUUID()}`;
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      /* ephemeral id for this launch */
    }
  }
  currentDeviceId = id;
  return id;
}

async function messaging(): Promise<any | null> {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import('@capacitor-firebase/messaging');
    return (mod as any).FirebaseMessaging ?? null;
  } catch {
    return null;
  }
}

function parseTarget(data: Record<string, any> | undefined): PushNavigationTarget | null {
  if (!data) return null;
  const workspaceId = String(data.workspaceId ?? '');
  const conversationId = String(data.conversationId ?? '');
  if (!workspaceId || !conversationId) return null;
  // Routing hint ONLY — the app still loads the conversation through the
  // normal authorized API, which re-checks workspace access.
  return { workspaceId, conversationId, messageId: data.messageId ? String(data.messageId) : undefined };
}

/** Registered by the mobile shell; replays a cold-start tap. */
export function setPushNavigationHandler(handler: NavHandler | null): void {
  navHandler = handler;
  if (handler && pendingTarget) {
    const target = pendingTarget;
    pendingTarget = null;
    handler(target);
  }
}

function deliver(target: PushNavigationTarget | null): void {
  if (!target) return;
  if (navHandler) navHandler(target);
  else pendingTarget = target; // cold launch: replay once the router mounts
}

async function registerToken(token: string, workspaceId?: string | null): Promise<void> {
  if (!token) return;
  try {
    await authFetch(`${API_BASE}/api/push/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        platform: getNativePlatform() === 'android' ? 'android' : 'ios',
        push_token: token,
        device_id: deviceId(),
        device_name: navigator.userAgent.slice(0, 120),
        app_version: (import.meta as any).env?.VITE_APP_VERSION ?? undefined,
        permission_status: 'granted',
        workspace_id: workspaceId ?? undefined,
      }),
    });
  } catch {
    // Registration is retried on the next app launch / token refresh.
  }
}

/**
 * Full native push setup. Safe to call repeatedly (idempotent) and safe to
 * call before the user has a workspace.
 */
export async function initNativePush(workspaceId?: string | null): Promise<void> {
  const FirebaseMessaging = await messaging();
  if (!FirebaseMessaging) return;

  try {
    if (!initialized) {
      initialized = true;

      FirebaseMessaging.addListener('tokenReceived', (event: any) => {
        void registerToken(String(event?.token ?? ''), workspaceId);
      });

      // Tap on a notification (background OR cold launch).
      FirebaseMessaging.addListener('notificationActionPerformed', (event: any) => {
        deliver(parseTarget(event?.notification?.data));
      });

      // Foreground delivery: realtime already updated the UI, so we do NOT
      // create a second message event here — we only refresh the badge.
      FirebaseMessaging.addListener('notificationReceived', () => {
        void syncBadge(workspaceId);
      });

      if (getNativePlatform() === 'android') {
        try {
          await FirebaseMessaging.createChannel({
            id: 'webyar_messages',
            name: 'Messages',
            description: 'New customer messages',
            importance: 5,
            visibility: 1,
          });
        } catch {
          /* channel already exists */
        }
      }
    }

    const perm = await FirebaseMessaging.checkPermissions();
    let status = perm?.receive;
    if (status !== 'granted') {
      const asked = await FirebaseMessaging.requestPermissions();
      status = asked?.receive;
    }
    if (status !== 'granted') return;

    const { token } = await FirebaseMessaging.getToken();
    await registerToken(String(token ?? ''), workspaceId);
    await syncBadge(workspaceId);
  } catch (err) {
    console.warn('[push] native init failed', err);
  }
}

/**
 * App icon badge. @capacitor-firebase/messaging has NO setBadge — the badge is
 * owned by a dedicated plugin (@capawesome/capacitor-badge), so reconciliation
 * (read on another device, resolved thread) really clears the icon instead of
 * silently doing nothing.
 */
async function badgePlugin(): Promise<any | null> {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import('@capawesome/capacitor-badge');
    return (mod as any).Badge ?? null;
  } catch {
    return null;
  }
}

/** Server-authoritative badge — never a blind local increment. */
export async function syncBadge(workspaceId?: string | null): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const url = new URL(`${API_BASE}/api/push/badge`, window.location.origin);
    if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
    const res = await authFetch(url.toString(), { credentials: 'include' });
    if (!res.ok) return;
    const body = (await res.json()) as { badge?: number };
    const count = Math.max(0, Number(body?.badge ?? 0) || 0);

    const Badge = await badgePlugin();
    if (Badge) {
      try {
        const perm = await Badge.checkPermissions?.();
        if (perm && perm.display !== 'granted') await Badge.requestPermissions?.();
      } catch {
        /* Android-only permission surface */
      }
      if (count > 0) await Badge.set({ count });
      else await Badge.clear();
    }

    if (count === 0) {
      const FirebaseMessaging = await messaging();
      try {
        await FirebaseMessaging?.removeAllDeliveredNotifications?.();
      } catch {
        /* nothing delivered */
      }
    }
  } catch {
    /* badge drift is corrected on the next sync */
  }
}

/** Logout: disable THIS device only; auth sessions are handled elsewhere. */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await authFetch(`${API_BASE}/api/push/devices/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ device_id: deviceId() }),
    });
  } catch {
    /* best effort */
  }
  try {
    const FirebaseMessaging = await messaging();
    await FirebaseMessaging?.setBadge?.({ count: 0 });
    await FirebaseMessaging?.deleteToken?.();
  } catch {
    /* best effort */
  }
}
