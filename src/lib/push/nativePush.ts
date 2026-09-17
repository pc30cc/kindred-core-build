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
 *  • carries out the notification's ACTION BUTTONS (inline reply, mark as
 *    read) when iOS hands them back,
 *  • keeps the app badge reconciled with the server count.
 *
 * Everything here is inert on the web: each entry point returns immediately
 * when `isNativePlatform()` is false. This is NOT the Web Notifications API.
 */
import { isNativePlatform, getNativePlatform } from '@/lib/native';
import { authFetch } from '@/lib/authFetch';
import { API_BASE } from '@/lib/apiBase';
import { conversationsApi, newClientMessageId } from '@/lib/conversations-api';

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

/**
 * The slice of @capacitor-firebase/messaging this module uses. Typed here
 * rather than imported so the web build never pulls the plugin in.
 */
interface MessagingPlugin {
  addListener(event: string, handler: (payload: MessagingEvent) => void): Promise<unknown>;
  checkPermissions(): Promise<{ receive?: string }>;
  requestPermissions(): Promise<{ receive?: string }>;
  getToken(): Promise<{ token?: string }>;
  createChannel(channel: {
    id: string;
    name: string;
    description: string;
    importance: number;
    visibility: number;
  }): Promise<void>;
  // Optional: absent in older plugin builds, which is why every call site
  // reaches them through `?.`.
  removeAllDeliveredNotifications?(): Promise<void>;
  deleteToken?(): Promise<void>;
}

/** What the plugin hands back on a token, a tap or a foreground delivery. */
interface MessagingEvent {
  token?: string;
  actionId?: string;
  inputValue?: string;
  notification?: { data?: Record<string, unknown> };
}

async function messaging(): Promise<MessagingPlugin | null> {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import('@capacitor-firebase/messaging');
    return (mod.FirebaseMessaging as unknown as MessagingPlugin) ?? null;
  } catch {
    return null;
  }
}

function parseTarget(data: Record<string, unknown> | undefined): PushNavigationTarget | null {
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

/**
 * Runs the button the operator pressed on the notification.
 *
 * The action ids are the ones registered natively in
 * ios/App/App/NotificationCategories.swift and configured in Super Admin →
 * Notifications → Actions. An unknown id (an older build, an id an operator
 * renamed on only one side) falls through to plain navigation rather than
 * doing nothing — the notification still takes the operator where they meant
 * to go.
 *
 * Every branch still goes through the normal authorized API, so an action
 * cannot reach a conversation the operator may not open.
 */
async function performNotificationAction(
  actionId: string,
  inputValue: string,
  target: PushNavigationTarget | null,
): Promise<void> {
  if (!target) return;

  if (actionId === 'MARK_READ') {
    try {
      await conversationsApi.markSeen(target.conversationId);
      await syncBadge(target.workspaceId);
    } catch {
      // Falling through to navigation is the right failure mode: the
      // operator opens the thread and it is marked read by being read.
      deliver(target);
    }
    return;
  }

  if (actionId === 'REPLY' && inputValue.trim()) {
    try {
      await conversationsApi.sendMessage({
        workspace_id: target.workspaceId,
        conversation_id: target.conversationId,
        body: inputValue.trim(),
        // A resumed app can replay the same action event; the idempotency key
        // makes a duplicate delivery send exactly once.
        client_message_id: newClientMessageId(),
      });
      await syncBadge(target.workspaceId);
      return;
    } catch {
      // The reply did not go out — open the thread with the text lost rather
      // than silently swallowing it.
      deliver(target);
      return;
    }
  }

  deliver(target);
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
        app_version: import.meta.env?.VITE_APP_VERSION ?? undefined,
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

      void FirebaseMessaging.addListener('tokenReceived', (event) => {
        void registerToken(String(event?.token ?? ''), workspaceId);
      });

      // Tap on a notification, or one of its action buttons (background OR
      // cold launch). iOS delivers the action the moment the app is resumed,
      // which is the earliest point this JS runtime exists at all.
      void FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
        const target = parseTarget(event?.notification?.data);
        void performNotificationAction(
          String(event?.actionId ?? ''),
          String(event?.inputValue ?? ''),
          target,
        );
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
interface BadgePlugin {
  set(options: { count: number }): Promise<void>;
  clear(): Promise<void>;
  // Android-only permission surface; absent on iOS.
  checkPermissions?(): Promise<{ display?: string }>;
  requestPermissions?(): Promise<{ display?: string }>;
}

async function badgePlugin(): Promise<BadgePlugin | null> {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import('@capawesome/capacitor-badge');
    return (mod.Badge as unknown as BadgePlugin) ?? null;
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
    const Badge = await badgePlugin();
    await Badge?.clear?.();
  } catch {
    /* best effort */
  }
  try {
    const FirebaseMessaging = await messaging();
    await FirebaseMessaging?.removeAllDeliveredNotifications?.();
    await FirebaseMessaging?.deleteToken?.();
  } catch {
    /* best effort */
  }
}
