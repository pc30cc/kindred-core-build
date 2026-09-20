// ============================================
// API-BASED EMAIL PROVIDER
// EmailProvider implementation that sends emails via the self-hosted backend.
// NO Supabase Edge Functions. All email goes through server/routes/email.
// ============================================

import type { EmailProvider, EmailMessage } from '@/types/providers';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE;

/**
 * Creates an EmailProvider that routes through the self-hosted backend API.
 * The backend picks the provider (Resend/SendGrid/SMTP) from the ONE platform
 * config in `app_runtime_config.default_email_provider`, set in
 * Super Admin → Providers → Email. There is no workspace override any more,
 * and the From header is not ours to send: the route rejects a body carrying
 * `from` or `replyTo` with a 400 rather than ignoring it.
 */
export function createApiEmailProvider(workspaceId: string): EmailProvider {
  return {
    async send(message: EmailMessage) {
      try {
        const res = await fetch(`${API_BASE}/api/email/send-channel`, {
          credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            templateSlug: message.templateId,
            templateData: message.templateData,
          }),
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          return { id: '', error: new Error(data.error || `Email API error: ${res.status}`) };
        }

        return { id: data.id || '', error: null };
      } catch (err) {
        return { id: '', error: err instanceof Error ? err : new Error(String(err)) };
      }
    },

    async sendBatch(messages: EmailMessage[]) {
      const ids: string[] = [];
      const errors: string[] = [];

      for (const msg of messages) {
        const result = await this.send(msg);
        if (result.error) {
          errors.push(`${msg.to}: ${result.error.message}`);
        } else {
          ids.push(result.id);
        }
      }

      return {
        ids,
        error: errors.length > 0 ? new Error(errors.join('; ')) : null,
      };
    },
  };
}
