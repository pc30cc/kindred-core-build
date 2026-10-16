/**
 * The metadata of a platform-support "who is asking" notice
 * (server/services/platformSupport/requester.ts): kept apart from the card
 * so the inbox can test for the kind without importing a component module.
 */
export const REQUESTER_KIND = 'platform_support_requester';

export interface Metered {
  used?: number | null;
  limit?: number | null;
}

export interface RequesterWorkspace {
  id?: string;
  name?: string;
  role?: string;
  plan?: {
    name?: string;
    names?: Record<string, string>;
    status?: string | null;
    period_end?: string | null;
    trial_end?: string | null;
    cancel_at_period_end?: boolean;
  } | null;
  operators?: Metered;
  contacts?: Metered;
  usage?: {
    conversations?: Metered;
    visitors?: Metered;
    /** Cards written before migration 271: the legacy counter (no longer shown). */
    ai_credits?: Metered;
    /** The plan's monthly AI credit, in the AI wallet's unit (IRR). */
    ai_monthly_credit_irr?: number | null;
    messages?: number | null;
    storage_bytes?: number | null;
    /** The plan's storage limit in MB (-1 unlimited). */
    storage_limit_mb?: number | null;
    /** Cards written before migration 271: the limit in GB. */
    storage_limit_gb?: number | null;
  };
}

export interface RequesterCardMeta {
  kind?: string;
  user?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    company?: string | null;
    website?: string | null;
    member_since?: string | null;
    client_platform?: string | null;
    source_workspace?: string | null;
  };
  workspace_count?: number;
  workspaces?: RequesterWorkspace[];
  captured_at?: string | null;
}
