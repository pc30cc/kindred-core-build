/**
 * Super Admin's email templates API (server/routes/adminManagement.ts,
 * /api/admin/management/email-templates…): the running edition's rows, the
 * catalog of every template the platform keeps, and a template's preview
 * and test, both rendered by the server's email core.
 *
 * Nothing here knows a brand: the catalog's descriptions are translation
 * keys, and the sample values a preview is filled with stay on the server
 * (the frontend bundle of one brand may not carry the other's words).
 */

import { API_BASE } from '@/lib/apiBase';
import type { Edition } from '../../../shared/edition';

export type EmailTemplateCategory = 'auth' | 'transactional' | 'notification' | 'billing';

export interface EmailTemplateCatalogItem {
  slug: string;
  category: EmailTemplateCategory;
  /** `sent`: the platform sends it; `legacy`: kept in the table, nothing sends it. */
  status: 'sent' | 'legacy';
  kind: 'transactional' | 'notification' | 'marketing';
  /** Its placeholders as a row writes them, its sender's and the core's. */
  variables: string[];
  editions: Edition[];
  /** False for a mail this edition never sends (the saved card's, in the Iranian edition). */
  sentInEdition: boolean;
  descriptionKey: string;
}

export interface EmailTemplateCatalog {
  edition: Edition;
  /** The languages this platform offers, and the one a mail falls back to when its own row is missing. */
  locales: { offered: string[]; fallback: string };
  templates: EmailTemplateCatalogItem[];
}

export interface PlatformEmailTemplate {
  id: string;
  workspace_id: string | null;
  slug: string;
  locale: string;
  subject: string;
  html_body: string;
  text_body: string | null;
  is_active: boolean | null;
}

/** A template being tried: the text being edited, or (none of it) the saved row. */
export interface EmailTemplateTry {
  slug: string;
  locale: string;
  subject?: string;
  html_body?: string;
  text_body?: string | null;
}

export interface EmailTemplatePreview {
  subject: string;
  /** A whole document: drawn in a sandboxed iframe's srcDoc, never into the page. */
  html: string;
  text: string;
  /** What the content holds that a platform mail must not send (codes, e.g. `foreign_link`). */
  problems: string[];
}

export interface EmailTemplateTestResult {
  success: boolean;
  sent_to: string;
}

export class EmailTemplatesApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const BASE = '/api/admin/management/email-templates';

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({})) as { error?: unknown; error_code?: unknown };
  if (!res.ok) {
    // A failed test names the provider's refusal (error_code); every other refusal its own code.
    const code = typeof body.error_code === 'string' ? body.error_code : typeof body.error === 'string' ? body.error : `http_${res.status}`;
    throw new EmailTemplatesApiError(code, res.status);
  }
  return body as T;
}

export function fetchEmailTemplateCatalog(): Promise<EmailTemplateCatalog> {
  return call<EmailTemplateCatalog>('/catalog');
}

export function fetchPlatformEmailTemplates(): Promise<{ templates: PlatformEmailTemplate[]; edition?: Edition }> {
  return call<{ templates: PlatformEmailTemplate[]; edition?: Edition }>('');
}

export function createPlatformEmailTemplate(row: {
  slug: string;
  locale: string;
  subject: string;
  html_body: string;
  text_body: string | null;
  is_active: boolean;
}): Promise<{ template: PlatformEmailTemplate }> {
  return call<{ template: PlatformEmailTemplate }>('', { method: 'POST', body: JSON.stringify(row) });
}

export function updatePlatformEmailTemplate(
  id: string,
  row: { subject: string; html_body: string; text_body: string | null; is_active: boolean },
): Promise<{ template: PlatformEmailTemplate }> {
  return call<{ template: PlatformEmailTemplate }>(`/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(row) });
}

export function deletePlatformEmailTemplate(id: string): Promise<{ success: boolean }> {
  return call<{ success: boolean }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function previewEmailTemplate(
  input: EmailTemplateTry & { scheme?: 'light' | 'dark' },
  signal?: AbortSignal,
): Promise<EmailTemplatePreview> {
  return call<EmailTemplatePreview>('/preview', { method: 'POST', body: JSON.stringify(input), signal });
}

export function sendEmailTemplateTest(input: EmailTemplateTry): Promise<EmailTemplateTestResult> {
  return call<EmailTemplateTestResult>('/test-send', { method: 'POST', body: JSON.stringify(input) });
}
