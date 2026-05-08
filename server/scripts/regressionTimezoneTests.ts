/**
 * E10.2 — computeNextRunAt sanity tests.
 *
 * Pure dev script: runs in-process with a stub Supabase client so it can be
 * executed without a live DB. No hardcoded city/region — uses neutral IANA
 * zones only as test inputs.
 *
 * Usage: bun run server/scripts/regressionTimezoneTests.ts
 */
import { computeNextRunAt, __resetTimezoneCachesForTests } from '../services/ai-agent/regressionRunner.js';

function makeStubSb(opts: { platformTz?: string | null; workspaceTz?: string | null } = {}) {
  const { platformTz = null, workspaceTz = null } = opts;
  const handlers: Record<string, () => any> = {
    platform_settings: () => ({ data: { timezone: platformTz }, error: null }),
    workspaces: () => (workspaceTz === undefined
      ? { data: null, error: { code: '42703', message: 'column "timezone" does not exist' } }
      : { data: { timezone: workspaceTz }, error: null }),
  };
  const make = (table: string): any => ({
    select: () => make(table),
    eq: () => make(table),
    limit: () => make(table),
    maybeSingle: async () => handlers[table]?.() ?? { data: null, error: null },
  });
  return { from: (table: string) => make(table) } as any;
}

function assert(cond: any, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

async function main() {
  const from = new Date('2026-05-08T12:34:56Z');
  const reset = () => __resetTimezoneCachesForTests();

  // 1) manual => null
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'manual', time_of_day: null, timezone: 'UTC', metadata: {} }, from);
    assert(r.next_run_at === null, 'manual => next_run_at null');
    assert(r.resolved_timezone === 'UTC', 'manual => UTC resolved');
  }

  // 2) hourly => next full hour
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'hourly', time_of_day: null, timezone: 'UTC', metadata: {} }, from);
    assert(r.next_run_at?.toISOString() === '2026-05-08T13:00:00.000Z', 'hourly => next full hour');
  }

  // 3) daily valid tz + HH:mm
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'daily', time_of_day: '09:00', timezone: 'Europe/London', metadata: {} }, from);
    assert(!!r.next_run_at && r.next_run_at.getTime() > from.getTime(), 'daily => future timestamp');
    assert(r.resolved_timezone === 'Europe/London', 'daily => Europe/London resolved');
    assert(r.warning === null, 'daily => no warning');
  }

  // 4) weekly with metadata.weekday
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'weekly', time_of_day: '08:00', timezone: 'America/New_York', metadata: { weekday: 1 } }, from);
    assert(!!r.next_run_at && r.next_run_at.getTime() > from.getTime(), 'weekly => future timestamp');
  }

  // 5) invalid timezone => UTC + warning
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'daily', time_of_day: '09:00', timezone: 'Not/AZone', metadata: {} }, from);
    assert(r.resolved_timezone === 'UTC', 'invalid tz => UTC');
    assert(r.warning === 'timezone_invalid_fallback_utc', 'invalid tz => warning');
  }

  // 6) invalid time_of_day => interval fallback
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'daily', time_of_day: 'nope', timezone: 'UTC', metadata: {} }, from);
    assert(r.warning === 'time_of_day_invalid_interval_fallback', 'invalid HH:mm => interval fallback warning');
    assert(r.next_run_at?.getTime() === from.getTime() + 86_400_000, 'invalid HH:mm => +1 day');
  }

  // 7) no schedule tz, platform tz exists
  {
    reset();
    const sb = makeStubSb({ platformTz: 'Europe/London' });
    const r = await computeNextRunAt(sb, { frequency: 'daily', time_of_day: '09:00', timezone: '', metadata: {} }, from);
    assert(r.resolved_timezone === 'Europe/London', 'no schedule tz => platform tz used');
  }

  // 8) no tz anywhere => UTC
  {
    reset();
    const sb = makeStubSb();
    const r = await computeNextRunAt(sb, { frequency: 'daily', time_of_day: '09:00', timezone: '', metadata: {} }, from);
    assert(r.resolved_timezone === 'UTC', 'no tz anywhere => UTC');
  }

  console.log('\nAll computeNextRunAt assertions passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });