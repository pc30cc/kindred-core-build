import { describe, expect, it, beforeEach } from 'vitest';
import { isLive, targetsPlan, toClient, type CampaignRow } from './campaigns.js';
import { addBroadcast, broadcastsAfter, heartbeat, summary, __resetLive } from './live.js';
import { campaignPatchSchema, campaignSchema, invalidInput } from '../../routes/adminDesktopApp.js';

const row = (patch: Partial<CampaignRow> = {}): CampaignRow => ({
  id: '00000000-0000-0000-0000-000000000001',
  kind: 'ad',
  name: '',
  placements: ['inbox_list'],
  target_plans: [],
  text: { fa: { title: 'سلام', body: 'متن', cta_label: 'بیشتر' }, en: { title: 'Hi' } },
  image_url: null,
  cta_url: 'https://webyar.ai/pricing',
  severity: 'info',
  dismissible: true,
  priority: 0,
  active: true,
  starts_at: null,
  ends_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...patch,
});

describe('desktop campaigns', () => {
  it('respects the switch and the schedule', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(isLive(row(), now)).toBe(true);
    expect(isLive(row({ active: false }), now)).toBe(false);
    expect(isLive(row({ starts_at: '2026-07-01T00:00:00Z' }), now)).toBe(false);
    expect(isLive(row({ ends_at: '2026-05-01T00:00:00Z' }), now)).toBe(false);
  });

  it('targets every plan when the list is empty, else only listed slugs', () => {
    expect(targetsPlan(row(), null)).toBe(true);
    expect(targetsPlan(row({ target_plans: ['free'] }), 'free')).toBe(true);
    expect(targetsPlan(row({ target_plans: ['free'] }), 'pro')).toBe(false);
    expect(targetsPlan(row({ target_plans: ['free'] }), null)).toBe(false);
  });

  it('picks the locale, falls back to Persian, and drops non-https links', () => {
    expect(toClient(row(), 'fa')?.title).toBe('سلام');
    expect(toClient(row(), 'en')?.title).toBe('Hi');
    expect(toClient(row(), 'tr')?.title).toBe('سلام');
    const insecure = toClient(row({ cta_url: 'http://x.test' }), 'fa');
    expect(insecure?.ctaUrl).toBeNull();
    expect(insecure?.ctaLabel).toBeNull();
    expect(toClient(row({ text: {} }), 'fa')).toBeNull();
  });

  it('validates admin input', () => {
    expect(campaignSchema.safeParse({ kind: 'ad', placements: [], text: {} }).success).toBe(false);
    expect(campaignSchema.safeParse({ kind: 'ad', placements: ['nowhere'], text: {} }).success).toBe(false);
    const ok = campaignSchema.safeParse({ kind: 'announcement', placements: ['banner'], text: { fa: { title: 'x' } }, cta_url: '' });
    expect(ok.success).toBe(true);
  });
});

describe('campaign form input', () => {
  const base = { kind: 'ad', placements: ['inbox_list'] } as const;

  it('accepts what the admin form sends for a new ad', () => {
    const parsed = campaignSchema.safeParse({
      ...base,
      name: '',
      target_plans: [],
      text: { fa: { title: 'تخفیف', body: 'x'.repeat(900), cta_label: '' }, en: {}, tr: {} },
      image_url: null,
      cta_url: null,
      severity: 'info',
      dismissible: true,
      priority: 0,
      active: true,
      starts_at: null,
      ends_at: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('adds https:// to a bare domain and refuses other schemes', () => {
    const ok = campaignSchema.parse({ ...base, text: {}, cta_url: ' webyar.ai/pricing ', image_url: 'https://cdn.webyar.ai/a.png' });
    expect(ok.cta_url).toBe('https://webyar.ai/pricing');
    expect(ok.image_url).toBe('https://cdn.webyar.ai/a.png');
    expect(campaignSchema.safeParse({ ...base, text: {}, cta_url: 'http://webyar.ai' }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...base, text: {}, cta_url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('treats null copy as unset', () => {
    const ok = campaignSchema.parse({ ...base, name: null, text: { fa: { title: null, body: 'b' }, en: null } });
    expect(ok.name).toBe('');
    expect(ok.text).toEqual({ fa: { body: 'b' } });
  });

  it('names the rejected field in the error', () => {
    const bad = campaignSchema.safeParse({ ...base, text: { fa: { title: 'x'.repeat(201) } } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(invalidInput(bad.error).error).toContain('text.fa.title');
    const order = campaignSchema.safeParse({ ...base, text: {}, starts_at: '2026-10-02T10:00', ends_at: '2026-10-01T10:00' });
    expect(order.success).toBe(false);
  });

  it('lets the list switch toggle only `active`', () => {
    expect(campaignPatchSchema.parse({ active: false })).toEqual({ active: false });
  });
});

describe('desktop live registry', () => {
  beforeEach(() => __resetLive());

  it('counts running copies without storing anything else', () => {
    heartbeat({ sessionId: 'aaaaaaaa1', userId: 'u1', workspaceId: 'w1', version: '2.0.8', os: null });
    heartbeat({ sessionId: 'aaaaaaaa2', userId: 'u1', workspaceId: 'w1', version: '2.0.7', os: null });
    heartbeat({ sessionId: 'aaaaaaaa3', userId: 'u2', workspaceId: 'w2', version: '2.0.8', os: null });
    const s = summary();
    expect(s.online).toBe(3);
    expect(s.users).toBe(2);
    expect(s.workspaces).toBe(2);
    expect(s.versions[0]).toEqual({ version: '2.0.8', count: 2 });
  });

  it('delivers broadcasts newer than the last seen one, never the backlog on first contact', () => {
    const first = broadcastsAfter(-1);
    expect(first.items).toHaveLength(0);
    addBroadcast({ title: 'T', body: '', severity: 'info', url: null, createdBy: 'admin' });
    const next = broadcastsAfter(first.latest);
    expect(next.items.map((b) => b.title)).toEqual(['T']);
    expect(broadcastsAfter(next.latest).items).toHaveLength(0);
  });
});
