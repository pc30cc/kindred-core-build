/**
 * THE OPERATOR NOTIFICATION EMAILS — one list, named once.
 *
 * Six switches used to sit on Settings → Notifications with nothing behind
 * them: they saved, answered 200 and sent no mail, because no sender existed.
 * This is the list of the ones that do exist now, and it is the only place
 * they are enumerated. The platform settings row, the operator's own
 * preferences, the queue's CHECK constraint, the admin UI and the template
 * slugs are all derived from it, so adding a seventh is one entry plus a
 * producer — and forgetting to wire one up is a failing test rather than
 * another switch that lies.
 *
 * WHAT IS NOT HERE, and why:
 *
 *   `user_ratings` — "email me user ratings" needs somewhere for a customer
 *   to rate the operator who helped them, and no such thing exists in this
 *   product. The only rating anywhere is thumbs up/down on a knowledge-base
 *   article, which is about the article. Building the switch before the
 *   feature is how the other six got here.
 */

/** Every operator notification email the platform can send. */
export const NOTIFICATION_EMAIL_TYPES = [
  'unread_messages',
  'transcripts',
  'paid_invoices',
  'weekly_summary',
  'product_updates',
] as const;

export type NotificationEmailType = (typeof NOTIFICATION_EMAIL_TYPES)[number];

export interface NotificationEmailDefinition {
  type: NotificationEmailType;
  /** The `email_templates.slug` this type renders through. */
  slug: string;
  /**
   * Who may receive it. 'members' is every operator in the workspace;
   * 'admins' is the owner and workspace admins only — an invoice is the
   * company's money, and an operator who answers chats has no business
   * being told what it paid.
   */
  audience: 'members' | 'admins';
  /**
   * Whether the operator may turn it off. A platform announcement is the one
   * an admin sends BECAUSE everybody has to see it, and it is still bounded:
   * the platform switch turns the whole type off for everybody.
   */
  operatorOptOut: boolean;
  /**
   * Whether an operator's quiet hours hold it back until they are over.
   * A digest that arrives at 3am defeats the digest; an invoice notice is
   * not urgent enough to override anything either. Nothing here is urgent —
   * urgent is what push is for — so all of them wait.
   */
  respectsQuietHours: boolean;
}

export const NOTIFICATION_EMAILS: Record<NotificationEmailType, NotificationEmailDefinition> = {
  unread_messages: {
    type: 'unread_messages',
    slug: 'operator_unread_digest',
    audience: 'members',
    operatorOptOut: true,
    respectsQuietHours: true,
  },
  transcripts: {
    type: 'transcripts',
    slug: 'operator_conversation_transcript',
    audience: 'members',
    operatorOptOut: true,
    respectsQuietHours: true,
  },
  paid_invoices: {
    type: 'paid_invoices',
    slug: 'operator_invoice_paid',
    audience: 'admins',
    operatorOptOut: true,
    respectsQuietHours: true,
  },
  weekly_summary: {
    type: 'weekly_summary',
    slug: 'operator_weekly_summary',
    audience: 'members',
    operatorOptOut: true,
    respectsQuietHours: true,
  },
  product_updates: {
    type: 'product_updates',
    slug: 'operator_product_update',
    audience: 'members',
    operatorOptOut: true,
    respectsQuietHours: true,
  },
};

export function isNotificationEmailType(value: unknown): value is NotificationEmailType {
  return (NOTIFICATION_EMAIL_TYPES as readonly string[]).includes(String(value));
}

/** The template slug a type renders through. */
export function slugFor(type: NotificationEmailType): string {
  return NOTIFICATION_EMAILS[type].slug;
}

/** Every slug, for the seeds and for the Branding UI's own list. */
export const NOTIFICATION_EMAIL_SLUGS = NOTIFICATION_EMAIL_TYPES.map((t) => NOTIFICATION_EMAILS[t].slug);
