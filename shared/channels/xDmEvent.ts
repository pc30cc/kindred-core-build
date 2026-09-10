/**
 * Shape of one polled X (Twitter) DM event, already expansion-resolved.
 *
 * PURE type-only module: `channels/providers/x/client.ts` (Worker side,
 * produces it from the X API response) and
 * `server/services/channels/x/toBotUpdate.ts` (Core side, translates it into
 * a Bot-API update) both import it from here instead of one importing from
 * the other — Core must never import anything under `channels/providers/**`,
 * not even a type, or the provider-isolation guard
 * (`src/test/channels/providerIsolationGuard.test.ts`) fails the build.
 */

export type XDmEvent = {
  id: string;
  text: string | null;
  eventType: string;
  createdAt: string | null;
  dmConversationId: string;
  senderId: string;
  senderUsername: string | null;
  mediaUrls: Array<{ kind: 'photo' | 'video' | 'audio'; url: string }>;
};
