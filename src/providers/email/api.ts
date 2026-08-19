// ============================================
// API-BASED EMAIL PROVIDER
// EmailProvider implementation that sends emails via the self-hosted backend.
// NO Supabase Edge Functions. All email goes through server/routes/email.
// ============================================

import type { EmailProvider, EmailMessage } from '@/types/providers';

const API_BASE = import.meta.env.VITE_API_BASE_URL;
/** Real end-user identity — the publishable anon key is not an identity and is
 *  rejected by /api/email/send. */
async function userAuthHeader(): Promise<Record<string, string>> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Creates an EmailProvider that routes through the self-hosted backend API.
 * The backend handles provider resolution (Resend/SendGrid/SMTP)
 * based on DB config (workspace override → global default → stub).
 */
export function createApiEmailProvider(workspaceId: string): EmailProvider {
  return {
    async send(message: EmailMessage) {
      try {
        const res = await fetch(`${API_BASE}/api/email/send`, {credentials: 'include', 
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(await userAuthHeader()),
          },
          body: JSON.stringify({
            workspaceId,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            from: message.from,
            replyTo: message.replyTo,
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
