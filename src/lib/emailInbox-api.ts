/**
 * Email Inbox — workspace-scoped API client. Auth is the first-party
 * gs_session HttpOnly cookie (credentials: 'include'), same convention as
 * seo-api.ts / webAnalytics-api.ts. Backs `/api/email-inbox/*`
 * (server/routes/emailInbox.ts) — NOT `/api/email/*`, which is a different,
 * pre-existing outbound-only transactional email surface.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

export interface EmailThreadSummary {
  id: string;
  provider: string;
  subject: string | null;
  participants: Array<{ email: string }>;
  lastMessageAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  lastMessageSnippet: string | null;
}

export interface EmailAttachmentView {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  contentId: string | null;
  url: string | null;
}

export interface EmailMessageView {
  id: string;
  externalMessageId: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  toAddresses: Array<{ email: string }>;
  ccAddresses: Array<{ email: string }>;
  bccAddresses: Array<{ email: string }>;
  textBody: string | null;
  htmlBody: string | null;
  snippet: string | null;
  isRead: boolean;
  deliveryStatus: 'queued' | 'sent' | 'failed';
  deliveryError: string | null;
  sentAt: string;
  attachments: EmailAttachmentView[];
}

export interface StagedEmailAttachment {
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export class EmailInboxApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, body: any) {
    const code = typeof body?.error === 'string' ? body.error : 'email_inbox_request_failed';
    super(code);
    this.name = 'EmailInboxApiError';
    this.status = status;
    this.code = code;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw new EmailInboxApiError(res.status, body);
  return body as T;
}

function safeJson(t: string): any {
  try { return JSON.parse(t); } catch { return null; }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export function listEmailThreads(
  workspaceId: string,
  opts: { limit?: number; before?: string; unread?: boolean; starred?: boolean; q?: string } = {},
) {
  return api<{ threads: EmailThreadSummary[]; nextBefore: string | null }>(
    `/api/email-inbox/${workspaceId}/threads${qs(opts)}`,
  );
}

export function getEmailThread(workspaceId: string, threadId: string) {
  return api<{ thread: EmailThreadSummary; messages: EmailMessageView[] }>(
    `/api/email-inbox/${workspaceId}/threads/${threadId}`,
  );
}

export function setEmailThreadRead(workspaceId: string, threadId: string, isRead: boolean) {
  return api<{ ok: true }>(`/api/email-inbox/${workspaceId}/threads/${threadId}/read`, {
    method: 'POST',
    body: JSON.stringify({ is_read: isRead }),
  });
}

export function setEmailThreadStarred(workspaceId: string, threadId: string, starred: boolean) {
  return api<{ ok: true }>(`/api/email-inbox/${workspaceId}/threads/${threadId}/star`, {
    method: 'POST',
    body: JSON.stringify({ starred }),
  });
}

export async function uploadEmailAttachment(workspaceId: string, file: File): Promise<StagedEmailAttachment> {
  const qsStr = qs({ filename: file.name, content_type: file.type || 'application/octet-stream' });
  const res = await fetch(`${API_BASE}/api/email-inbox/${workspaceId}/attachments${qsStr}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw new EmailInboxApiError(res.status, body);
  return body as StagedEmailAttachment;
}

export interface SendEmailInput {
  threadId?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  attachments?: StagedEmailAttachment[];
}

export function sendEmail(workspaceId: string, input: SendEmailInput) {
  return api<{ messageId: string }>(`/api/email-inbox/${workspaceId}/send`, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: input.threadId ?? null,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text_body: input.textBody,
      html_body: input.htmlBody,
      attachments: input.attachments,
    }),
  });
}

// ── Gmail connection (server/routes/plugins.ts) ─────────────────────────

export interface GmailConnectionInfo {
  connected: boolean;
  emailAddress: string | null;
  status: 'pending' | 'connected' | 'disconnected' | 'error' | null;
  lastErrorCode: string | null;
  connectedAt: string | null;
}

export function getGmailConnection(workspaceId: string) {
  return api<{ connection: GmailConnectionInfo; platformConfigured: boolean }>(
    `/api/plugins/gmail/connection${qs({ workspace_id: workspaceId })}`,
  );
}

export function startGmailOAuth(workspaceId: string) {
  return api<{ url: string }>('/api/plugins/gmail/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
}

export function disconnectGmail(workspaceId: string) {
  return api<{ ok: true }>('/api/plugins/gmail/disconnect', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
}

// ── Yahoo Mail connection (server/routes/plugins.ts) ────────────────────

export interface YahooConnectionInfo {
  connected: boolean;
  emailAddress: string | null;
  status: 'pending' | 'connected' | 'disconnected' | 'error' | null;
  lastErrorCode: string | null;
  connectedAt: string | null;
}

export function getYahooConnection(workspaceId: string) {
  return api<{ connection: YahooConnectionInfo; platformConfigured: boolean }>(
    `/api/plugins/yahoo/connection${qs({ workspace_id: workspaceId })}`,
  );
}

export function startYahooOAuth(workspaceId: string) {
  return api<{ url: string }>('/api/plugins/yahoo/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
}

export function disconnectYahoo(workspaceId: string) {
  return api<{ ok: true }>('/api/plugins/yahoo/disconnect', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
}
