/**
 * Phase 6 — Client-side interpolation for canned responses.
 *
 * The server stores raw `{{var}}` placeholders verbatim. Expansion happens
 * here at insertion time. ONLY the 6 approved variables are recognized;
 * unknown placeholders are left untouched so operators notice them.
 */

import { CANNED_VARIABLES, type CannedVariable } from '@/lib/canned-responses-api';

export interface InterpolationContext {
  contact?: { name?: string | null; email?: string | null };
  workspace?: { name?: string | null };
  agent?: { name?: string | null; first_name?: string | null; email?: string | null };
}

const VAR_RE = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi;

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

export function interpolate(body: string, ctx: InterpolationContext): string {
  return body.replace(VAR_RE, (match, raw) => {
    const key = String(raw).toLowerCase() as CannedVariable;
    if (!(CANNED_VARIABLES as readonly string[]).includes(key)) return match;
    const value = lookup(ctx, key);
    return value && value.length > 0 ? value : match;
  });
}

/** Sample data used by settings preview (no real send side effects). */
export const SAMPLE_CONTEXT: InterpolationContext = {
  contact: { name: 'Sara Johnson', email: 'sara@example.com' },
  workspace: { name: 'Acme Support' },
  agent: { name: 'Alex Chen', first_name: 'Alex', email: 'alex@acme.com' },
};
