/**
 * YAHOO CHANGE SIGNAL — the content-free realtime event for a Yahoo mailbox.
 *
 * Yahoo has no push: the Channels Worker polls IMAP and posts each message to
 * `/internal/channels/yahoo/upsert-thread-message`. When one is stored as a
 * NEW inbound message, apps with the inbox open hear the same
 * `email_mailbox_changed` event a Gmail change produces — `provider: 'yahoo'`
 * and no cursor (Yahoo has no incremental `/changes`; it answers `reset`, so
 * clients reload page one). A poll posts up to 25 messages back to back, so
 * the event is coalesced per mailbox, as gmailChangeNotifier coalesces
 * Pub/Sub pushes. Never a subject, sender or snippet
 * (docs/EMAIL_INBOX_ARCHITECTURE.md).
 */
import type { ServerConfig } from '../../config.js';
import { publishOperatorEvent } from '../realtime/publish.js';

export const YAHOO_CHANGE_COALESCE_MS = 2_000;
const pending = new Set<string>();

/**
 * The clock the window runs on. Tests replace `after` with one they drive
 * by hand, rather than faking the process's timers under a live HTTP server.
 */
export const yahooChangeClock = {
  after(ms: number, run: () => void): void {
    const timer = setTimeout(run, ms);
    timer.unref?.();
  },
};

export function scheduleYahooMailboxChanged(config: ServerConfig, workspaceId: string, integrationId: string): void {
  if (pending.has(integrationId)) return;
  pending.add(integrationId);
  yahooChangeClock.after(YAHOO_CHANGE_COALESCE_MS, () => {
    pending.delete(integrationId);
    void publishOperatorEvent(config, {
      kind: 'email_mailbox_changed',
      workspace_id: workspaceId,
      conversation_id: '',
      provider: 'yahoo',
      history_id: null,
      // When it was published: two signals are two events to clients that
      // de-duplicate by payload (Android, without a stream offset).
      at: new Date().toISOString(),
    }, { skipConversationChannel: true }).catch(() => {});
  });
}
