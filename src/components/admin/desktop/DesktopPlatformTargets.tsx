/**
 * Which desktop apps an ad, an announcement or a broadcast reaches.
 *
 * Shared by the Windows and the macOS panels: campaigns and broadcasts are
 * one pool on the server, each row carrying `platforms` — an empty list means
 * every desktop app, so "nothing ticked" and "everything ticked" read the
 * same way here.
 */
import { Apple, Monitor, MonitorSmartphone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { DESKTOP_PLATFORMS, type DesktopPlatform } from '@/hooks/useDesktopApp';
import { cn } from '@/lib/utils';

const ICON = { windows: Monitor, macos: Apple } as const;

/** Empty, or every app listed, both mean "all desktop apps". */
const reachesAllPlatforms = (platforms: DesktopPlatform[] | null | undefined) => {
  const list = platforms ?? [];
  return list.length === 0 || DESKTOP_PLATFORMS.every((p) => list.includes(p));
};

export function PlatformBadge({ platforms }: { platforms: DesktopPlatform[] | null | undefined }) {
  const { t } = useTranslation();
  if (reachesAllPlatforms(platforms)) {
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <MonitorSmartphone className="h-3 w-3" />
        {t('admin.desktopApp.platforms.all')}
      </Badge>
    );
  }
  return (
    <>
      {(platforms ?? []).map((p) => {
        const Icon = ICON[p];
        return (
          <Badge key={p} variant="outline" className="gap-1 font-normal">
            <Icon className="h-3 w-3" />
            {t(`admin.desktopApp.platforms.${p}`)}
          </Badge>
        );
      })}
    </>
  );
}

/** The "Show on" control of the campaign editor: one checkbox per app, none ticked = both. */
export function PlatformTargetPicker({
  value,
  onChange,
}: {
  value: DesktopPlatform[];
  onChange: (value: DesktopPlatform[]) => void;
}) {
  const { t } = useTranslation();
  const toggle = (p: DesktopPlatform, on: boolean) =>
    onChange(on ? DESKTOP_PLATFORMS.filter((x) => x === p || value.includes(x)) : value.filter((x) => x !== p));

  return (
    <div className="grid gap-2">
      <Label className="flex items-center gap-1.5">
        <MonitorSmartphone className="h-4 w-4" />
        {t('admin.desktopApp.platforms.showOn')}
      </Label>
      <div className="flex flex-wrap gap-2">
        {DESKTOP_PLATFORMS.map((p) => {
          const Icon = ICON[p];
          const checked = value.includes(p);
          return (
            <label
              key={p}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm',
                checked ? 'border-primary bg-primary/10 text-primary' : 'border-border/70',
              )}
            >
              <Checkbox checked={checked} onCheckedChange={(v) => toggle(p, v === true)} />
              <Icon className="h-4 w-4" />
              {t(`admin.desktopApp.platforms.${p}`)}
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {reachesAllPlatforms(value) ? t('admin.desktopApp.platforms.showOnAll') : t('admin.desktopApp.platforms.showOnHint')}
      </p>
    </div>
  );
}
