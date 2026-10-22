/**
 * Phase 6 — Client-side interpolation for canned responses.
 *
 * The server stores raw `{{var}}` placeholders verbatim. Expansion happens
 * here at insertion time. ONLY the 6 approved variables are recognized.
 *
 * A variable without a value (finding I-08: most visitors are anonymous, so
 * `{{contact.name}}` usually has none) never reaches the visitor as raw
 * braces:
 *   - `{{contact.name|default:"there"}}` takes its default;
 *   - without one (or with an empty one) the placeholder is dropped, with
 *     the space before a following comma or full stop: "Hi
 *     {{contact.name}}, thanks" → "Hi, thanks", «سلام {{contact.name}}،
 *     ممنون» → «سلام، ممنون».
 * An unknown placeholder (a typo such as `{{contact.nmae}}`) is left as it
 * is so the operator sees it, and the composer refuses to send a message
 * that still holds one (`unresolvedPlaceholders`).
 */

import { CANNED_VARIABLES, type CannedVariable } from '@/lib/canned-responses-api';

export interface InterpolationContext {
  contact?: { name?: string | null; email?: string | null };
  workspace?: { name?: string | null };
  agent?: { name?: string | null; first_name?: string | null; email?: string | null };
}

/**
 * `{{ name }}` or `{{ name | default: "…" }}` (also `fallback`, and single
 * quotes). Group 1: the name; 2/3: the default, double- or single-quoted.
 */
const VAR_RE = /\{\{\s*([a-z_]+\.[a-z_]+)\s*(?:\|\s*(?:default|fallback)\s*:\s*(?:"([^"]*)"|'([^']*)')\s*)?\}\}/gi;

/** Any placeholder in a canned-variable namespace, resolved or not. */
const ANY_PLACEHOLDER_RE = /\{\{\s*(?:contact|workspace|agent)\.[^}]*\}\}/gi;

/** Stands for a dropped placeholder while the text around it is tidied. */
const GAP = '\u0000';

function lookup(ctx: InterpolationContext, key: CannedVariable): string | null {
  switch (key) {
    case 'contact.name': return ctx.contact?.name ?? null;
    case 'contact.email': return ctx.contact?.email ?? null;
    case 'workspace.name': return ctx.workspace?.name ?? null;
    case 'agent.name': return ctx.agent?.name ?? null;
    case 'agent.first_name':
      return ctx.agent?.first_name ?? ctx.agent?.name?.split(' ')[0] ?? null;
    case 'agent.email': return ctx.agent?.email ?? null;
    default: return null;
  }
}

/** Removes dropped placeholders and the spacing they leave behind. */
function closeGaps(text: string): string {
  if (!text.includes(GAP)) return text;
  return text
    // "Hi ␀, thanks" → "Hi, thanks"; Persian/Arabic comma, semicolon and
    // question mark too.
    .replace(new RegExp(`[ \\t]*${GAP}+[ \\t]*(?=[,.!?;:\\u060C\\u061B\\u061F)\\]])`, 'g'), '')
    // "Dear ␀ team" → "Dear team".
    .replace(new RegExp(`[ \\t]+${GAP}+[ \\t]+`, 'g'), ' ')
    // At a line's start or end.
    .replace(new RegExp(`^[ \\t]*${GAP}+[ \\t]*`, 'gm'), '')
    .replace(new RegExp(`[ \\t]*${GAP}+[ \\t]*$`, 'gm'), '')
    .split(GAP).join('');
}

export function interpolate(body: string, ctx: InterpolationContext): string {
  const out = body.replace(VAR_RE, (match, raw, dq, sq) => {
    const key = String(raw).toLowerCase() as CannedVariable;
    if (!(CANNED_VARIABLES as readonly string[]).includes(key)) return match;
    const value = lookup(ctx, key)?.trim();
    if (value) return value;
    const fallback = typeof dq === 'string' ? dq : typeof sq === 'string' ? sq : '';
    return fallback.trim() ? fallback : GAP;
  });
  return closeGaps(out);
}

/**
 * Placeholders still in an outgoing message: an unknown variable, a typo, or
 * one typed by hand. Empty when the message is safe to send as it is.
 */
export function unresolvedPlaceholders(text: string): string[] {
  return Array.from(new Set(text.match(ANY_PLACEHOLDER_RE) ?? []));
}

/** Sample data used by settings preview (no real send side effects). */
export const SAMPLE_CONTEXT: InterpolationContext = {
  contact: { name: 'Sara Johnson', email: 'sara@example.com' },
  workspace: { name: 'Acme Support' },
  agent: { name: 'Alex Chen', first_name: 'Alex', email: 'alex@acme.com' },
};
