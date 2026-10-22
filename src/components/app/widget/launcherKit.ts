/**
 * Which kit button the workspace's visitors get (public/widget/loader.js
 * applyFabConfig): the Iran kit's in the Iranian edition, RESPOK's in the
 * International edition of a build that ships it, else the plain launcher.
 * One rule for the live preview and Widget → Appearance (the size label, the
 * "Brand colour" swatch). Both kit buttons are 60px at 100%, the plain one
 * 56px.
 */
import { useEdition } from '@/hooks/useEdition';
import { useWebyarKit } from '@/lib/webyarBrand';
import { SHIPS_INTL_KIT, SHIPS_IRAN_KIT } from '../../../../shared/buildBrand';
import { LOCAL_KIT_LAUNCHER_BASE_SIZE } from '../../../../shared/localKitLauncher';
import { RESPOK_LAUNCHER_BASE_SIZE } from '../../../../shared/respokLauncher';
import type { WidgetColorKit } from '../../../../shared/widgetColor';

/** The plain launcher's size at 100% (loader.js). */
export const PLAIN_LAUNCHER_BASE_SIZE = 56;

export interface LauncherKit {
  /** The Iranian edition wears the local kit's button (SHIPS_IRAN_KIT: the RESPOK build never). */
  localKit: boolean;
  /** The International edition wears RESPOK's button, where the build ships it. */
  respokKit: boolean;
  /** The kit, as shared/widgetColor.ts names it. */
  kit: WidgetColorKit;
  /** The button's size at 100%, in px. */
  baseSize: number;
}

export function useLauncherKit(): LauncherKit {
  const { isInternational } = useEdition();
  // Known, never assumed: an edition not known yet keeps the plain look.
  const iranKitEdition = useWebyarKit();
  const localKit = SHIPS_IRAN_KIT && iranKitEdition && !isInternational;
  const respokKit = SHIPS_INTL_KIT && isInternational;
  return {
    localKit,
    respokKit,
    kit: localKit ? 'iran' : respokKit ? 'respok' : null,
    baseSize: localKit ? LOCAL_KIT_LAUNCHER_BASE_SIZE : respokKit ? RESPOK_LAUNCHER_BASE_SIZE : PLAIN_LAUNCHER_BASE_SIZE,
  };
}
