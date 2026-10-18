/**
 * The chat widget launcher's styles (issue #340, g5-1; WebYar board 11
 * «دکمه شناور», RESPOK board 10 "Chat button"): `fab.shape` circle |
 * square | pill and `fab.icon`, today's seven glyphs plus three styles,
 * bubble (the classic bubble), duo (two bubbles) and avatar (the agent's
 * face: the first operator's initial and a presence dot). The pill carries
 * `fab.label` inside it instead of the card beside the launcher.
 *
 * Shared by the server (GET /config normalises what it sends, the settings
 * PATCH validates what it stores) and the dashboard's picker. A launcher
 * wearing a style (a pill, or one of the three new glyphs) takes its look
 * from public/widget/runtime-fab.css, which /config names (`fabStyleUrl`)
 * only then, so no other page view downloads a byte more. Everything here
 * sits under the plan capability `widget_launcher_icon`, as the icon choice
 * always did.
 */

export const FAB_SHAPES = ['circle', 'square', 'pill'] as const;
export type FabShape = (typeof FAB_SHAPES)[number];

/** Today's glyphs (the loader's FAB_ICONS), then the styles runtime-fab.css draws. */
export const FAB_ICON_IDS = ['chat', 'message', 'help', 'headset', 'phone', 'sparkles', 'smile', 'bubble', 'duo', 'avatar'] as const;
export type FabIconId = (typeof FAB_ICON_IDS)[number];

/** The glyphs only runtime-fab.css draws. */
export const STYLED_FAB_ICONS: readonly FabIconId[] = ['bubble', 'duo', 'avatar'];

export interface LauncherStyle {
  shape: FabShape;
  icon: FabIconId;
  /** Whether the launcher needs runtime-fab.css (a pill, or a styled glyph). */
  styled: boolean;
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * What a workspace's launcher wears, from its stored columns: an unknown
 * icon (a value an older client stored, "constructor") reads as `chat`, an
 * unknown shape as `circle`, and a pill without a text as `circle`.
 */
export function resolveLauncherStyle(input: { shape?: unknown; icon?: unknown; label?: unknown }): LauncherStyle {
  const icon: FabIconId = isOneOf(FAB_ICON_IDS, input.icon) ? input.icon : 'chat';
  let shape: FabShape = isOneOf(FAB_SHAPES, input.shape) ? input.shape : 'circle';
  if (shape === 'pill' && !(typeof input.label === 'string' && input.label.trim())) shape = 'circle';
  return { shape, icon, styled: shape === 'pill' || STYLED_FAB_ICONS.includes(icon) };
}

/**
 * The agent face's letter: the first character (a whole code point) of the
 * first name that has one, in order (the team, online first, then the
 * workspace's name); '' when none has.
 */
export function launcherInitial(names: ReadonlyArray<string | null | undefined>): string {
  for (const name of names) {
    const first = Array.from(String(name || '').trim())[0];
    if (first) return first;
  }
  return '';
}

/**
 * The two drawn glyphs, in a 24-unit box: what runtime-fab.css masks the
 * launcher's colour with (inline SVG, a test checks they agree) and what the
 * dashboard's picker draws. The bubble's dots and the bubble are one
 * even-odd path, so the dots are holes the launcher's own colour shows
 * through (the boards' dot colour); the duo's back bubble is an outline at
 * 75% opacity behind the filled front one.
 */
export const LAUNCHER_GLYPHS = {
  bubble: 'M12 3.6c4.9 0 8.8 3.3 8.8 7.6s-3.9 7.6-8.8 7.6c-.9 0-1.8-.1-2.7-.3l-4.5 1.9 1-3.8c-1.7-1.4-2.6-3.3-2.6-5.4 0-4.3 3.9-7.6 8.8-7.6ZM7.05 11.2a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0ZM10.75 11.2a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0ZM14.45 11.2a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0Z',
  duoBack: 'M14.5 6.5V6a2.5 2.5 0 0 0-2.5-2.5H5.5A2.5 2.5 0 0 0 3 6v5a2.5 2.5 0 0 0 2.5 2.5H6v2.4l2.6-2.2',
  duoFront: 'M9.5 11a2.5 2.5 0 0 1 2.5-2.5h6.5A2.5 2.5 0 0 1 21 11v4.5a2.5 2.5 0 0 1-2.5 2.5H18v2.6L14.8 18H12a2.5 2.5 0 0 1-2.5-2.5z',
} as const;

/** The agent face's colours (board 11): the disc, its letter, the online dot. */
export const LAUNCHER_AVATAR = { disc: '#FCE3D4', ink: '#8A3410', online: '#16A34A' } as const;

// ─── The dashboard's tiles (WebYar board 11, RESPOK board 10) ────────────
// new-hooks-and-settings.md §1's mapping: the brand kit's button (RESPOK's
// Open and Thread logos also set the template option logoDirection), the
// kit's square, the bubble, two bubbles, the headset, the agent's face,
// the pill. The other icons are not tiles.

export type LauncherTile = 'kit' | 'open' | 'thread' | 'square' | 'bubble' | 'duo' | 'headset' | 'avatar' | 'pill';
export type LogoDirection = 'thread' | 'open';

/** What a tile writes. `label` only when the pill needs a text; `logoDirection` only for RESPOK's Open / Thread. */
export interface LauncherStyleChoice {
  shape: FabShape;
  icon?: FabIconId;
  label?: string;
  logoDirection?: LogoDirection;
}

const TILE_ICONS: readonly string[] = ['bubble', 'duo', 'headset', 'avatar'];

/** The selected tile for what the row holds; null for one of the other icons. */
export function launcherTileOf(shape: string | null | undefined, icon: string | null | undefined, logo: LogoDirection | null): LauncherTile | null {
  if (shape === 'pill') return 'pill';
  const i = icon || 'chat';
  if (TILE_ICONS.includes(i)) return i as LauncherTile;
  if (i !== 'chat') return null;
  if (shape === 'square') return 'square';
  return logo || 'kit';
}

/** What choosing a tile writes. The pill keeps the icon and, without a text, gets the default one. */
export function launcherChoiceOf(tile: LauncherTile, label: string | null | undefined, pillDefault: string): LauncherStyleChoice {
  switch (tile) {
    case 'pill':
      return (label || '').trim() ? { shape: 'pill' } : { shape: 'pill', label: pillDefault };
    case 'square':
      return { shape: 'square', icon: 'chat' };
    case 'open':
    case 'thread':
      return { shape: 'circle', icon: 'chat', logoDirection: tile };
    case 'kit':
      return { shape: 'circle', icon: 'chat' };
    default:
      return { shape: 'circle', icon: tile };
  }
}
