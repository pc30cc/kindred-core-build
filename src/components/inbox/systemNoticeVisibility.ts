/**
 * Who reads a system notice besides the team (I-12), for SystemNoticeRow.
 * Pure: no I/O.
 */
import { systemMessageText, type Translate } from '@/lib/systemMessageText';

/**
 * Whether the visitor receives this notice: everything but what the server
 * marks `internal` (the same rule as the widget's read paths,
 * server/routes/widgetAttachments.ts isVisitorVisibleMessageMeta).
 */
export function isVisitorVisibleNotice(meta: Record<string, unknown>): boolean {
  return meta.internal !== true;
}

/**
 * What the visitor reads for this notice when it differs from the team's
 * sentence: a transfer reaches them as the next operator joining. Null when
 * they read the same (or nothing).
 */
export function visitorVersionOf(meta: Record<string, unknown>, t: Translate): string | null {
  if (!isVisitorVisibleNotice(meta) || meta.kind !== 'conversation_transferred') return null;
  return systemMessageText({ kind: 'routing_agent_joined', agent_name: (meta.to_name as string | null | undefined) ?? null }, t);
}
