/**
 * Every preference the delivery code decides on has to be one a person can
 * actually set.
 *
 * This is a guard against a specific, silent failure that was live: the
 * `user_notification_prefs` table has carried `push_scope`, `push_preview`
 * and `push_internal_notes` for as long as `pickRecipients` has branched on
 * them, and `/api/notifications/prefs` could neither return them nor accept
 * them. `push_scope` decides whether an operator is notified about every
 * conversation, only their own, only mentions, or nothing at all — and no
 * console, app or API call could move it off whatever the row happened to
 * hold. Nothing errored; the setting simply did not exist as far as any
 * client could tell.
 *
 * The assertions read the real source rather than a copy, so the next key
 * added to the delivery code and forgotten in the route fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ROUTE = 'server/routes/notifications.ts';
const DELIVERY = 'server/services/push/recipients.ts';
const CLIENT = 'src/lib/notifications-api.ts';
const PAGE = 'src/pages/app/settings/NotificationsPage.tsx';

const read = (path: string) => readFileSync(path, 'utf8');

/** The keys of an object literal assigned to `name`. */
function literalKeys(source: string, name: string): string[] {
  const start = source.indexOf(`${name} = {`);
  if (start < 0) throw new Error(`${name} is no longer an object literal`);
  const body = source.slice(start, source.indexOf('};', start));
  return [...body.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

describe('notification preferences reach the delivery code', () => {
  it('the route can return every preference pickRecipients reads', () => {
    const wanted = literalKeys(read(DELIVERY), 'const DEFAULT_PREFS');
    const served = literalKeys(read(ROUTE), 'const DEFAULTS');

    const missing = wanted.filter((key) => !served.includes(key));
    expect(missing, `the delivery code reads these and the route never sends them: ${missing}`)
      .toEqual([]);
  });

  it('the route accepts every preference it returns', () => {
    const route = read(ROUTE);
    const served = literalKeys(route, 'const DEFAULTS');

    const schemaStart = route.indexOf('const updateSchema = z.object({');
    const schema = route.slice(schemaStart, route.indexOf('});', schemaStart));

    const unwritable = served.filter((key) => !new RegExp(`\\b${key}:`).test(schema));
    expect(unwritable, `returned but not settable: ${unwritable}`).toEqual([]);
  });

  /**
   * `pickRecipients` treats anything that is not 'none', 'mentions' or
   * 'assigned' as "notify me about everything", so an unrecognised value
   * silently widens someone's notifications instead of narrowing them. The
   * route rejects it rather than storing it.
   */
  it('only the four scopes the delivery code acts on are accepted', () => {
    const route = read(ROUTE);
    expect(route).toMatch(/push_scope:\s*z\.enum\(PUSH_SCOPES\)/);
    expect(route).toMatch(/PUSH_SCOPES = \['all', 'assigned', 'mentions', 'none'\]/);

    const delivery = read(DELIVERY);
    for (const scope of ['none', 'mentions', 'assigned']) {
      expect(delivery, `the route offers '${scope}' and the delivery code ignores it`)
        .toContain(`push_scope === '${scope}'`);
    }
  });

  it('the console knows about them too', () => {
    const client = read(CLIENT);
    const page = read(PAGE);

    for (const key of ['push_scope', 'push_preview', 'push_internal_notes']) {
      expect(client, `${key} is missing from the console's own type`).toContain(key);
      expect(page, `${key} has no control on the console page`).toContain(key);
    }
  });
});
