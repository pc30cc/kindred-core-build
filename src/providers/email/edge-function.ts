// ============================================
// EDGE FUNCTION EMAIL PROVIDER
// EmailProvider implementation that sends emails via the send-email edge function.
// This is the real provider — no direct vendor SDK usage in business logic.
// ============================================

import type { EmailProvider, EmailMessage } from '@/types/providers';
import { supabase } from '@/lib/supabase';

/**
 * Creates an EmailProvider that routes through the send-email edge function.
 * The edge function handles provider resolution (Resend/SendGrid/SMTP)
 * based on DB config (workspace override → global default → stub).
 */
export function createEdgeFunctionEmailProvider(workspaceId: string): EmailProvider {
  return {
    async send(message: EmailMessage) {
      try {
        const { data, error } = await supabase.functions.invoke('send-email', {
          body: {
            workspaceId,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            from: message.from,
            replyTo: message.replyTo,
            templateSlug: message.templateId,
            templateData: message.templateData,
          },
        });

        if (error) {
          return { id: '', error: new Error(error.message) };
        }

        if (data?.error) {
          return { id: '', error: new Error(data.error) };
        }

        return { id: data?.id || '', error: null };
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
