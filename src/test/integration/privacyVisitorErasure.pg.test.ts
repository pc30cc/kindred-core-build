// @vitest-environment node
/**
 * P-02: a GDPR erasure (Art. 17) and export (Art. 15) of a contact cover the
 * visitor tracking data, against a database built by the whole chain and the
 * real data layer (postgres-only: the in-repo PostgREST engine refuses an
 * unknown column with PGRST204, which is what made the old session update
 * fail unnoticed):
 *
 *   E1  the export holds the contact's sessions and, new, their page
 *       history, analytics events, Smart Engagement events and AI nudges,
 *       and nothing of another visitor;
 *   E2  a step that fails fails the job (the summary never counts what was
 *       not done), and a re-run after it converges;
 *   E3  the erasure gives each session a new visitor id and clears its
 *       address (raw and hashed), place, pages, referrer, campaign term and
 *       content and metadata; deletes the page history, analytics events,
 *       AI nudges (their events with them), presence, read markers and the
 *       AI intro log; keeps Smart Engagement events for the rules' counts
 *       without their visitor, session or page; another visitor is left
 *       untouched;
 *   E4  a second run changes nothing and says so.
 *
 * (A store customer link, commerce_customer_links, needs a plugin
 * installation and a store connection; it goes through the same delete and
 * is not built here.)
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import type { PrivacyJobRow } from '../../../server/services/privacy/types';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

suite('P-02: erasing and exporting a contact\'s visits (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let config: never;
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const count = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);

  const ws = randomUUID();
  const sara = randomUUID();
  const other = randomUUID();
  const sessions = [randomUUID(), randomUUID()];
  const otherSession = randomUUID();
  const conversation = randomUUID();
  const rule = randomUUID();
  const nudge = randomUUID();
  let job: PrivacyJobRow;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `privacy_p02_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;

    const owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `owner-${owner.slice(0, 6)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Shop', $2, $3)`, [ws, `shop-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.contacts (id, workspace_id, name, email) VALUES ($1, $2, 'Sara', 'sara@example.com'), ($3, $2, 'Other', 'other@example.com')`, [sara, ws, other]);

    // Sara's two sessions (one visitor id each), and another visitor's.
    const session = (id: string, visitor: string, contact: string, page: string) => q(
      `INSERT INTO public.visitor_sessions (id, workspace_id, visitor_id, contact_id, identity_state, current_page, referrer, browser, device, os,
         country, city, ip_hash, ip_raw, utm_source, utm_term, utm_content, metadata,
         geo_country_code, geo_region, geo_city, geo_latitude, geo_longitude, geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
       VALUES ($1, $2, $3, $4, 'identified', $5, 'https://mail.example/inbox?u=sara', 'Chrome', 'Desktop', 'macOS',
         'DE', 'Berlin', 'hash-' || $3, '203.0.113.7', 'newsletter', 'sara@example.com', 'link-1', '{"note":"x"}'::jsonb,
         'DE', 'Berlin', 'Berlin', 52.52, 13.405, 'Europe/Berlin', 'city', 'test', now())`,
      [id, ws, visitor, contact, page]);
    await session(sessions[0], 'v-sara-1', sara, '/checkout?email=sara@example.com');
    await session(sessions[1], 'v-sara-2', sara, '/account');
    await session(otherSession, 'v-other', other, '/other');

    for (const [sid, url] of [[sessions[0], '/checkout?email=sara@example.com'], [sessions[0], '/cart'], [sessions[1], '/account'], [otherSession, '/other']]) {
      await q(`INSERT INTO public.visitor_page_views (workspace_id, visitor_session_id, url, title) VALUES ($1, $2, $3, 'Page')`, [ws, sid, url]);
    }
    for (const sid of [sessions[0], sessions[1], otherSession]) {
      await q(`INSERT INTO public.web_analytics_events (workspace_id, visitor_session_id, event_name, properties, page_url) VALUES ($1, $2, 'signup', '{}'::jsonb, '/signup')`, [ws, sid]);
      await q(`INSERT INTO public.visitor_presence (workspace_id, visitor_session_id, current_page) VALUES ($1, $2, '/now')`, [ws, sid]);
    }
    await q(`INSERT INTO public.widget_smart_rules (id, workspace_id, name) VALUES ($1, $2, 'Welcome')`, [rule, ws]);
    for (const [visitor, key] of [['v-sara-1', 'k1'], ['v-sara-2', 'k2'], ['v-other', 'k3']]) {
      await q(`INSERT INTO public.widget_smart_events (workspace_id, rule_id, visitor_id, session_id, event_type, page_path, idempotency_key, source)
               VALUES ($1, $2, $3, 'smart-sess', 'shown', '/pricing', $4, 'rule')`, [ws, rule, visitor, key]);
    }
    await q(`INSERT INTO public.widget_ai_nudges (id, workspace_id, visitor_id, session_id, session_key, topic, message, page_path)
             VALUES ($1, $2, 'v-sara-1', 'smart-sess', 'sk-1', 'shipping', 'Need help with shipping, Sara?', '/checkout')`, [nudge, ws]);
    await q(`INSERT INTO public.widget_smart_events (workspace_id, ai_nudge_id, visitor_id, event_type, idempotency_key, source)
             VALUES ($1, $2, 'v-sara-1', 'shown', 'k-ai', 'ai_proactive')`, [ws, nudge]);
    await q(`INSERT INTO public.conversations (id, workspace_id, contact_id, visitor_session_id) VALUES ($1, $2, $3, $4)`, [conversation, ws, sara, sessions[0]]);
    await q(`INSERT INTO public.widget_conversation_reads (workspace_id, conversation_id, visitor_id) VALUES ($1, $2, 'v-sara-1')`, [ws, conversation]);
    await q(`INSERT INTO public.ai_agent_intro_log (workspace_id, conversation_id, visitor_session_id, visitor_id) VALUES ($1, $2, $3, 'v-sara-1')`, [ws, conversation, sessions[0]]);

    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    const { resolveSubject } = await import('../../../server/services/privacy/identity.js');
    const resolved = await resolveSubject(config, ws, 'contact', sara);
    expect([...resolved.visitor_ids].sort()).toEqual(['v-sara-1', 'v-sara-2']);
    job = {
      id: randomUUID(), workspace_id: ws, actor_user_id: owner, subject_type: 'contact', subject_id: sara,
      subject_email_hash: null, resolved_identity: resolved, action: 'delete', status: 'running', scope: {},
      artifact_path: null, artifact_hash: null, artifact_size_bytes: null, download_count: 0, download_token_hash: null,
      expires_at: null, error_message: null, requested_at: new Date().toISOString(), started_at: null, completed_at: null, cancelled_at: null,
    };
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('E1 the export holds the sessions and what was done in them, nothing of another visitor', async () => {
    const { buildExportZip } = await import('../../../server/services/privacy/exporter.js');
    const { buffer, manifestSummary } = await buildExportZip(config, { ...job, action: 'export' });
    expect(manifestSummary).toMatchObject({
      visitor_sessions: 2, page_views: 3, analytics_events: 2, smart_events: 3, ai_nudges: 1, store_links: 0, conversations: 1,
    });
    // A store-only zip: the JSON is in the bytes as written.
    const text = buffer.toString('utf8');
    expect(text).toContain('page_views.json');
    expect(text).toContain('/checkout?email=sara@example.com');
    expect(text).toContain('Need help with shipping, Sara?');
    expect(text).not.toContain('/other');
    expect(text).not.toContain('v-other');
  });

  it('E2 a step that fails fails the job; a re-run converges', async () => {
    const { runAnonymize } = await import('../../../server/services/privacy/anonymizer.js');
    await q('ALTER TABLE public.web_analytics_events RENAME COLUMN visitor_session_id TO visitor_session_id_hidden');
    try {
      await expect(runAnonymize(config, job)).rejects.toThrow(/deleting analytics events failed/);
    } finally {
      await q('ALTER TABLE public.web_analytics_events RENAME COLUMN visitor_session_id_hidden TO visitor_session_id');
    }
    // Nothing past the failed step was done: the sessions still carry Sara.
    expect(await count(`SELECT count(*) AS n FROM public.visitor_sessions WHERE id = ANY($1) AND ip_raw IS NOT NULL`, [sessions])).toBe(2);
    // The steps before it were (the page views of her sessions).
    expect(await count(`SELECT count(*) AS n FROM public.visitor_page_views WHERE visitor_session_id = ANY($1)`, [sessions])).toBe(0);
  });

  it('E3 the erasure: every session anonymized, the visits deleted, another visitor untouched', async () => {
    const { runAnonymize } = await import('../../../server/services/privacy/anonymizer.js');
    const summary = await runAnonymize(config, job);
    expect(summary).toMatchObject({
      // The conversation's unlinking and the page views (the steps before the
      // one that failed) were done by the failed run of E2: each step
      // converges, and counts only what it did.
      conversations_anonymized: 0,
      page_views_deleted: 0,
      visitor_sessions_anonymized: 2,
      contacts_anonymized: 1,
      analytics_events_deleted: 2,
      smart_events_anonymized: 2,
      ai_nudges_deleted: 1,
      // Presence (2), the read marker and the AI intro log.
      visitor_links_deleted: 4,
    });

    const rows = await q(`SELECT * FROM public.visitor_sessions WHERE id = ANY($1) ORDER BY id`, [sessions]);
    for (const s of rows) {
      expect(String(s.visitor_id)).toMatch(/^anon_[0-9a-f]{24}$/);
      expect(s).toMatchObject({
        contact_id: null, identity_state: 'anonymous', current_page: null, referrer: null, ip_hash: null, ip_raw: null,
        city: null, geo_city: null, geo_region: null, geo_latitude: null, geo_longitude: null, geo_timezone: null,
        geo_accuracy_level: null, geo_source_provider: null, geo_resolved_at: null, utm_term: null, utm_content: null, metadata: {},
      });
      // What counts visits without naming anyone stays.
      expect(s).toMatchObject({ browser: 'Chrome', device: 'Desktop', country: 'DE', utm_source: 'newsletter' });
    }
    expect(await count(`SELECT count(*) AS n FROM public.visitor_page_views WHERE visitor_session_id = ANY($1)`, [sessions])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.web_analytics_events WHERE visitor_session_id = ANY($1)`, [sessions])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.visitor_presence WHERE visitor_session_id = ANY($1)`, [sessions])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.widget_ai_nudges WHERE id = $1`, [nudge])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.widget_smart_events WHERE idempotency_key = 'k-ai'`)).toBe(0);
    expect(await q(`SELECT visitor_id, session_id, page_path FROM public.widget_smart_events WHERE idempotency_key IN ('k1', 'k2')`))
      .toEqual([{ visitor_id: null, session_id: null, page_path: null }, { visitor_id: null, session_id: null, page_path: null }]);
    expect(await count(`SELECT count(*) AS n FROM public.widget_conversation_reads WHERE visitor_id LIKE 'v-sara-%'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.ai_agent_intro_log WHERE visitor_id LIKE 'v-sara-%' OR visitor_session_id = ANY($1)`, [sessions])).toBe(0);
    expect(await q(`SELECT contact_id FROM public.conversations WHERE id = $1`, [conversation])).toEqual([{ contact_id: null }]);
    expect(await q(`SELECT email, name FROM public.contacts WHERE id = $1`, [sara])).toEqual([{ email: null, name: expect.not.stringMatching(/Sara/) }]);

    // The other visitor keeps everything.
    expect(await q(`SELECT visitor_id, ip_raw, current_page FROM public.visitor_sessions WHERE id = $1`, [otherSession]))
      .toEqual([{ visitor_id: 'v-other', ip_raw: '203.0.113.7', current_page: '/other' }]);
    expect(await count(`SELECT count(*) AS n FROM public.visitor_page_views WHERE visitor_session_id = $1`, [otherSession])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM public.web_analytics_events WHERE visitor_session_id = $1`, [otherSession])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM public.visitor_presence WHERE visitor_session_id = $1`, [otherSession])).toBe(1);
    expect(await q(`SELECT visitor_id FROM public.widget_smart_events WHERE idempotency_key = 'k3'`)).toEqual([{ visitor_id: 'v-other' }]);
  });

  it('E4 a second run changes nothing and says so', async () => {
    const { runAnonymize } = await import('../../../server/services/privacy/anonymizer.js');
    const again = await runAnonymize(config, job);
    expect(again).toMatchObject({
      visitor_sessions_anonymized: 0, page_views_deleted: 0, analytics_events_deleted: 0, smart_events_anonymized: 0,
      ai_nudges_deleted: 0, visitor_links_deleted: 0, conversations_anonymized: 0,
    });
  });
});
