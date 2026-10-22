/**
 * The plan, as the widget's write paths enforce it.
 *
 * /config already intersects every behaviour with the plan (configSnapshot.ts
 * applyWidgetEntitlementsToSettings), so after a downgrade the widget hides
 * the attach button, the microphone, or chat itself. The routes that accept
 * what those controls send (POST /attachments/init, POST /message) read the
 * workspace's raw widget_settings columns, which no downgrade resets: a crafted
 * request, or a tab still holding the older config, could still upload a file
 * or a voice note, or write, that the plan no longer allows. They ask here.
 *
 * Read from the same cached workspace snapshot as /config, so both answer
 * alike and no request pays for a plan lookup of its own. An unreadable plan
 * (a failed lookup, the snapshot's `degraded` entitlements) denies nothing, as
 * an unreadable plan never closed a visitor's chat before.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspaceWidgetSnapshot } from './configSnapshot.js';

/** Capability keys (billing/capabilityRegistry.ts) behind the widget's write paths. */
export const WIDGET_PLAN_CHAT = 'chat';
export const WIDGET_PLAN_ATTACHMENTS = 'widget_attachments';
export const WIDGET_PLAN_VOICE_NOTES = 'widget_voice_notes';

/** The capabilities among `keys` that the workspace's plan readably denies. */
export async function widgetPlanDenied(
  config: ServerConfig,
  workspaceId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const denied = new Set<string>();
  try {
    const snap = await getWorkspaceWidgetSnapshot(config, workspaceId);
    const ent = snap.entitlements;
    if (!ent || ent.degraded) return denied;
    for (const key of keys) if (ent.features[key] === false) denied.add(key);
  } catch {
    // Unreadable: nothing is denied (see above).
  }
  return denied;
}
