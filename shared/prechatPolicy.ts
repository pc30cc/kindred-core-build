/**
 * The pre-chat form a visitor is actually asked: one rule for the server
 * (GET /identity/me, GET and POST /identity/prechat, the workspace's PUT),
 * the widget's fallback and the workspace panel.
 *
 * Three levels decide each field (name, email, phone):
 *
 *   1. The Super Admin's platform policy (widget_platform_settings
 *      prechat_<field>_policy): `force_on` = always asked and required,
 *      `force_off` = never asked, `default_on` / `default_off` = what a
 *      workspace that never saved its form gets.
 *   2. The plan: without `widget_prechat_form` the workspace's own form does
 *      not apply. The visitor is then asked only what the Super Admin forces
 *      on (and nothing at all when nothing is forced), never a form the owner
 *      can no longer see or change.
 *   3. The workspace's row (widget_prechat_settings), when the plan allows it.
 *
 * A field is required only when it is asked (V-01): a hidden field can never
 * block the visitor. Migration 280 also keeps that true in the table.
 *
 * Pure: no I/O.
 */

export const PRECHAT_FIELDS = ['name', 'email', 'phone'] as const;
export type PrechatField = (typeof PRECHAT_FIELDS)[number];

export const PRECHAT_TIMINGS = ['always', 'after_handoff', 'never'] as const;
export type PrechatTiming = (typeof PRECHAT_TIMINGS)[number];

export type PreChatPolicyMode = 'force_on' | 'force_off' | 'default_on' | 'default_off';
export type PreChatPolicy = Record<PrechatField, PreChatPolicyMode>;

/** The columns' defaults (migration 044) when the platform row is missing or unreadable. */
export const DEFAULT_PRECHAT_POLICY: Readonly<PreChatPolicy> = {
  name: 'default_on',
  email: 'default_on',
  phone: 'default_off',
};

/** What a visitor's widget is told about the form (the /identity/me `prechat` shape). */
export interface EffectivePrechat {
  ask_name: boolean;
  ask_email: boolean;
  ask_phone: boolean;
  require_name: boolean;
  require_email: boolean;
  require_phone: boolean;
  verify_email: boolean;
  verify_phone: boolean;
  timing: PrechatTiming;
}

/** The stored row's fields this module reads (widget_prechat_settings). */
export interface PrechatSettingsRow {
  ask_name?: boolean | null;
  ask_email?: boolean | null;
  ask_phone?: boolean | null;
  require_name?: boolean | null;
  require_email?: boolean | null;
  require_phone?: boolean | null;
  verify_email?: boolean | null;
  verify_phone?: boolean | null;
  prechat_timing?: string | null;
}

/** Never trust a stored/legacy value: fall back to the historical behaviour. */
export function normalizePrechatTiming(value: unknown): PrechatTiming {
  return (PRECHAT_TIMINGS as readonly unknown[]).includes(value) ? (value as PrechatTiming) : 'after_handoff';
}

function isMode(v: unknown): v is PreChatPolicyMode {
  return v === 'force_on' || v === 'force_off' || v === 'default_on' || v === 'default_off';
}

/** `{ name, email, phone }` of policy modes; anything unreadable is the column default. */
export function normalizePreChatPolicy(value: unknown): PreChatPolicy {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    name: isMode(source.name) ? source.name : DEFAULT_PRECHAT_POLICY.name,
    email: isMode(source.email) ? source.email : DEFAULT_PRECHAT_POLICY.email,
    phone: isMode(source.phone) ? source.phone : DEFAULT_PRECHAT_POLICY.phone,
  };
}

/** Whether the Super Admin fixed this field (the panel shows it locked). */
export function isPrechatFieldLocked(mode: PreChatPolicyMode): boolean {
  return mode === 'force_on' || mode === 'force_off';
}

/**
 * The form of a workspace that never saved its own (no row): each field the
 * policy turns on by default is asked, and name and email are then required
 * (the historical default), the phone optional.
 */
export function defaultPrechatRow(policyValue: unknown): Required<PrechatSettingsRow> {
  const policy = normalizePreChatPolicy(policyValue);
  const on = (f: PrechatField) => policy[f] === 'default_on' || policy[f] === 'force_on';
  return {
    ask_name: on('name'),
    ask_email: on('email'),
    ask_phone: on('phone'),
    require_name: on('name'),
    require_email: on('email'),
    require_phone: false,
    verify_email: false,
    verify_phone: false,
    prechat_timing: 'after_handoff',
  };
}

/**
 * A row as it may be stored: every `require_<field>` off while its
 * `ask_<field>` is off. Other columns are kept as they are.
 */
export function requireOnlyAsked<T extends PrechatSettingsRow>(row: T): T {
  const out = { ...row };
  for (const f of PRECHAT_FIELDS) {
    if (!out[`ask_${f}`]) (out as PrechatSettingsRow)[`require_${f}`] = false;
  }
  return out;
}

/**
 * The form the visitor gets: the workspace's row (or the policy's defaults
 * without one) when the plan allows a pre-chat form, clamped by the policy,
 * a field required only when asked.
 */
export function effectivePrechat(
  row: PrechatSettingsRow | null | undefined,
  policyValue: unknown,
  opts: { planAllowsForm?: boolean } = {},
): EffectivePrechat {
  const policy = normalizePreChatPolicy(policyValue);
  const planAllows = opts.planAllowsForm !== false;
  const base: PrechatSettingsRow | null = planAllows ? (row ?? defaultPrechatRow(policy)) : null;
  const ask = {} as Record<PrechatField, boolean>;
  const req = {} as Record<PrechatField, boolean>;
  let forced = false;
  for (const f of PRECHAT_FIELDS) {
    const mode = policy[f];
    if (mode === 'force_on') {
      ask[f] = true;
      req[f] = true;
      forced = true;
    } else if (mode === 'force_off') {
      ask[f] = false;
      req[f] = false;
    } else {
      ask[f] = !!base?.[`ask_${f}`];
      req[f] = ask[f] && !!base?.[`require_${f}`];
    }
  }
  // Without the plan's form only a forced field is asked, at the historical
  // moment; nothing forced, no form.
  const timing: PrechatTiming = base
    ? normalizePrechatTiming(base.prechat_timing)
    : forced ? 'after_handoff' : 'never';
  return {
    ask_name: ask.name,
    ask_email: ask.email,
    ask_phone: ask.phone,
    require_name: req.name,
    require_email: req.email,
    require_phone: req.phone,
    verify_email: ask.email && !!base?.verify_email,
    verify_phone: ask.phone && !!base?.verify_phone,
    timing,
  };
}
