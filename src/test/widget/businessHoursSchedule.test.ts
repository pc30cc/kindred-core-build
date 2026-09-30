/**
 * Business hours from the workspace panel, as the AI states them.
 *
 * The schedule is described from the widget_settings row the availability
 * resolver reads anyway (or the caller already holds): no query of its own,
 * and only when a caller asks for it.
 */
import { describe, it, expect, vi } from 'vitest';

const dbUsed = vi.fn();
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => {
    dbUsed();
    throw new Error('no database access expected');
  },
}));

const { describeBusinessHours, resolveAvailability, snapshotToWirePayload } = await import(
  '../../../server/services/widget/availability'
);
const { businessHoursToolResult, answersBusinessHoursFromSettings, wantsBusinessHours, renderToolResults } = await import(
  '../../../server/services/ai-agent/actions/readOnly'
);
const { decideStrategy } = await import('../../../server/services/ai-agent/answerStrategy');

const day = [{ from: '09:00', to: '17:00' }];
const hours = {
  enabled: true,
  timezone: 'Asia/Tehran', // UTC+03:30, no DST
  weekly: {
    sat: day, sun: day, mon: day, tue: day, wed: day,
    thu: [{ from: '13:00', to: '14:00' }, { from: '09:00', to: '12:00' }, { from: '25:00', to: '26:00' }, { from: '18:00', to: '09:00' }],
    fri: [],
  },
  overrides: [
    { date: '2026-10-02', intervals: [{ from: '10:00', to: '12:00' }] },
    { date: '2026-10-03', closed: true },
    { date: '2026-11-30', closed: true }, // beyond the two-week window
  ],
};
// Wednesday 2026-09-30, 14:00 in Tehran.
const WED_2PM = new Date('2026-09-30T10:30:00Z');
// Wednesday 2026-09-30, 18:30 in Tehran.
const WED_EVENING = new Date('2026-09-30T15:00:00Z');

describe('describeBusinessHours', () => {
  it('lists the week Monday first, keeping only intervals the resolver honours', () => {
    const s = describeBusinessHours(hours, WED_2PM, null)!;
    expect(s.timezone).toBe('Asia/Tehran');
    expect(s.weekly.map((w) => w.day)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(s.weekly.find((w) => w.day === 'thu')!.intervals).toEqual([
      { from: '09:00', to: '12:00' },
      { from: '13:00', to: '14:00' },
    ]);
    expect(s.weekly.find((w) => w.day === 'fri')!.intervals).toEqual([]);
  });

  it('includes date overrides of the next two weeks only', () => {
    const s = describeBusinessHours(hours, WED_2PM, null)!;
    expect(s.upcoming).toEqual([
      { date: '2026-10-02', day: 'fri', closed: false, intervals: [{ from: '10:00', to: '12:00' }] },
      { date: '2026-10-03', day: 'sat', closed: true, intervals: [] },
    ]);
  });

  it('places now in the workspace time zone', () => {
    const s = describeBusinessHours(hours, WED_2PM, null)!;
    expect(s.now).toEqual({ date: '2026-09-30', day: 'wed', time: '14:00' });
    expect(s.open_now).toBe(true);
    expect(s.next_open).toBeNull();
  });

  it('is null when business hours are off or no interval is set anywhere', () => {
    expect(describeBusinessHours({ ...hours, enabled: false }, WED_2PM, null)).toBeNull();
    expect(describeBusinessHours(null, WED_2PM, null)).toBeNull();
    expect(describeBusinessHours({ enabled: true, timezone: 'UTC', weekly: { mon: [] }, overrides: [] }, WED_2PM, null)).toBeNull();
  });

  it('falls back to UTC for an unknown time zone', () => {
    const s = describeBusinessHours({ ...hours, timezone: 'Not/AZone' }, WED_2PM, null)!;
    expect(s.timezone).toBe('UTC');
    expect(s.now.time).toBe('10:30');
  });
});

describe('resolveAvailability({ includeSchedule })', () => {
  it('describes the schedule from the row it was given, without a database read', async () => {
    const snap = await resolveAvailability({} as never, {
      workspaceId: 'ws', now: WED_EVENING, settingsRow: { business_hours: hours }, includeSchedule: true,
    });
    expect(dbUsed).not.toHaveBeenCalled();
    expect(snap.state).toBe('offline');
    expect(snap.reason).toBe('outside_hours');
    expect(snap.schedule!.open_now).toBe(false);
    // Thursday opens at 09:00 Tehran time.
    expect(snap.schedule!.next_open).toEqual({ date: '2026-10-01', day: 'thu', time: '09:00' });
  });

  it('leaves the schedule off unless asked, and never puts it on the wire', async () => {
    const snap = await resolveAvailability({} as never, {
      workspaceId: 'ws', now: WED_EVENING, settingsRow: { business_hours: hours },
    });
    expect('schedule' in snap).toBe(false);
    const withSchedule = await resolveAvailability({} as never, {
      workspaceId: 'ws', now: WED_EVENING, settingsRow: { business_hours: hours }, includeSchedule: true,
    });
    expect('schedule' in snapshotToWirePayload(withSchedule)).toBe(false);
  });
});

describe('get_business_hours from the panel schedule', () => {
  const availability = {
    state: 'offline',
    reason: 'outside_hours',
    schedule: describeBusinessHours(hours, WED_EVENING, '2026-10-01T05:30:00.000Z'),
  };

  it('renders the schedule as plain fields', () => {
    const block = renderToolResults([businessHoursToolResult(availability)!])!;
    expect(block).toContain('source=workspace_settings');
    expect(block).toContain('timezone=Asia/Tehran');
    expect(block).toContain('weekly_hours=Monday 09:00-17:00; Tuesday 09:00-17:00; Wednesday 09:00-17:00; Thursday 09:00-12:00 and 13:00-14:00; Friday closed; Saturday 09:00-17:00; Sunday 09:00-17:00');
    expect(block).toContain('special_days=2026-10-02 (Friday) 10:00-12:00; 2026-10-03 (Saturday) closed');
    expect(block).toContain('now_local=2026-09-30 (Wednesday) 18:30');
    expect(block).toContain('open_now_by_schedule=false');
    expect(block).toContain('next_open_local=2026-10-01 (Thursday) 09:00');
    expect(block).toContain('operators_online=false');
  });

  it('is absent when the panel has no business hours', () => {
    expect(businessHoursToolResult({ state: 'online', reason: 'disabled', schedule: null })).toBeNull();
    expect(businessHoursToolResult({ state: 'online', reason: 'disabled' })).toBeNull();
    expect(answersBusinessHoursFromSettings({ state: 'online', reason: 'disabled', schedule: null }, 'what are your working hours?')).toBe(false);
  });

  it('applies to hours questions only', () => {
    expect(answersBusinessHoursFromSettings(availability, 'what are your working hours?')).toBe(true);
    expect(answersBusinessHoursFromSettings(availability, 'how much is the pro plan?')).toBe(false);
  });

  it('recognises Persian hours questions, including Arabic letters and a zero-width non-joiner', () => {
    expect(wantsBusinessHours('ساعت کاری شما چیه؟')).toBe(true);
    expect(wantsBusinessHours('ساعات كاري‌تون چطوره')).toBe(true); // Arabic kaf/yeh
    expect(wantsBusinessHours('روز‌های کاری کدومه؟')).toBe(true); // ZWNJ
    expect(wantsBusinessHours('ساعت چند باز میکنید؟')).toBe(true);
    expect(wantsBusinessHours('قیمت پلن حرفه‌ای چنده؟')).toBe(false);
  });
});

describe('decideStrategy with answeredBySettings', () => {
  const settings = {
    handoff_on_human_request: true,
    handoff_keywords: [],
    handoff_when_no_kb_match: true,
    handoff_on_low_confidence: true,
    escalation_style: 'balanced',
  } as never;
  const kbSource = { id: 's1', kind: 'kb_article', title: 'Hours', content: 'We are open 8-16.', excerpt: '', score: 0.9 } as never;

  it('answers grounded from the settings when the knowledge base has nothing, even under "hand off when no KB match"', () => {
    const d = decideStrategy({
      settings, question: 'What are your working hours?', sources: [], clarificationAttemptCount: 0,
      businessSignalDetected: true, answeredBySettings: true,
    });
    expect(d.decisionType).toBe('answer');
    expect(d.reason).toBe('workspace_settings_match');
    expect(d.groundingMode).toBe('grounded');
    expect(d.handoffRequired).toBe(false);
  });

  it('keeps knowledge-base evidence first', () => {
    const d = decideStrategy({
      settings, question: 'What are your working hours?', sources: [kbSource], clarificationAttemptCount: 0,
      answeredBySettings: true,
    });
    expect(d.reason).toBe('strong_kb_match');
  });

  it('still hands off on an explicit request for a human', () => {
    const d = decideStrategy({
      settings, question: 'I want to talk to a human about your working hours', sources: [], clarificationAttemptCount: 0,
      answeredBySettings: true,
    });
    expect(d.decisionType).toBe('handoff');
  });

  it('without settings data, the owner escalation policy is unchanged', () => {
    const d = decideStrategy({
      settings, question: 'What are your working hours?', sources: [], clarificationAttemptCount: 0,
      businessSignalDetected: true,
    });
    expect(d.decisionType).toBe('handoff');
  });
});
