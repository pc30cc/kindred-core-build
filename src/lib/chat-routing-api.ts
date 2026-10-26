import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
import { SettingsRequestError } from '@/lib/settingsErrors';
import {
  INACTIVITY_CLOSE_DEFAULT_HOURS,
  INACTIVITY_CLOSE_MAX_HOURS,
  INACTIVITY_CLOSE_MIN_HOURS,
} from '../../shared/inactivityClose';
/**
 * Chat routing, as the workspace panel reads and sets it (migration 278,
 * server/services/chatRouting.ts):
 *
 *   - the Super Admin's platform rules as they apply to this workspace's
 *     chats (read only): GET /api/workspace-departments/:id/routing-policy;
 *   - one member's "Receive chats automatically" switch and their own
 *     maximum of open chats (null = the workspace default):
 *     PATCH /api/workspace-members/:memberId/chat-routing.
 *
 * The workspace-wide settings (assignment mode, returning visitors, default
 * maximum, first-response timeout, the inactivity close) are widget settings
 * (PATCH /api/widget-settings/:workspaceId).
 */

const API_BASE = RESOLVED_API_BASE || '';

/** The platform rules that change what a workspace's chat routing does. */
export interface ChatRoutingPlatformPolicy {
  /** A department with nobody available hands its chats to the whole team. */
  general_pool_enabled: boolean;
  /** Off: no workspace returns visitors to their previous operator. */
  last_agent_routing_enabled: boolean;
  /** The owner is the last resort for a chat nobody else could take. */
  owner_fallback_for_chat: boolean;
  /**
   * Off: no workspace's conversation closes for inactivity (migration 284).
   * Absent from older servers.
   */
  inactivity_close_enabled?: boolean;
  /** The hours a workspace without its own window follows (1–48). */
  inactivity_close_default_hours?: number;
}

export interface MemberChatRouting {
  receives_chats?: boolean;
  /** 1–50; null = the workspace default. */
  max_concurrent_chats?: number | null;
}

/** Bounds the server enforces (widget_settings and workspace_members checks). */
export const CHAT_CAPACITY_MIN = 1;
export const CHAT_CAPACITY_MAX = 50;
export const LAST_AGENT_WINDOW_MIN = 1;
export const LAST_AGENT_WINDOW_MAX = 365;
export const FIRST_RESPONSE_TIMEOUT_MIN = 0;
export const FIRST_RESPONSE_TIMEOUT_MAX = 60;
/** The inactivity close's window in hours, and its default (shared/inactivityClose.ts). */
export { INACTIVITY_CLOSE_MIN_HOURS, INACTIVITY_CLOSE_MAX_HOURS, INACTIVITY_CLOSE_DEFAULT_HOURS };
/** The server's defaults when a workspace never saved one. */
export const DEFAULT_CHAT_CAPACITY = 5;
export const DEFAULT_LAST_AGENT_WINDOW_DAYS = 30;
export const DEFAULT_FIRST_RESPONSE_TIMEOUT_MINUTES = 5;

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  // The code and the status, for a sentence in the panel's language (settingsErrorMessage).
  if (!res.ok) throw new SettingsRequestError((body as { error?: string }).error || `HTTP ${res.status}`, res.status);
  return body as T;
}

export async function getChatRoutingPolicy(workspaceId: string): Promise<ChatRoutingPlatformPolicy> {
  const { policy } = await jsonFetch<{ policy: ChatRoutingPlatformPolicy }>(
    `/api/workspace-departments/${workspaceId}/routing-policy`,
  );
  return policy;
}

export async function updateMemberChatRouting(
  workspaceId: string,
  memberId: string,
  patch: MemberChatRouting,
): Promise<{ id: string; user_id: string; receives_chats: boolean; max_concurrent_chats: number | null }> {
  const { member } = await jsonFetch<{
    member: { id: string; user_id: string; receives_chats: boolean; max_concurrent_chats: number | null };
  }>(`/api/workspace-members/${memberId}/chat-routing?workspaceId=${workspaceId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return member;
}

/**
 * A whole number typed into a routing field, or null when it is empty, or
 * `undefined` when it is not a whole number within [min, max].
 */
export function parseRoutingNumber(raw: string, min: number, max: number): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  // Persian and Arabic-Indic digits count as digits too.
  const latin = text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/^\d+$/.test(latin)) return undefined;
  const n = Number(latin);
  return n >= min && n <= max ? n : undefined;
}
