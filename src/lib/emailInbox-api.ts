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
  /** Gmail only: the thread's historyId — a cached body is valid while it is unchanged. */
  historyId?: string | null;
  messageCount?: number;
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

export interface EmailThreadPage {
  threads: EmailThreadSummary[];
  nextBefore: string | null;
  /** Gmail pagination cursor for the next page. */
  nextPageToken?: string | null;
  /** Gmail mailbox cursor for `/changes`. */
  historyId?: string | null;
  syncing?: boolean;
}

export function listEmailThreads(
  workspaceId: string,
  opts: { limit?: number; before?: string; pageToken?: string; unread?: boolean; starred?: boolean; q?: string } = {},
) {
  const { pageToken, ...rest } = opts;
  return api<EmailThreadPage>(`/api/email-inbox/${workspaceId}/threads${qs({ ...rest, page_token: pageToken })}`);
}

export function getEmailChanges(workspaceId: string, since: string) {
  return api<{ historyId: string | null; threadIds: string[]; reset: boolean }>(
    `/api/email-inbox/${workspaceId}/changes${qs({ since })}`,
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
  /** Live (Gmail) inbox: files sent with the reply itself, never stored. */
  inlineAttachments?: Array<{ filename: string; contentType: string; dataBase64: string }>;
}

export function sendEmail(workspaceId: string, input: SendEmailInput) {
  return api<{ messageId: string; threadId?: string }>(`/api/email-inbox/${workspaceId}/send`, {
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
      inline_attachments: input.inlineAttachments?.map((a) => ({
        filename: a.filename,
        content_type: a.contentType,
        data_base64: a.dataBase64,
      })),
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

/** Reads a file as base64 for an inline (not staged) attachment. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
