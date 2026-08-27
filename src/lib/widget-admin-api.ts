import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
export type WidgetUrlTestKind =
  | 'loader'
  | 'manifest'
  | 'runtime'
  | 'stylesheet'
  | 'api_bootstrap'
  | 'realtime';

export interface WidgetUrlTestResult {
  kind: WidgetUrlTestKind;
  url: string;
  status: 'success' | 'warning' | 'failed';
  http_status: number | null;
  content_type: string | null;
  response_kind: 'js' | 'json' | 'css' | 'html' | 'other' | null;
  duration_ms: number | null;
  message: string;
  details?: Record<string, any>;
}

function apiBase(): string {
  // Backend lives at the same origin in the standard self-host deployment.
  // This call goes through the platform admin API only — never embedded code.
  return RESOLVED_API_BASE || window.location.origin;
}

export async function testWidgetUrl(input: {
  kind: WidgetUrlTestKind;
  url: string;
  asset_base?: string;
  api_base?: string;
}): Promise<WidgetUrlTestResult> {
  const res = await fetch(`${apiBase()}/api/admin/widget/test-url`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Test failed (${res.status})`);
  }
  return res.json();
}
