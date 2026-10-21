/**
 * Email TO visitors: one switch for every widget feature that mails a
 * visitor or promises them a mail.
 *
 * Owner decision (2026-10-21): no email to visitors for now. With the switch
 * off:
 *   - the transcript by email (Templates 1 and 2) is not offered: the
 *     template option `transcriptEmail` reads off for every workspace
 *     (shared/chatTemplateCatalog.ts resolveChatTemplateOptions), its toggle
 *     is hidden in the Super Admin's catalog and the workspace's template
 *     options (TemplateOptionsFields.tsx), and POST …/transcript answers 403
 *     `transcript_disabled` (server/services/visitorTranscript.ts);
 *   - the away thread's "where should we send the reply?" email step is not
 *     drawn, and POST /api/widget/identity/offline-email answers 403
 *     `visitor_email_disabled`;
 *   - the widget's copy says the reply appears in the chat, never that it
 *     comes by email.
 * Collecting an email or a phone as contact details (pre-chat, the
 * leave-a-message form) is not sending one, and stays. Mails to the team
 * (operator notifications, the owners' "new offline message") are not
 * visitor email either.
 *
 * Turning it on brings the transcript and the away email step back (the
 * code is kept; the widget learns it from `config.visitorEmail`). Their copy
 * no longer promises that the reply is mailed (the step says the address is
 * saved): nothing mails an operator's reply to a visitor yet, so that mail
 * has to be built before any copy promises it again.
 */
export const VISITOR_EMAIL_FEATURES_ENABLED: boolean = false;

/** The template options that mail a visitor (forced off while the switch is off). */
export const VISITOR_EMAIL_TEMPLATE_OPTIONS = ['transcriptEmail'] as const;
