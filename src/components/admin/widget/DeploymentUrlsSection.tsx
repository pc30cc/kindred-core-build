/**
 * DeploymentUrlsSection
 * ----------------------
 * Super-admin UI for managing the four widget URL bases that drive embed code,
 * loader, manifest, runtime asset, and API bootstrap. This is the single source
 * of truth — workspace install snippets and backend public widget config all
 * read from these values.
 */

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Globe, Link2, Server, Code2, Copy, Check, AlertTriangle,
  CheckCircle2, XCircle, Loader2, RefreshCw, PlayCircle,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import {
  resolveWidgetUrls,
  buildWidgetEmbedSnippet,
  type ResolvedWidgetUrls,
} from '@/lib/widgetEmbed';
import {
  testWidgetUrl,
  type WidgetUrlTestKind,
  type WidgetUrlTestResult,
} from '@/lib/widget-admin-api';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';

interface Props {
  settings: WidgetPlatformSettings;
  onSave: (patch: Partial<WidgetPlatformSettings>) => void;
  saving?: boolean;
}

interface UrlField {
  key: keyof WidgetPlatformSettings;
  label: string;
  description: string;
  placeholder: string;
  icon: React.ComponentType<{ className?: string }>;
}

const URL_FIELDS: UrlField[] = [
  {
    key: 'widget_loader_base_url',
    label: 'Widget Loader Base URL',
    description: 'Origin that hosts /widget/loader.js — the script your customers paste.',
    placeholder: 'https://widget.yourdomain.com',
    icon: Link2,
  },
  {
    key: 'widget_asset_base_url',
    label: 'Widget Asset Base URL',
    description: 'Origin that hosts the runtime, manifest, and stylesheet (usually same as loader).',
    placeholder: 'https://widget.yourdomain.com',
    icon: Globe,
  },
  {
    key: 'widget_public_base_url',
    label: 'Widget Public Base URL',
    description: 'Public-facing origin shown in install snippets and previews.',
    placeholder: 'https://widget.yourdomain.com',
    icon: Globe,
  },
  {
    key: 'widget_api_base_url',
    label: 'Widget API Base URL',
    description: 'Backend origin handling /api/widget/* (bootstrap, messages, attachments).',
    placeholder: 'https://api.yourdomain.com',
    icon: Server,
  },
];

type TestState = {
  loading: boolean;
  result: WidgetUrlTestResult | null;
};

function StatusBadge({ status }: { status?: WidgetUrlTestResult['status'] | 'idle' }) {
  if (!status || status === 'idle') return <Badge variant="outline" className="text-xs">Not tested</Badge>;
  if (status === 'success') return <Badge className="text-xs gap-1"><CheckCircle2 className="h-3 w-3" />Success</Badge>;
  if (status === 'warning') return <Badge variant="secondary" className="text-xs gap-1"><AlertTriangle className="h-3 w-3" />Warning</Badge>;
  return <Badge variant="destructive" className="text-xs gap-1"><XCircle className="h-3 w-3" />Failed</Badge>;
}

export function DeploymentUrlsSection({ settings, onSave, saving }: Props) {
  // Local draft so admins can edit multiple fields then save once.
  const [draft, setDraft] = useState({
    widget_loader_base_url: settings.widget_loader_base_url || '',
    widget_asset_base_url: settings.widget_asset_base_url || '',
    widget_public_base_url: settings.widget_public_base_url || '',
    widget_api_base_url: settings.widget_api_base_url || '',
  });
  const [tests, setTests] = useState<Record<WidgetUrlTestKind, TestState>>({
    loader: { loading: false, result: null },
    manifest: { loading: false, result: null },
    runtime: { loading: false, result: null },
    stylesheet: { loading: false, result: null },
    api_bootstrap: { loading: false, result: null },
    realtime: { loading: false, result: null },
  });
  const [copied, setCopied] = useState(false);

  // Re-sync draft when settings reload (e.g. after save).
  useEffect(() => {
    setDraft({
      widget_loader_base_url: settings.widget_loader_base_url || '',
      widget_asset_base_url: settings.widget_asset_base_url || '',
      widget_public_base_url: settings.widget_public_base_url || '',
      widget_api_base_url: settings.widget_api_base_url || '',
    });
  }, [settings.id, settings.updated_at]);

  // Live preview is computed from the local draft so the admin sees results
  // before saving. Persisted source of truth comes from `settings`.
  const urls: ResolvedWidgetUrls = useMemo(
    () => resolveWidgetUrls(draft, window.location.origin),
    [draft],
  );

  const embedSnippet = useMemo(
    () => buildWidgetEmbedSnippet(urls, { variant: 'script', workspaceId: 'YOUR_WORKSPACE_ID' }),
    [urls],
  );

  const isDirty = useMemo(() => {
    return (
      (draft.widget_loader_base_url || '') !== (settings.widget_loader_base_url || '') ||
      (draft.widget_asset_base_url || '') !== (settings.widget_asset_base_url || '') ||
      (draft.widget_public_base_url || '') !== (settings.widget_public_base_url || '') ||
      (draft.widget_api_base_url || '') !== (settings.widget_api_base_url || '')
    );
  }, [draft, settings]);

  const handleSave = () => {
    onSave({
      widget_loader_base_url: draft.widget_loader_base_url.trim() || null,
      widget_asset_base_url: draft.widget_asset_base_url.trim() || null,
      widget_public_base_url: draft.widget_public_base_url.trim() || null,
      widget_api_base_url: draft.widget_api_base_url.trim() || null,
    });
  };

  const handleReset = () => {
    setDraft({
      widget_loader_base_url: settings.widget_loader_base_url || '',
      widget_asset_base_url: settings.widget_asset_base_url || '',
      widget_public_base_url: settings.widget_public_base_url || '',
      widget_api_base_url: settings.widget_api_base_url || '',
    });
  };

  const runTest = async (kind: WidgetUrlTestKind, url: string) => {
    setTests((s) => ({ ...s, [kind]: { loading: true, result: null } }));
    try {
      const result = await testWidgetUrl({
        kind,
        url,
        asset_base: urls.assetBase,
        api_base: urls.apiBase,
      });
      setTests((s) => ({ ...s, [kind]: { loading: false, result } }));
    } catch (err: any) {
      setTests((s) => ({
        ...s,
        [kind]: {
          loading: false,
          result: {
            kind,
            url,
            status: 'failed',
            http_status: null,
            content_type: null,
            response_kind: null,
            duration_ms: null,
            message: err?.message || 'Request failed',
          },
        },
      }));
    }
  };

  const runAllTests = async () => {
    await Promise.all([
      runTest('loader', urls.loaderUrl),
      runTest('manifest', urls.manifestUrl),
      runTest('runtime', `${urls.runtimeBase}runtime.js`),
      runTest('stylesheet', urls.stylesheetUrl),
      runTest('api_bootstrap', urls.bootstrapUrl),
    ]);
  };

  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(embedSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: 'Copied', description: 'Embed snippet copied to clipboard' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      {/* ─── Base URL editors ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            Widget Deployment & URLs
          </CardTitle>
          <CardDescription>
            Single source of truth for all widget assets. Changes apply instantly to every workspace's
            install snippet — no per-workspace overrides.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {URL_FIELDS.map((field) => (
            <div key={field.key} className="space-y-2 rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <field.icon className="h-4 w-4 text-primary" />
                <Label className="text-sm font-medium">{field.label}</Label>
              </div>
              <p className="text-xs text-muted-foreground">{field.description}</p>
              <Input
                value={(draft[field.key as keyof typeof draft] as string) || ''}
                onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                className="font-mono text-xs"
              />
            </div>
          ))}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={handleReset} disabled={!isDirty || saving}>
              Reset
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!isDirty || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              Save URLs
            </Button>
          </div>

          {urls.hasMissing ? (
            <div className="flex items-start gap-2 bg-muted text-muted-foreground rounded-lg p-3 text-xs border border-border">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                Some URLs are unset. The system is using fallbacks for previews; embed code shown below may not
                reach a real deployment until you fill them in and save.
              </p>
            </div>
          ) : null}

          {urls.mismatches.length > 0 ? (
            <div className="space-y-2">
              {urls.mismatches.map((m, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 bg-destructive/10 text-destructive rounded-lg p-3 text-xs"
                >
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">{m.message}</p>
                    <p className="opacity-80 mt-0.5">{m.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ─── Computed URL previews + tests ─────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Computed URLs & Diagnostics</CardTitle>
            <CardDescription>
              Server-side checks. Each test fetches the URL from your backend (no browser CORS) and
              verifies the response is the right type.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={runAllTests} className="gap-1.5">
            <PlayCircle className="h-4 w-4" />
            Run all tests
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <UrlRow
            label="Loader URL"
            url={urls.loaderUrl}
            test={tests.loader}
            onTest={() => runTest('loader', urls.loaderUrl)}
          />
          <UrlRow
            label="Manifest URL"
            url={urls.manifestUrl}
            test={tests.manifest}
            onTest={() => runTest('manifest', urls.manifestUrl)}
          />
          <UrlRow
            label="Runtime URL (resolved via manifest)"
            url={`${urls.runtimeBase}runtime.js`}
            test={tests.runtime}
            onTest={() => runTest('runtime', `${urls.runtimeBase}runtime.js`)}
          />
          <UrlRow
            label="Stylesheet URL"
            url={urls.stylesheetUrl}
            test={tests.stylesheet}
            onTest={() => runTest('stylesheet', urls.stylesheetUrl)}
          />
          <UrlRow
            label="API Bootstrap URL"
            url={urls.bootstrapUrl}
            test={tests.api_bootstrap}
            onTest={() => runTest('api_bootstrap', urls.bootstrapUrl)}
          />
        </CardContent>
      </Card>

      {/* ─── Embed snippet ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Code2 className="h-4 w-4 text-primary" />
              Generated Widget Embed Code
            </CardTitle>
            <CardDescription>
              Live preview of the snippet workspaces will see in their Install tab. Replace
              <code className="mx-1 px-1 py-0.5 bg-muted rounded text-[11px]">YOUR_WORKSPACE_ID</code>
              with the workspace UUID.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={copyEmbed} className="gap-1.5">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </CardHeader>
        <CardContent>
          <Textarea
            readOnly
            value={embedSnippet}
            rows={8}
            className="font-mono text-xs bg-muted/40"
          />
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Single URL row with status + test button ────────────────────── */
function UrlRow({
  label,
  url,
  test,
  onTest,
}: {
  label: string;
  url: string;
  test: TestState;
  onTest: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="text-xs font-mono truncate text-foreground/90 mt-0.5">{url}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={test.result?.status} />
          <Button variant="outline" size="sm" onClick={onTest} disabled={test.loading} className="h-8 gap-1.5">
            {test.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Test
          </Button>
        </div>
      </div>
      {test.result ? (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2 space-y-1">
          <p className="text-foreground/90">{test.result.message}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] opacity-80">
            {test.result.http_status != null ? <span>HTTP {test.result.http_status}</span> : null}
            {test.result.content_type ? <span>{test.result.content_type}</span> : null}
            {test.result.duration_ms != null ? <span>{test.result.duration_ms}ms</span> : null}
            {test.result.response_kind ? <span>kind: {test.result.response_kind}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
