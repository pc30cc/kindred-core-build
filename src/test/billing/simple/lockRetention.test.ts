/**
 * Simple billing phase 4 (design §7, §8): the deletion schedule of locked
 * data and the export's file helpers, without a database. The flows run
 * against the real chain in src/test/integration/billingLockRetention.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  deletionDeadline,
  episodeBase,
  lockedSummary,
  noticeDeadline,
  noticeDue,
  type LockClock,
} from '../../../../server/services/billing/locks/retention.js';
import { contactsCsv, lockExportKey, publicLockExport, type LockExportRow } from '../../../../server/services/billing/locks/exportWorker.js';
import { formatBillingNumber } from '../../../../server/services/billing/account/notify.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-11T12:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

function clock(over: Partial<LockClock> = {}): LockClock {
  return {
    workspace_id: '11111111-1111-1111-1111-111111111111',
    kind: 'contact',
    episode_key: iso(NOW),
    since: iso(NOW),
    cutoff_at: null,
    locked_count: 3,
    notice_30_at: null,
    notice_7_at: null,
    deleted_at: null,
    ...over,
  };
}

describe('the deletion schedule (design §8)', () => {
  it('a count kind runs from when it was first seen; a chat batch from its date; nothing without L', () => {
    expect(episodeBase(clock(), 60)).toBe(NOW + 60 * DAY);
    expect(episodeBase(clock({ kind: 'conversation', episode_key: '2026-11-01' }), 60)).toBe(Date.parse('2026-11-01T00:00:00Z'));
    expect(episodeBase(clock(), null)).toBeNull();
    expect(noticeDue(clock({ since: iso(NOW - 365 * DAY) }), null, NOW)).toBeNull();
    expect(deletionDeadline(clock({ notice_30_at: iso(NOW - 60 * DAY), notice_7_at: iso(NOW - 30 * DAY) }), null)).toBeNull();
  });

  it('the 30-day notice from 30 days before the deadline, then the 7-day one, never in the same run', () => {
    expect(noticeDue(clock({ since: iso(NOW - 29 * DAY) }), 60, NOW)).toBeNull();
    expect(noticeDue(clock({ since: iso(NOW - 30 * DAY) }), 60, NOW)).toBe('30');
    // Just sent: the 7-day one waits for 23 days (the deadline moved to 30 days after it).
    const noticed = clock({ since: iso(NOW - 30 * DAY), notice_30_at: iso(NOW) });
    expect(noticeDue(noticed, 60, NOW)).toBeNull();
    expect(noticeDue(noticed, 60, NOW + 22 * DAY)).toBeNull();
    expect(noticeDue(noticed, 60, NOW + 23 * DAY)).toBe('7');
    expect(noticeDue({ ...noticed, notice_7_at: iso(NOW + 23 * DAY) }, 60, NOW + 24 * DAY)).toBeNull();
    expect(noticeDue(clock({ deleted_at: iso(NOW) , since: iso(NOW - 90 * DAY) }), 60, NOW)).toBeNull();
  });

  it('a short L or a late notice never shortens the notice period', () => {
    // L = 5: the deadline is 30 days after the 30-day notice, not since + 5.
    const short = clock({ since: iso(NOW - 10 * DAY) });
    expect(noticeDue(short, 5, NOW)).toBe('30');
    expect(noticeDeadline(short, 5, '30', NOW)).toBe(NOW + 30 * DAY);
    // A notice sent late (the job was down): the 7-day one still gives 7 days.
    const late = clock({ since: iso(NOW - 200 * DAY), notice_30_at: iso(NOW - 40 * DAY) });
    expect(noticeDue(late, 60, NOW)).toBe('7');
    expect(noticeDeadline(late, 60, '7', NOW)).toBe(NOW + 7 * DAY);
  });

  it('deletes only after both notices, at the latest of the three dates', () => {
    const base = clock({ since: iso(NOW - 100 * DAY) }); // since + 60 = 40 days ago
    expect(deletionDeadline(base, 60)).toBeNull();
    expect(deletionDeadline({ ...base, notice_30_at: iso(NOW - 31 * DAY) }, 60)).toBeNull();
    expect(deletionDeadline({ ...base, notice_30_at: iso(NOW - 31 * DAY), notice_7_at: iso(NOW - 2 * DAY) }, 60)).toBe(NOW + 5 * DAY);
    expect(deletionDeadline({ ...base, notice_30_at: iso(NOW - 31 * DAY), notice_7_at: iso(NOW - 8 * DAY) }, 60)).toBe(NOW - DAY);
    expect(deletionDeadline({ ...base, notice_30_at: iso(NOW - 31 * DAY), notice_7_at: iso(NOW - 8 * DAY), deleted_at: iso(NOW) }, 60)).toBeNull();
    // A chat batch: not before its date.
    const batch = clock({ kind: 'conversation', episode_key: '2026-11-01', notice_30_at: iso(NOW - 60 * DAY), notice_7_at: iso(NOW - 30 * DAY) });
    expect(deletionDeadline(batch, 60)).toBe(Date.parse('2026-11-01T00:00:00Z'));
  });
});

describe('the notice\'s {locked_summary}', () => {
  it('names each kind with the locale\'s digits and words', () => {
    const counts = { kb_article: 12, contact: 340, conversation: 1200 };
    expect(lockedSummary(counts, 'en', (n) => formatBillingNumber('international', 'en', n))).toBe('12 articles, 340 contacts, 1,200 chats');
    expect(lockedSummary({ contact: 1 }, 'en', String)).toBe('1 contact');
    expect(lockedSummary(counts, 'tr', (n) => formatBillingNumber('international', 'tr', n))).toBe('12 makale, 340 kişi, 1.200 sohbet');
    const fa = lockedSummary(counts, 'fa', (n) => formatBillingNumber('iran', 'fa', n));
    expect(fa).toBe('۱۲ مقاله، ۳۴۰ مخاطب، ۱٬۲۰۰ گفتگو');
    expect(fa).not.toMatch(/[يك]/); // ی and ک only
    expect(lockedSummary({ kb_article: 0 }, 'en', String)).toBe('');
  });
});

describe('the export\'s files', () => {
  it('stores under the workspace\'s billing-exports folder, never anywhere a caller names', () => {
    const ws = '22222222-2222-2222-2222-222222222222';
    const job = '33333333-3333-3333-3333-333333333333';
    expect(lockExportKey(ws, job)).toBe(`workspace/${ws}/billing-exports/${job}.zip`);
    expect(() => lockExportKey(ws, '../../x')).toThrow();
    expect(() => lockExportKey('not-a-workspace', job)).toThrow();
  });

  it('writes a CSV spreadsheets read as UTF-8, quoting and defusing formulas', () => {
    const csv = contactsCsv([
      { id: 'a', name: 'علی, "A"', email: 'a@x.test', phone: '=HYPERLINK("x")', tags: ['vip', 'b2b'], notes: 'line\nbreak', created_at: '2026-01-01' },
    ]);
    expect(csv.startsWith('\uFEFFid,name,email,phone,tags,notes,visitor_code,created_at,updated_at\r\n')).toBe(true);
    expect(csv).toContain('"علی, ""A"""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('vip; b2b');
    expect(csv).toContain('"line\nbreak"');
  });

  it('shows the page a job without its storage key or token, an expired file as expired', () => {
    const row = {
      id: 'j', workspace_id: 'w', requested_by: 'u', status: 'completed', kinds: ['contact'], counts: { contact: 2 },
      artifact_storage_provider: 'local', artifact_storage_key: 'workspace/w/billing-exports/j.zip', artifact_size_bytes: 10,
      download_token_hash: 'h', expires_at: iso(Date.now() + DAY), attempts: 1, locked_at: null, error: 'x',
      created_at: iso(NOW), updated_at: iso(NOW),
    } as LockExportRow;
    const view = publicLockExport(row)!;
    expect(view).toMatchObject({ id: 'j', status: 'completed', counts: { contact: 2 }, error: null });
    expect(view).not.toHaveProperty('artifact_storage_key');
    expect(view).not.toHaveProperty('download_token_hash');
    expect(publicLockExport({ ...row, expires_at: iso(Date.now() - 1000) })!.status).toBe('expired');
    expect(publicLockExport({ ...row, artifact_storage_key: null })!.status).toBe('expired');
    expect(publicLockExport({ ...row, status: 'failed' })!.error).toBe('x');
    expect(publicLockExport(null)).toBeNull();
  });
});
