/**
 * Platform-owned "Powered by" footer configuration.
 *
 * Only platform admins reach this surface — workspace owners can no longer set
 * a branding name for the widget footer. Visibility per customer is decided in
 * Plans via the `widget_powered_by` feature toggle; this screen owns the master
 * switch, the wording and the outbound link.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';

interface Props {
  settings: WidgetPlatformSettings;
  onSave: (patch: Partial<WidgetPlatformSettings>) => void;
  saving: boolean;
}

export function PoweredBySection({ settings, onSave, saving }: Props) {
  const [enabled, setEnabled] = useState(settings.powered_by_enabled ?? true);
  const [text, setText] = useState(settings.powered_by_text ?? '');
  const [brand, setBrand] = useState(settings.powered_by_brand_text ?? '');
  const [url, setUrl] = useState(settings.powered_by_url ?? '');

  useEffect(() => {
    setEnabled(settings.powered_by_enabled ?? true);
    setText(settings.powered_by_text ?? '');
    setBrand(settings.powered_by_brand_text ?? '');
    setUrl(settings.powered_by_url ?? '');
  }, [settings]);

  const urlInvalid = url.trim().length > 0 && !/^https?:\/\//i.test(url.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Widget "Powered by" footer</CardTitle>
        <CardDescription>
          Platform-only branding shown at the bottom of the chat widget. Workspace owners cannot
          change or remove it. To hide it for specific customers, turn off the{' '}
          <span className="font-medium">Show Widget "Powered by" Footer</span> feature on their plan —
          when hidden, the widget content extends to the bottom edge.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-border p-4 bg-muted/20">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">Master switch</Label>
            <p className="text-xs text-muted-foreground">
              When off, no widget shows the footer regardless of plan.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Prefix text</Label>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Powered by"
            />
            <p className="text-[11px] text-muted-foreground">
              Leave empty to use the widget's localized default ("Powered by").
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Brand label</Label>
            <Input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Your platform name"
            />
            <p className="text-[11px] text-muted-foreground">
              Empty falls back to the platform name from Platform Branding.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Link URL</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
          />
          <p className="text-[11px] text-muted-foreground">
            Opened in a new tab when a visitor clicks the footer. Must start with http:// or
            https://. Leave empty to make the footer non-clickable. The link is rendered as a
            native <code>nofollow</code> anchor on every customer site.
          </p>
          {urlInvalid && (
            <p className="text-[11px] text-destructive">Enter a full URL starting with https://</p>
          )}
          {!urlInvalid && /^http:\/\//i.test(url.trim()) && (
            <p className="text-[11px] text-amber-600">
              HTTPS is strongly recommended — an http:// destination may be blocked or downgraded
              on secure customer sites.
            </p>
          )}

        </div>

        <div className="rounded-lg border border-border p-4 bg-background">
          <p className="text-[11px] text-muted-foreground mb-2">Preview</p>
          <p className="text-xs">
            {(text.trim() || 'Powered by') + ' ' + (brand.trim() || 'Platform name')}
          </p>
        </div>

        <Button
          size="sm"
          disabled={saving || urlInvalid}
          onClick={() =>
            onSave({
              powered_by_enabled: enabled,
              powered_by_text: text.trim(),
              powered_by_brand_text: brand.trim() || null,
              powered_by_url: url.trim() || null,
            })
          }
        >
          {saving ? 'Saving…' : 'Save footer settings'}
        </Button>
      </CardContent>
    </Card>
  );
}
