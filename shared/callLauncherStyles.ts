/**
 * The call widget's launcher styles and placements (the 2026-10 call widget
 * design, boards 01 and 02 of both brands; migration 277).
 *
 * `call_center_settings.launcher_style` names one of nine launchers (L1–L9)
 * and `widget_position` one of five placements. The column checks only the
 * shape of a style (`^[a-z][a-z_]{0,31}$`), so a style added here needs no
 * migration; this list is what a save may store and what the bootstrap sends.
 *
 * Shared by the server (the public bootstrap sends the resolved values, the
 * settings PUT validates what it stores), the dashboard (the picker and the
 * live preview) and, by the same rule, the widget's engine
 * (public/call-widget/runtime.js `position()`): a stored spelling from before
 * the five placements (`bottom-left`, …) is read as its placement, anything
 * else as `right`, which is where it always rendered.
 *
 * Pure: no I/O, no Node or DOM API.
 */

export const CALL_LAUNCHER_STYLES = [
  'round',
  'round_label',
  'pill',
  'card',
  'split',
  'edge_tab',
  'dark_square',
  'operator_face',
  'mobile_bar',
] as const;
export type CallLauncherStyle = (typeof CALL_LAUNCHER_STYLES)[number];

/** A row without a style, or with one this build does not know. */
export const DEFAULT_CALL_LAUNCHER_STYLE: CallLauncherStyle = 'round_label';

export const CALL_WIDGET_POSITIONS = ['right', 'left', 'top_right', 'top_left', 'bottom_center'] as const;
export type CallWidgetPosition = (typeof CALL_WIDGET_POSITIONS)[number];

/** Any stored value that is not a placement or one of its spellings. */
export const DEFAULT_CALL_WIDGET_POSITION: CallWidgetPosition = 'right';

/**
 * Every spelling a stored `widget_position` may have, and its placement.
 * The same table as runtime.js's POSITION_ALIASES (a test keeps them equal).
 */
export const CALL_WIDGET_POSITION_ALIASES: Readonly<Record<string, CallWidgetPosition>> = Object.freeze({
  right: 'right',
  'bottom-right': 'right',
  bottom_right: 'right',
  left: 'left',
  'bottom-left': 'left',
  bottom_left: 'left',
  top_right: 'top_right',
  'top-right': 'top_right',
  top_left: 'top_left',
  'top-left': 'top_left',
  bottom_center: 'bottom_center',
  'bottom-center': 'bottom_center',
  center: 'bottom_center',
});

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export function isCallLauncherStyle(value: unknown): value is CallLauncherStyle {
  return typeof value === 'string' && (CALL_LAUNCHER_STYLES as readonly string[]).includes(value);
}

/** The placement a stored `widget_position` means: a placement, its old spelling, else `right`. */
export function normalizeCallWidgetPosition(raw: unknown): CallWidgetPosition {
  return typeof raw === 'string' && hasOwn(CALL_WIDGET_POSITION_ALIASES, raw)
    ? CALL_WIDGET_POSITION_ALIASES[raw]
    : DEFAULT_CALL_WIDGET_POSITION;
}

/** The style a stored `launcher_style` means: a known style, else `round_label`. */
export function normalizeCallLauncherStyle(raw: unknown): CallLauncherStyle {
  return isCallLauncherStyle(raw) ? raw : DEFAULT_CALL_LAUNCHER_STYLE;
}

/**
 * The launcher a workspace's row asks for, as the bootstrap sends it. The
 * renderer still adapts it to the screen (`mobile_bar` exists only on phones,
 * `round_label` becomes the pill there, `operator_face` without an operator
 * is `round_label`): those depend on the visitor's device and presence, not
 * on the row.
 */
export function resolveCallLauncher(row: { launcher_style?: unknown; widget_position?: unknown } | null | undefined): {
  style: CallLauncherStyle;
  position: CallWidgetPosition;
} {
  return {
    style: normalizeCallLauncherStyle(row?.launcher_style),
    position: normalizeCallWidgetPosition(row?.widget_position),
  };
}

/** The edge tab's side: the right edge for `right`, `top_right` and `bottom_center`, the left for the others. */
export function callEdgeTabSide(position: unknown): 'left' | 'right' {
  const p = normalizeCallWidgetPosition(position);
  return p === 'left' || p === 'top_left' ? 'left' : 'right';
}

/**
 * Styles that draw the operators who are available (names and photos): the
 * bootstrap publishes `presence.operators` only for these, so staff names and
 * photos appear on a customer's site only when its admin chose such a style.
 */
export function callLauncherNeedsPresence(style: unknown): boolean {
  return style === 'card' || style === 'operator_face';
}
