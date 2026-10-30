/**
 * Super Admin → Branding → Visual identity: the platform's logo (for light
 * and for dark backgrounds) and its symbol, uploaded once and read
 * everywhere (owner, 2026-10-30): the panel, the chat and call widgets'
 * "powered by", the help center, the emails, the tab and home-screen icons
 * (server/services/platformBrandAssets.ts, src/lib/brandAssets.ts).
 *
 * Each control shows its file on a light and a dark tile, or the brand's
 * default (its kit) when nothing was uploaded, and puts the default back.
 * The PNG copies the server needs (the email logo, the icons) are drawn here
 * from the same file (src/lib/brandRaster.ts) and uploaded with it. The dark
 * logo is the light one's partner: it waits for a light one, and resetting
 * the light logo resets both.
 */
import { useRef, useState } from 'react';
import { ImageUp, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { brandAssetsView, useBrandAssets } from '@/lib/brandAssets';
import { prepareLogoUpload, prepareSymbolUpload } from '@/lib/brandRaster';
import {
  usePlatformBrandAssets,
  useResetPlatformBrandAsset,
  useUploadPlatformBrandAsset,
  type PlatformBrandAssetVariant,
} from '@/hooks/usePlatformBranding';

/** server/services/platformBrandUpload.ts MAX_BRAND_FILE_BYTES. */
const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = '.svg,.png,.webp,image/svg+xml,image/png,image/webp';

/** What went wrong, in words: the server's error codes and the drawing's own. */
const ERRORS: Record<string, TranslationKey> = {
  file_too_large: 'admin.brandingPage.identity.errorTooLarge',
  unsupported_type: 'admin.brandingPage.identity.errorType',
  svg_not_allowed: 'admin.brandingPage.identity.errorSvg',
  svg_no_size: 'admin.brandingPage.identity.errorSvgSize',
  image_unreadable: 'admin.brandingPage.identity.errorUnreadable',
  png_invalid: 'admin.brandingPage.identity.errorUnreadable',
  logo_light_required: 'admin.brandingPage.identity.errorNeedsLight',
};

function Tile({ src, dark, symbol, label }: { src: string | null; dark: boolean; symbol: boolean; label: string }) {
  return (
    <div className="flex-1 min-w-0 space-y-1">
      <div
        className={cn(
          'flex h-20 items-center justify-center rounded-lg border p-3',
          dark ? 'border-slate-700 bg-[#12141F]' : 'border-slate-200 bg-white',
        )}
      >
        {src ? (
          <img
            src={src}
            alt=""
            draggable={false}
            className={symbol ? 'h-12 w-12 object-contain' : 'h-10 max-w-full w-auto object-contain'}
          />
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

interface Row {
  variant: PlatformBrandAssetVariant;
  label: TranslationKey;
  hint: TranslationKey;
  /** The file shown: the upload, else the brand's default. */
  src: string | null;
  uploaded: boolean;
  disabled?: boolean;
}

export function BrandAssetUploads({ background }: { background?: string | null }) {
  const { t } = useTranslation();
  const { data: uploaded } = usePlatformBrandAssets();
  const { kit } = useBrandAssets();
  const upload = useUploadPlatformBrandAsset();
  const reset = useResetPlatformBrandAsset();
  const [busy, setBusy] = useState<PlatformBrandAssetVariant | null>(null);
  const inputs = useRef<Partial<Record<PlatformBrandAssetVariant, HTMLInputElement | null>>>({});
  // The brand's default: this edition's kit, never the cached upload.
  const fallback = brandAssetsView(null, kit);
  const custom = uploaded ?? null;

  const rows: Row[] = [
    {
      variant: 'logo-light',
      label: 'admin.brandingPage.identity.logoLight',
      hint: 'admin.brandingPage.identity.logoLightHint',
      src: custom?.logo_light ?? fallback.lockup?.light ?? null,
      uploaded: !!custom?.logo_light,
    },
    {
      variant: 'logo-dark',
      label: 'admin.brandingPage.identity.logoDark',
      hint: 'admin.brandingPage.identity.logoDarkHint',
      src: custom?.logo_dark ?? custom?.logo_light ?? fallback.lockup?.dark ?? null,
      uploaded: !!custom?.logo_dark,
      disabled: !custom?.logo_light,
    },
    {
      variant: 'symbol',
      label: 'admin.brandingPage.identity.symbol',
      hint: 'admin.brandingPage.identity.symbolHint',
      src: custom?.symbol ?? fallback.symbol ?? null,
      uploaded: !!custom?.symbol,
    },
  ];

  const fail = (code: string) => {
    toast({
      title: t('admin.brandingPage.identity.assetFailed'),
      description: t(ERRORS[code] ?? 'admin.brandingPage.identity.errorGeneric'),
      variant: 'destructive',
    });
  };

  const onFile = async (variant: PlatformBrandAssetVariant, file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) return fail('file_too_large');
    setBusy(variant);
    try {
      const prepared = variant === 'symbol'
        ? await prepareSymbolUpload(file, background || '#FFFFFF')
        : await prepareLogoUpload(file);
      await upload.mutateAsync({ variant, upload: prepared });
      toast({ title: t('admin.brandingPage.identity.assetSaved') });
    } catch (err) {
      fail(err instanceof Error ? err.message : '');
    } finally {
      setBusy(null);
      const input = inputs.current[variant];
      if (input) input.value = '';
    }
  };

  const onReset = async (variant: PlatformBrandAssetVariant) => {
    setBusy(variant);
    try {
      await reset.mutateAsync(variant);
      toast({ title: t('admin.brandingPage.identity.assetReset') });
    } catch (err) {
      fail(err instanceof Error ? err.message : '');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5" data-brand-assets>
      {rows.map((row) => (
        <div key={row.variant} className="space-y-2" data-brand-asset={row.variant}>
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-sm font-medium text-foreground">{t(row.label)}</Label>
            {!row.uploaded && <Badge variant="secondary">{t('admin.brandingPage.identity.kitDefault')}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{t(row.hint)}</p>
          <div className="flex gap-3">
            <Tile src={row.src} dark={false} symbol={row.variant === 'symbol'} label={t('admin.brandingPage.identity.onLight')} />
            <Tile src={row.src} dark symbol={row.variant === 'symbol'} label={t('admin.brandingPage.identity.onDark')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={(el) => { inputs.current[row.variant] = el; }}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => void onFile(row.variant, e.target.files?.[0])}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || row.disabled}
              onClick={() => inputs.current[row.variant]?.click()}
            >
              {busy === row.variant ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <ImageUp className="h-4 w-4 me-1" />}
              {t(row.uploaded ? 'admin.brandingPage.identity.replace' : 'admin.brandingPage.identity.upload')}
            </Button>
            {row.uploaded && (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onReset(row.variant)}>
                <RotateCcw className="h-4 w-4 me-1" />
                {t('admin.brandingPage.identity.reset')}
              </Button>
            )}
            {row.disabled && <p className="text-[11px] text-muted-foreground">{t('admin.brandingPage.identity.errorNeedsLight')}</p>}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">{t('admin.brandingPage.identity.emailNote')}</p>
    </div>
  );
}
